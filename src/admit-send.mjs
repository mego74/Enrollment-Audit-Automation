import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { parse as parseCsv } from "csv-parse/sync";
import { createWorker } from "tesseract.js";
import { chromium } from "playwright-core";
const FINAL_QUEUE_STATUS = "FOT and POD are satisfied - Enrollment Audit Complete";
const AUDIT_DONE_MARK = "✓";
const TRANSCRIPT_TITLE_EXACT = "Final Official Transcript";
const DEGREE_STATUS_FINAL_LABEL = "Degree Awarded (Final Official Document)";
const SCREENSHOT_DIRNAME = "reports";
const TERM_TAB_PATTERN = /\b(Fall|Spring|Summer|Winter)\b.*\b(20)?\d{2}\b/i;
const ELIGIBLE_APP_STATUSES = new Set([
  FINAL_QUEUE_STATUS,
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const browserProfileDir = path.join(projectRoot, ".browser-profile");
const reportsDir = path.join(projectRoot, SCREENSHOT_DIRNAME);
let ocrWorkerPromise = null;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(browserProfileDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  let sheetInfo = options.sheetUrl ? parseSheetUrl(options.sheetUrl) : null;
  const slateSearchUrl = options.slateSearchUrl ?? "https://apply.engineering.nyu.edu/manage/lookup/search";

  if (!options.nNumber && !options.sheetUrl) {
    throw new Error("Pass either --n-number or --sheet-url.");
  }

  console.log(`Using ${options.browser} with a reusable browser profile in ${browserProfileDir}`);
  await ensureBrowserLaunched(options.browser, options.port);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const initialPages = new Set(context.pages());

  const slatePage = await createSlatePage(context, slateSearchUrl);
  const sheetPage = sheetInfo ? await context.newPage() : null;

  if (sheetPage && sheetInfo) {
    await sheetPage.goto(sheetInfo.rawUrl, { waitUntil: "domcontentloaded" });
  }

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("");
    console.log("If Google Sheets or Slate asks you to log in, do that in the opened browser window now.");
    console.log("Use this browser profile for future runs so your session stays saved.");
    await terminal.question("Press Enter here when both pages are ready... ");

    if (sheetPage && sheetInfo) {
      sheetInfo = await resolveSheetInfo(sheetPage, sheetInfo, options);
      console.log(`Using Google Sheet gid ${sheetInfo.gid}`);
    }

    const targets = options.nNumber
      ? [{ rowNumber: null, nNumber: options.nNumber, originalStatus: "" }]
      : planRows(await fetchSheetRows(sheetPage, sheetInfo, options), options);

    if (targets.length === 0) {
      console.log("No applicants matched the current filters.");
      return;
    }

    console.log("");
    console.log(`Found ${targets.length} applicant(s) ready for the final Reader send step.`);
    if (!options.save) {
      console.log("Dry run is enabled, so no Reader queue/send actions will be committed.");
    }

    const runResults = [];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const label = target.rowNumber ? `row ${target.rowNumber}` : "manual target";
      console.log(`[${index + 1}/${targets.length}] Syncing ${label} (${target.nNumber})`);

      try {
        const result = await sendApplicantToAdmit({
          context,
          slatePage,
          slateSearchUrl,
          nNumber: target.nNumber,
          save: options.save,
        });

        if (options.save && result.sent && sheetPage && sheetInfo && target.rowNumber) {
          const marked = await withTimeout(
            () => writeAuditMarkToSheet(sheetPage, sheetInfo, options, target.rowNumber, target.nNumber),
            12_000,
            false,
          );
          result.actions.push(marked
            ? `Marked ${options.auditColumn}${target.rowNumber} with ${AUDIT_DONE_MARK}`
            : `Could not mark ${options.auditColumn}${target.rowNumber}`);
        }

        runResults.push({
          rowNumber: target.rowNumber,
          nNumber: target.nNumber,
          ...result,
          error: null,
        });

        const actionSummary = result.actions.length > 0
          ? result.actions.join(" | ")
          : "Ready to send to Admit (current).";
        const modeLabel = options.save
          ? (result.sent ? "Sent" : (result.queued ? "Queued" : "Not sent"))
          : "Preview";
        console.log(`  -> ${result.applicantLabel} [${modeLabel}] ${actionSummary}`);
      } catch (error) {
        const screenshotPath = await captureErrorScreenshot(slatePage, `transcript-sync-${target.nNumber}`);
        runResults.push({
          rowNumber: target.rowNumber,
          nNumber: target.nNumber,
          materials: [],
          error: error instanceof Error ? error.message : String(error),
          screenshotPath,
        });
        console.log(`  -> Manual review needed (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    const reportPath = await writeRunReport(runResults, options, sheetInfo);
    console.log("");
    console.log(`Saved admit-send report to ${reportPath}`);
  } finally {
    terminal.close();
    await Promise.allSettled([
      slatePage?.close(),
      sheetPage?.close(),
    ]);
    await closePagesCreatedDuringRun(context, initialPages);
    await browser.close().catch(() => {});
  }
}

async function closePagesCreatedDuringRun(context, initialPages) {
  const pagesToClose = context.pages().filter((page) => !initialPages.has(page));
  await Promise.allSettled(
    pagesToClose.map(async (page) => {
      if (!page.isClosed()) {
        await page.close().catch(() => {});
      }
    }),
  );
}

async function sendApplicantToAdmit({ context, slatePage, slateSearchUrl, nNumber, save }) {
  const record = await openApplicantRecord(slatePage, slateSearchUrl, nNumber);
  const readInfo = await withStage("open Read Application / Graduate Reader", () => getReadApplicationInfo(slatePage));
  const readerPage = await context.newPage();

  try {
    await withStage("open Slate Reader", () => openReaderPage(readerPage, readInfo.readerUrl));
    const applicantLabel = await getReaderApplicantLabel(readerPage);
    const actions = [];

    await withStage("add to queue", () => ensureApplicantQueued(readerPage, save, actions));
    await withStage("open Review Form / Send to Bin", () => openReviewFormSendToBin(readerPage, save, actions));
    await withStage("set proof/bin fields", () => ensureSendPanelSelections(readerPage, save, actions));

    const queued = save
      ? actions.includes("Added to queue") || actions.includes("Already in queue")
      : actions.includes("Would add to queue") || actions.includes("Already in queue");
    let sent = false;
    if (save) {
      sent = await withStage("send to Admit (current)", () => submitSendToBin(readerPage, actions));
    }

    return {
      recordId: record.recordId,
      applicationId: readInfo.applicationId,
      applicantLabel,
      actions,
      queued,
      sent,
    };
  } finally {
    await readerPage.close().catch(() => {});
  }
}

async function withStage(stageLabel, operation) {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${stageLabel}: ${message}`);
  }
}

async function withTimeout(operation, timeoutMs, fallbackValue = false) {
  return Promise.race([
    Promise.resolve().then(operation),
    delay(timeoutMs).then(() => fallbackValue),
  ]).catch(() => fallbackValue);
}

async function getReaderApplicantLabel(readerPage) {
  const text = await readerPage.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const match = bodyText.match(/\b\d{7,}\s+([^\n]+)/);
    return match?.[0] || match?.[1] || "";
  }).catch(() => "");
  return normalizeSpace(text) || "Applicant";
}

async function ensureApplicantQueued(readerPage, save, actions) {
  const alreadyQueued = await hasReaderControlText(readerPage, /Remove from Queue/i);
  if (alreadyQueued) {
    actions.push("Already in queue");
    return;
  }

  if (!(await hasReaderControlText(readerPage, /Add to Queue/i))) {
    throw new Error('Could not find the "Add to Queue" button in Slate Reader.');
  }

  if (!save) {
    actions.push("Would add to queue");
    return;
  }

  await scrollReaderActionAreaIntoView(readerPage);
  await enableReaderQueueAutoConfirm(readerPage);

  await clickReaderNamedButton(readerPage, "Add to Queue");

  await waitForReaderQueuedState(readerPage);

  actions.push("Added to queue");
}

async function openReviewFormSendToBin(readerPage, save, actions) {
  if (await isReviewPanelVisible(readerPage)) {
    return;
  }

  if (!save) {
    actions.push("Would open review form");
    return;
  }

  if (!(await hasReaderControlText(readerPage, /Review Form \/ Send to Bin/i))) {
    throw new Error('Could not find the "Review Form / Send to Bin" control in Slate Reader.');
  }

  await scrollReaderActionAreaIntoView(readerPage);
  await clickReaderNamedButton(readerPage, "Review Form / Send to Bin");
  await waitForReviewPanel(readerPage);
  actions.push("Opened review form");
}

async function ensureSendPanelSelections(readerPage, save, actions) {
  const panelVisible = await isReviewPanelVisible(readerPage);
  if (!panelVisible && !save) {
    if (!actions.includes("Would open review form")) {
      actions.push("Would open review form");
    }
    actions.push("Would set POD verified to Yes");
    actions.push("Would set Next Bin to Admit (current)");
    return;
  }

  await waitForReviewPanel(readerPage);

  const currentValues = await readerPage.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const sidebar = Array.from(document.querySelectorAll("body *"))
      .find((element) => (element.textContent || "").includes("Is the Proof of Degree verified?")
        && (element.textContent || "").includes("Next Bin (required)")
        && Array.from(element.querySelectorAll("select")).filter(isVisible).length >= 2);
    if (!(sidebar instanceof HTMLElement)) {
      return { proofText: "", nextBinText: "" };
    }
    const selects = Array.from(sidebar.querySelectorAll("select")).filter(isVisible);
    const proofText = selects[0]?.selectedOptions?.[0]?.textContent?.trim() || "";
    const nextBinText = selects[1]?.selectedOptions?.[0]?.textContent?.trim() || "";
    return { proofText, nextBinText };
  });

  if (normalizeSpace(currentValues.proofText) !== "Yes") {
    if (save) {
      await setReviewPanelSelect(readerPage, "Is the Proof of Degree verified?", "Yes");
      actions.push("Set POD verified to Yes");
    } else {
      actions.push("Would set POD verified to Yes");
    }
  }

  if (normalizeSpace(currentValues.nextBinText) !== "Admit (current)") {
    if (save) {
      await setReviewPanelSelect(readerPage, "Next Bin (required)", "Admit (current)");
      actions.push("Set Next Bin to Admit (current)");
    } else {
      actions.push("Would set Next Bin to Admit (current)");
    }
  }
}

async function submitSendToBin(readerPage, actions) {
  await scrollReaderActionAreaIntoView(readerPage);
  await clickReaderNamedButton(readerPage, "Send");
  await delay(3_000);
  actions.push("Sent to Admit (current)");
  return true;
}

async function waitForReaderQueuedState(readerPage) {
  await readerPage.waitForFunction(() => {
    const textOf = (element) => (element?.textContent || element?.getAttribute?.("value") || "").replace(/\s+/g, " ").trim();
    const controls = Array.from(document.querySelectorAll("button, input[type='submit'], a, div"));
    const hasRemove = controls.some((element) => /Remove from Queue/i.test(textOf(element)));
    const hasReview = controls.some((element) => /Review Form \/ Send to Bin/i.test(textOf(element)));
    const bodyText = document.body?.innerText || "";
    const hasProofQuestion = bodyText.includes("Is the Proof of Degree verified?");
    return hasRemove || hasReview || hasProofQuestion;
  }, { timeout: 15_000 });
}

async function isReviewPanelVisible(readerPage) {
  return readerPage.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    return bodyText.includes("Is the Proof of Degree verified?") && bodyText.includes("Next Bin (required)");
  }).catch(() => false);
}

async function waitForReviewPanel(readerPage) {
  await readerPage.waitForFunction(() => {
    const bodyText = document.body?.innerText || "";
    return bodyText.includes("Is the Proof of Degree verified?") && bodyText.includes("Next Bin (required)");
  }, { timeout: 20_000 });
}

async function scrollReaderActionAreaIntoView(readerPage) {
  await readerPage.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  }).catch(() => {});
  await delay(400);
}

async function hasReaderControlText(readerPage, textPattern) {
  return readerPage.evaluate((patternSource) => {
    const matcher = new RegExp(patternSource, "i");
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], a, div, span"))
      .filter(isVisible);
    return candidates.some((element) => matcher.test((element.textContent || element.getAttribute("value") || "").trim()));
  }, textPattern.source).catch(() => false);
}

async function clickReaderNamedButton(readerPage, label) {
  const preferredSelectors = {
    "Add to Queue": ".reader_queue_add",
    "Remove from Queue": ".reader_queue_manage",
    "Review Form / Send to Bin": ".reader_send",
  };

  const preferredSelector = preferredSelectors[label];
  if (preferredSelector) {
    const preferred = readerPage.locator(preferredSelector).first();
    if (await preferred.isVisible().catch(() => false)) {
      await preferred.scrollIntoViewIfNeeded().catch(() => {});
      await preferred.click({ timeout: 10_000, force: true });
      return;
    }
  }

  const byText = readerPage.getByText(label, { exact: true }).first();
  if (await byText.isVisible().catch(() => false)) {
    try {
      await byText.scrollIntoViewIfNeeded().catch(() => {});
      await byText.click({ timeout: 10_000, force: true });
      return;
    } catch {
      // Fall through to DOM click fallback below.
    }
  }

  const clicked = await readerPage.evaluate((targetLabel) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], a, div, span"))
      .filter(isVisible);
    const target = candidates.find((element) => normalize(element.textContent || element.getAttribute("value") || "") === targetLabel);
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    target.click();
    return true;
  }, label);

  if (!clicked) {
    throw new Error(`Could not activate Reader control "${label}".`);
  }
}

async function enableReaderQueueAutoConfirm(readerPage) {
  await readerPage.evaluate(() => {
    window.confirm = () => true;
    window.alert = () => {};
  });
}

async function setReviewPanelSelect(readerPage, labelText, optionText) {
  const changed = await readerPage.evaluate(({ targetLabel, desiredOption }) => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") !== 0
        && rect.width > 0
        && rect.height > 0;
    };
    const panel = Array.from(document.querySelectorAll("body *"))
      .find((element) => (element.textContent || "").includes("Is the Proof of Degree verified?")
        && (element.textContent || "").includes("Next Bin (required)")
        && Array.from(element.querySelectorAll("select")).filter(isVisible).length >= 2);
    if (!(panel instanceof HTMLElement)) {
      return false;
    }
    const selects = Array.from(panel.querySelectorAll("select")).filter(isVisible);
    const select = /Proof of Degree verified/i.test(targetLabel) ? selects[0] : selects[1];
    if (!(select instanceof HTMLSelectElement)) {
      return false;
    }
    const option = Array.from(select.options).find((candidate) => candidate.text.trim() === desiredOption);
    if (!option) {
      return false;
    }
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { targetLabel: labelText, desiredOption: optionText });

  if (!changed) {
    throw new Error(`Could not set "${labelText}" to "${optionText}".`);
  }
}

async function clickReaderControl(readerPage, locator, textPattern) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 10_000, force: true });
    return;
  } catch {
    const clicked = await readerPage.evaluate((patternSource) => {
      const matcher = new RegExp(patternSource, "i");
      const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], a, div"));
      const target = candidates.find((element) => matcher.test((element.textContent || element.getAttribute("value") || "").trim()));
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      target.click();
      return true;
    }, textPattern.source);

    if (!clicked) {
      throw new Error(`Could not activate Reader control matching ${textPattern}.`);
    }
  }
}

async function loadReaderTranscriptData(readerPage, readInfo) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await openReaderPage(readerPage, readInfo.readerUrl);
      const readerInit = await fetchReaderInitWithRetry(readerPage, readInfo.applicationId, readInfo.workflowId);
      const transcriptStream = readerInit.streams.find((stream) => normalizeSpace(stream.text) === "Transcripts");
      if (!transcriptStream) {
        throw new Error("Could not find the Transcripts stream in Graduate Reader.");
      }
      const academicCredentialsStream = readerInit.streams.find((stream) => /Academic Credentials/i.test(normalizeSpace(stream.text)));
      const transcriptPages = await fetchReaderStreamPagesWithRetry(readerPage, transcriptStream.id);
      const finalMaterials = collectFinalOfficialMaterials(transcriptPages);
      const streamText = await tryFetchReaderStreamText(readerPage, transcriptStream.id);
      const academicCredentials = academicCredentialsStream
        ? await extractAcademicCredentialsMetadata(readerPage, academicCredentialsStream.id)
        : null;

      return {
        finalMaterials,
        streamText,
        transcriptStreamId: transcriptStream.id,
        academicCredentials,
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = /status 410|status 404|ERR_ABORTED/i.test(message);
      if (!shouldRetry || attempt === 2) {
        break;
      }
      await delay(1_500);
    }
  }

  throw lastError;
}

async function openReaderPage(readerPage, readerUrl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await readerPage.goto(readerUrl, { waitUntil: "domcontentloaded" });
      await readerPage.waitForLoadState("domcontentloaded").catch(() => {});
      await waitForReaderApplicantView(readerPage);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const onReaderPage = readerPage.url().includes("/manage/reader/");
      if (message.includes("ERR_ABORTED") && onReaderPage) {
        await waitForReaderApplicantView(readerPage);
        return;
      }
      if (attempt === 2) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

async function waitForReaderApplicantView(readerPage) {
  await readerPage.waitForFunction(() => {
    const bodyText = document.body?.innerText || "";
    const hasApplicantHeader = /\b\d{7,}\s+[^\n]+/.test(bodyText);
    const hasReaderFooterState =
      bodyText.includes("Displaying Copy")
      || bodyText.includes("Add to Queue")
      || bodyText.includes("Remove from Queue")
      || bodyText.includes("Review Form / Send to Bin");
    const stillOnDashboard =
      bodyText.includes("Faculty Deadlines")
      || bodyText.includes("Faculty Reader Training Materials");
    return hasApplicantHeader && hasReaderFooterState && !stillOnDashboard;
  }, { timeout: 20_000 });

  await delay(500);
}

async function openApplicantRecord(slatePage, slateSearchUrl, nNumber) {
  await slatePage.goto(slateSearchUrl, { waitUntil: "domcontentloaded" });
  await slatePage.waitForLoadState("networkidle").catch(() => {});

  const searchInput = slatePage.locator("#search_quick").or(
    slatePage.locator('xpath=//*[normalize-space()="Partial Match"]/following::input[not(@type="hidden")][1]'),
  ).first();
  await searchInput.waitFor({ timeout: 15_000 });
  await searchInput.fill("");
  await searchInput.fill(nNumber);
  await slatePage.keyboard.press("Enter");

  const resultLink = slatePage.locator('table.table tbody tr td a[href*="/manage/lookup/?id="]').first();
  await resultLink.waitFor({ timeout: 15_000 });
  await resultLink.click({ noWaitAfter: true });
  await slatePage.waitForURL(/\/manage\/lookup\/record\?id=/, { timeout: 15_000 }).catch(() => {});
  await slatePage.waitForLoadState("domcontentloaded");
  await openApplicationTab(slatePage);

  const recordId = extractRecordIdFromUrl(slatePage.url());
  if (!recordId) {
    throw new Error(`Could not determine the Slate record id for ${nNumber}.`);
  }

  return {
    recordId,
    nNumber,
  };
}

function extractRecordIdFromUrl(url) {
  return new URL(url).searchParams.get("id");
}

async function getReadApplicationInfo(slatePage) {
  const info = await slatePage.evaluate(async () => {
    const readLink = Array.from(document.querySelectorAll("a"))
      .find((link) => /Read Application/i.test((link.textContent || "").trim()));

    if (!readLink) {
      return null;
    }

    const popupPath = readLink.getAttribute("data-href") || readLink.getAttribute("href");
    if (!popupPath) {
      return null;
    }

    const response = await fetch(popupPath, { credentials: "include" });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const workflowSelect = doc.querySelector("#workflow");
    const workflows = workflowSelect
      ? Array.from(workflowSelect.querySelectorAll("option"))
        .map((option) => ({
          value: option.getAttribute("value") || "",
          text: (option.textContent || "").replace(/\s+/g, " ").trim(),
        }))
        .filter((option) => option.value)
      : [];
    const graduateReader = workflows.find((option) => /Graduate Reader/i.test(option.text));
    const popupUrl = new URL(popupPath, window.location.href);
    const applicationId = doc.querySelector("#record")?.getAttribute("value")
      || doc.querySelector("#record")?.value
      || popupUrl.searchParams.get("id");

    return {
      applicationId,
      workflowId: graduateReader?.value || null,
      workflowText: graduateReader?.text || null,
      popupPath,
      origin: window.location.origin,
    };
  });

  if (!info?.applicationId) {
    throw new Error("Could not determine the application id for Read Application.");
  }

  if (!info.workflowId) {
    throw new Error("Could not find the Graduate Reader workflow in Read Application.");
  }

  return {
    ...info,
    readerUrl: `${info.origin}/manage/reader/?id=${encodeURIComponent(info.applicationId)}&b=${encodeURIComponent(info.workflowId)}`,
  };
}

async function fetchReaderInit(readerPage, applicationId, workflowId) {
  return readerPage.evaluate(async ({ appId, workflowBase }) => {
    const response = await fetch(`/manage/reader/?cmd=init&id=${encodeURIComponent(appId)}&base=${encodeURIComponent(workflowBase)}`, {
      credentials: "include",
    });
    const xmlText = await response.text();
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const streams = Array.from(doc.querySelectorAll("stream")).map((stream) => ({
      id: stream.getAttribute("id"),
      text: (stream.getAttribute("text") || stream.textContent || "").replace(/\s+/g, " ").trim(),
      type: stream.getAttribute("type") || "",
    }));
    return { streams };
  }, { appId: applicationId, workflowBase: workflowId });
}

async function fetchReaderInitWithRetry(readerPage, applicationId, workflowId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const init = await fetchReaderInit(readerPage, applicationId, workflowId);
    if (Array.isArray(init.streams) && init.streams.length > 0) {
      return init;
    }
    await delay(1_000);
  }

  throw new Error("Could not initialize Graduate Reader streams.");
}

async function fetchReaderStreamPages(readerPage, streamId) {
  return readerPage.evaluate(async (id) => {
    const response = await fetch(`/manage/reader/?cmd=init2&id=${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    const xmlText = await response.text();
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    return Array.from(doc.querySelectorAll("page")).map((page, index) => ({
      index,
      id: page.getAttribute("id"),
      title: page.getAttribute("title") || "",
      materialId: page.getAttribute("materialId") || "",
      contentId: page.getAttribute("contentId") || "",
    }));
  }, streamId);
}

async function fetchReaderStreamPagesWithRetry(readerPage, streamId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pages = await fetchReaderStreamPages(readerPage, streamId);
    if (pages.length > 0) {
      return pages;
    }
    await delay(1_000);
  }

  throw new Error("Could not load Reader transcript pages.");
}

function collectFinalOfficialMaterials(pages) {
  const byMaterial = new Map();

  for (const page of pages) {
    if (normalizeSpace(page.title) !== TRANSCRIPT_TITLE_EXACT) {
      continue;
    }

    if (!page.materialId) {
      continue;
    }

    if (!byMaterial.has(page.materialId)) {
      byMaterial.set(page.materialId, {
        materialId: page.materialId,
        pageIndexes: [],
      });
    }

    byMaterial.get(page.materialId).pageIndexes.push(page.index);
  }

  return Array.from(byMaterial.values());
}

async function fetchReaderStreamText(readerPage, streamId) {
  const response = await readerPage.evaluate(async (id) => {
    const res = await fetch(`/manage/reader/?cmd=text&id=${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    return {
      ok: res.ok,
      status: res.status,
      text: await res.text(),
    };
  }, streamId);

  if (!response.ok) {
    throw new Error(`Could not load Reader transcript text (status ${response.status}).`);
  }

  return JSON.parse(response.text);
}

async function tryFetchReaderStreamText(readerPage, streamId) {
  try {
    return await fetchReaderStreamText(readerPage, streamId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/status 410/i.test(message)) {
      throw error;
    }
    return null;
  }
}

function selectDataItemsToText(items) {
  const yThreshold = 2;
  const spaceThreshold = 6;
  const lines = [];

  for (const item of items) {
    const [y, x, w, , , text] = item;
    let group = lines.find((line) => Math.abs(line.y - y) <= yThreshold);
    if (!group) {
      group = { y, items: [] };
      lines.push(group);
    }
    group.items.push({ x, w, text });
  }

  return lines
    .sort((a, b) => a.y - b.y)
    .map((line) => {
      const parts = [];
      const sorted = line.items.sort((a, b) => a.x - b.x);
      for (let index = 0; index < sorted.length; index += 1) {
        const { x, text } = sorted[index];
        if (index > 0) {
          const prev = sorted[index - 1];
          const gap = x - (prev.x + prev.w);
          if (gap > spaceThreshold && !text.startsWith(" ")) {
            parts.push(" ");
          }
        }
        parts.push(text);
      }
      return parts.join("").trimEnd();
    })
    .join("\n");
}

async function buildTranscriptTextFromRenderedPages(readerPage, streamId, pageIndexes) {
  const origin = new URL(readerPage.url()).origin;
  const pagesToRead = pageIndexes.slice(0, 4);
  const texts = [];

  for (const pageIndex of pagesToRead) {
    const imageUrl = makeReaderRenderedPageUrl(origin, streamId, pageIndex);
    const text = await recognizeImageText(imageUrl);
    if (normalizeSpace(text)) {
      texts.push(text);
    }
  }

  const transcriptText = texts.join("\n\n");
  if (!normalizeSpace(transcriptText)) {
    throw new Error("Slate Reader text was unavailable and OCR fallback could not read the transcript pages.");
  }

  return transcriptText;
}

function makeReaderRenderedPageUrl(origin, streamId, pageIndex) {
  const fallback = `${origin}/manage/reader/?cmd=tile&id=${encodeURIComponent(streamId)}&pg=${encodeURIComponent(pageIndex)}&z=144`;
  return `https://api.cdn.technolutions.net/pdf/render?id=${encodeURIComponent(streamId)}&pg=${encodeURIComponent(pageIndex)}&z=144&fallback=${encodeURIComponent(fallback)}`;
}

async function recognizeImageText(imageUrl) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(imageUrl);
  return data?.text || "";
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("eng");
  }
  return ocrWorkerPromise;
}

async function closeOcrWorker() {
  if (!ocrWorkerPromise) {
    return;
  }

  const workerPromise = ocrWorkerPromise;
  ocrWorkerPromise = null;
  const worker = await workerPromise;
  await worker.terminate().catch(() => {});
}

async function fetchEditableContext(readerPage, materialId, applicationId) {
  return readerPage.evaluate(async ({ id, appId }) => {
    const response = await fetch(`/manage/database/acquire?cmd=edit&id=${encodeURIComponent(id)}&context=reader&application=${encodeURIComponent(appId)}`, {
      credentials: "include",
    });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ids = [
      "batch_id",
      "batch_stream",
      "batch_edit_mode",
      "batch_record",
      "batch_application",
      "batch_key",
      "batch_initial_record",
      "batch_initial_record2",
      "batch_initial_key",
    ];
    const payload = Object.fromEntries(ids.map((fieldId) => {
      const element = doc.querySelector(`#${fieldId}`);
      return [fieldId, element?.getAttribute("value") || element?.value || ""];
    }));
    return {
      materialId: payload.batch_id,
      stream: payload.batch_stream,
      editMode: payload.batch_edit_mode,
      record: payload.batch_record,
      application: payload.batch_application,
      key: payload.batch_key,
      initialRecord: payload.batch_initial_record,
      initialRecord2: payload.batch_initial_record2,
      initialKey: payload.batch_initial_key,
    };
  }, { id: materialId, appId: applicationId });
}

async function fetchFormIdForMaterial(readerPage, initialRecordId, schoolRecordId, key) {
  const formId = await readerPage.evaluate(async ({ recordId, record2, desiredKey }) => {
    const response = await fetch(`/manage/database/acquire?cmd=select&id=${encodeURIComponent(recordId)}&dataset=`, {
      credentials: "include",
    });
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const scopedSelect = doc.querySelector(`#batch_key_select_${record2}`);
    const option = scopedSelect
      ? Array.from(scopedSelect.querySelectorAll("option")).find((candidate) => candidate.getAttribute("value") === desiredKey)
      : null;
    return option?.getAttribute("data-form") || "";
  }, { recordId: initialRecordId, record2: schoolRecordId, desiredKey: key });

  if (!formId) {
    throw new Error("Could not determine the editable transcript form id.");
  }

  return formId;
}

async function fetchMaterialForm(readerPage, initialRecordId, formId, materialId, schoolRecordId) {
  const form = await readerPage.evaluate(async ({ recordId, formGuid, materialGuid, record2 }) => {
    const response = await fetch(
      `/manage/database/acquire?cmd=form&record=${encodeURIComponent(recordId)}&form=${encodeURIComponent(formGuid)}&id=${encodeURIComponent(materialGuid)}&record2=${encodeURIComponent(record2)}`,
      { credentials: "include" },
    );
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const formElement = doc.querySelector("#batch_metadata");
    const fields = Array.from(doc.querySelectorAll(".form_question"))
      .map((question) => {
        const label = question.querySelector(".form_label")?.textContent?.replace(/\s+/g, " ").trim() || "";
        const input = question.querySelector("input, select, textarea");
        if (!input || !label) {
          return null;
        }

        const kind = input.tagName.toLowerCase();
        const options = kind === "select"
          ? Array.from(input.querySelectorAll("option")).map((option) => ({
            value: option.getAttribute("value") || "",
            text: (option.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          : [];
        const selectedText = kind === "select"
          ? input.selectedOptions?.[0]?.textContent?.replace(/\s+/g, " ").trim() || ""
          : "";

        return {
          label,
          name: input.getAttribute("name") || "",
          kind,
          exportKey: question.getAttribute("data-export") || "",
          value: input.value || "",
          selectedText,
          displayValue: kind === "select" ? selectedText : (input.value || ""),
          options,
        };
      })
      .filter(Boolean);

    return {
      formId: formElement?.querySelector('input[name="form"]')?.getAttribute("value") || "",
      fields,
    };
  }, { recordId: initialRecordId, formGuid: formId, materialGuid: materialId, record2: schoolRecordId });

  const fieldMap = new Map(form.fields.map((field) => [field.label, field]));
  return {
    ...form,
    fieldMap,
  };
}

async function extractTranscriptMetadata(readerPage, transcriptText, form, academicCredentials) {
  const currentSchoolName = form.fieldMap.get("School Name *")?.displayValue || "";
  const schoolNameCandidate = extractSchoolNameCandidate(transcriptText, currentSchoolName);
  const transcriptSchoolLookup = schoolNameCandidate
    ? await lookupSchool(readerPage, schoolNameCandidate)
    : null;
  const transcriptCountryCode = transcriptSchoolLookup?.country || "";
  const shouldUseAcademicCredentials = isNonUsCanadaCountryCode(
    academicCredentials?.countryCode
    || transcriptCountryCode
    || countryNameToCode(form.fieldMap.get("Country")?.displayValue || ""),
  );

  const degreeBlock = extractDegreeBlock(transcriptText);
  const transcriptDegreeDetails = inferDegreeAndMajor(degreeBlock, form.fieldMap.get("Degree *")?.options || []);
  const academicDegreeDetails = shouldUseAcademicCredentials
    ? inferAcademicDegreeDetails(academicCredentials, form.fieldMap.get("Degree *")?.options || [])
    : null;
  const trustedTranscriptSchoolName = transcriptSchoolLookup?.name
    || (isPlausibleSchoolName(schoolNameCandidate) ? schoolNameCandidate : currentSchoolName);

  const schoolName = shouldUseAcademicCredentials
    ? (academicCredentials?.schoolName || trustedTranscriptSchoolName || currentSchoolName)
    : trustedTranscriptSchoolName;
  const schoolLookup = schoolName
    ? await lookupSchool(readerPage, schoolName)
    : transcriptSchoolLookup;
  const degreeDetails = {
    educationLevel: transcriptDegreeDetails.educationLevel || academicDegreeDetails?.educationLevel || "",
    desiredDegreeLabel: transcriptDegreeDetails.desiredDegreeLabel || academicDegreeDetails?.desiredDegreeLabel || "",
    major: transcriptDegreeDetails.major || academicDegreeDetails?.major || "",
  };
  const graduationDate = shouldUseAcademicCredentials
    ? (academicCredentials?.graduationDate || extractGraduationDate(transcriptText))
    : extractGraduationDate(transcriptText);

  return {
    schoolNameCandidate: schoolName,
    schoolLookup,
    transcriptSchoolLookup,
    degreeBlock,
    degreeDetails,
    graduationDate,
    usedAcademicCredentials: shouldUseAcademicCredentials,
    academicCredentials,
  };
}

async function extractAcademicCredentialsMetadata(readerPage, streamId) {
  const pages = await tryFetchReaderStreamText(readerPage, streamId);
  if (!pages) {
    return null;
  }
  const fullText = pages.map((page) => selectDataItemsToText(page?.text ?? [])).join("\n\n");
  const collapsed = normalizeSpace(fullText);
  const countryName = matchLabeledField(collapsed, /Country/i, [
    "Foreign credential",
    "Field of study",
    "Foreign Institution",
    "Dates attended",
  ]);
  const schoolName = matchLabeledField(collapsed, /Foreign Institution/i, [
    "Dates attended",
    "Date awarded",
    "Length of program",
    "Documents viewed",
  ]);
  const fieldOfStudy = matchLabeledField(collapsed, /Field of study/i, [
    "Foreign Institution",
    "Dates attended",
    "Date awarded",
    "Length of program",
  ]);
  const degreeEquivalency = matchLabeledField(collapsed, /Summary of U\.S\. Equivalency/i, [
    "Overall U.S. Semester Hours / GPA",
    "Credentials",
    "Country",
  ]);
  const graduationDateText = matchLabeledField(collapsed, /Date awarded/i, [
    "Length of program",
    "Documents viewed",
    "Semester hours/GPA",
  ]);

  return {
    fullText,
    countryName,
    countryCode: countryNameToCode(countryName),
    schoolName,
    fieldOfStudy,
    degreeEquivalency,
    graduationDate: normalizeFlexibleDateCandidate(graduationDateText),
  };
}

function inferAcademicDegreeDetails(academicCredentials, degreeOptions) {
  if (!academicCredentials) {
    return null;
  }

  const degreePhrase = normalizeSpace(
    academicCredentials.degreeEquivalency || academicCredentials.foreignCredential || "",
  );
  const fieldOfStudy = normalizeSpace(academicCredentials.fieldOfStudy || "");
  const phrase = degreePhraseIncludesField(degreePhrase, fieldOfStudy)
    ? degreePhrase
    : normalizeSpace([degreePhrase, fieldOfStudy].filter(Boolean).join(" in "));

  if (!phrase) {
    return null;
  }

  const degreeBlock = phrase.toUpperCase();
  const educationLevel = degreeBlock.includes("BACHELOR")
    ? "Undergraduate"
    : degreeBlock.includes("MASTER")
      ? "Graduate"
      : degreeBlock.includes("DOCTOR")
        ? "Doctoral"
        : "";

  const major = fieldOfStudy;
  const sourcePhrase = major ? `${phrase} ${major}` : phrase;

  return {
    educationLevel,
    desiredDegreeLabel: chooseBestDegreeLabel(sourcePhrase, degreeOptions, major),
    major,
  };
}

function matchLabeledField(collapsedText, labelPattern, stopLabels) {
  const stop = stopLabels.map((label) => escapeRegex(label));
  const regex = new RegExp(`${labelPattern.source}\\s+(.+?)(?=\\s+(?:${stop.join("|")})\\b|$)`, "i");
  const match = collapsedText.match(regex);
  return normalizeSpace(match?.[1] || "");
}

function extractSchoolNameCandidate(transcriptText, currentSchoolName) {
  const lines = transcriptText
    .split("\n")
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .slice(0, 80);

  const ignored = [
    /SWORN PUBLIC TRANSLATOR/i,
    /VICE-DEAN/i,
    /CENTRAL COORDINATION/i,
    /ACADEMIC TRANSCRIPT/i,
    /FEDERATIVE REPUBLIC/i,
    /TRADE BOARD/i,
    /^PAGE:/i,
  ];

  const candidates = lines
    .filter((line) => /(UNIVERSITY|UNIVERSIDADE|COLLEGE|INSTITUTE|ACADEMY|SCHOOL|POLYTECHNIC)/i.test(line))
    .filter((line) => !ignored.some((pattern) => pattern.test(line)))
    .map((line) => line.replace(/^[\p{L}0-9 .'-]+\s+-\s+/u, "").trim())
    .filter(Boolean);

  if (candidates.length > 0) {
    return candidates.sort((a, b) => b.length - a.length)[0];
  }

  return currentSchoolName;
}

function isPlausibleSchoolName(value) {
  const normalized = normalizeSpace(value);
  if (!normalized) {
    return false;
  }
  if (normalized.length > 80) {
    return false;
  }
  if (/\d/.test(normalized)) {
    return false;
  }
  if (/(GPA|CUMULATIVE|CURRENT|MAJOR|DEGREE|AWARDED|BIRTHDATE|STUDENT ID|INSTITUTION ID|PAGE|REGISTRAR)/i.test(normalized)) {
    return false;
  }
  return true;
}

async function lookupSchool(readerPage, schoolName) {
  const response = await readerPage.evaluate(async (query) => {
    const res = await fetch(`/manage/service/lookup?type=school&q=${encodeURIComponent(query)}`, {
      credentials: "include",
    });
    return await res.json();
  }, schoolName);

  const first = Array.isArray(response.item) ? response.item[0] : null;
  if (!first) {
    return null;
  }

  return {
    id: first.id || "",
    name: stripHtml(first.name || schoolName),
    key: first.key || "",
    country: first.country || "",
    city: first.city || "",
    region: first.region || "",
  };
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractDegreeBlock(transcriptText) {
  const lines = transcriptText
    .split("\n")
    .map((line) => normalizeSpace(line))
    .filter(Boolean);

  const headerIndex = lines.findIndex((line) => /COURSE/.test(line) && /QUALIFICATION/.test(line));
  if (headerIndex >= 0) {
    return lines.slice(headerIndex + 1, headerIndex + 5).join(" ");
  }

  const collapsed = normalizeSpace(transcriptText);
  const degreeMatch = collapsed.match(/(BACHELOR'?S DEGREE.*?|MASTER'?S DEGREE.*?|DOCTOR(?:ATE)? .*?)(?= METHOD OF| SUBJECT | TERM | CURRICULUM | ISSUANCE |$)/i);
  return degreeMatch?.[1] || "";
}

function inferDegreeAndMajor(degreeBlock, degreeOptions) {
  const block = normalizeSpace(degreeBlock);
  const upperBlock = block.toUpperCase();
  const educationLevel = upperBlock.includes("BACHELOR")
    ? "Undergraduate"
    : upperBlock.includes("MASTER")
      ? "Graduate"
      : upperBlock.includes("DOCTOR")
        ? "Doctoral"
        : "";

  let major = "";
  let sourcePhrase = block;

  const inMatch = upperBlock.match(/(?:BACHELOR'?S|MASTER'?S|DOCTOR(?:ATE)?)[^A-Z]+DEGREE IN ([A-Z][A-Z\s&/-]+?)(?= [A-Z]{2,5} - | NO SPECIFICATION| METHOD OF| SUBJECT | TERM | CURRICULUM | ISSUANCE |$)/i);
  if (inMatch) {
    major = toTitleCase(inMatch[1]);
  }

  if (major) {
    const followMatch = upperBlock.match(/[A-Z]{2,5}\s+-\s+([A-Z][A-Z\s&/-]+?)(?= NO SPECIFICATION| METHOD OF| SUBJECT | TERM | CURRICULUM | ISSUANCE |$)/i);
    const followText = followMatch ? toTitleCase(followMatch[1]) : "";
    if (followText && !major.toLowerCase().endsWith(followText.toLowerCase())) {
      major = `${major} ${followText}`.replace(/\s+/g, " ").trim();
    }
  }

  if (!major) {
    const simpleMajor = upperBlock.match(/(?:BACHELOR'?S|MASTER'?S|DOCTOR(?:ATE)?)[^A-Z]+DEGREE IN ([A-Z][A-Z\s&/-]+)/i);
    if (simpleMajor) {
      major = toTitleCase(simpleMajor[1].split(" NO SPECIFICATION")[0].trim());
    }
  }

  if (major) {
    sourcePhrase = `${block} ${major}`.trim();
  }

  const desiredDegreeLabel = chooseBestDegreeLabel(sourcePhrase, degreeOptions, major);
  return {
    educationLevel,
    desiredDegreeLabel,
    major,
  };
}

function chooseBestDegreeLabel(sourcePhrase, degreeOptions, major) {
  if (!sourcePhrase || degreeOptions.length === 0) {
    return "";
  }

  const normalizedSource = normalizeCompareText(sourcePhrase);
  const sourceWords = new Set(normalizedSource.split(" ").filter(Boolean));
  const sourceDegreeProfile = classifyDegreeProfile(normalizedSource);
  let best = { label: "", score: -Infinity };

  for (const option of degreeOptions) {
    if (!option.value || !option.text) {
      continue;
    }

    const normalizedOption = normalizeCompareText(option.text);
    const optionWords = normalizedOption.split(" ").filter(Boolean);
    const optionDegreeProfile = classifyDegreeProfile(normalizedOption);
    let score = 0;

    for (const word of optionWords) {
      if (sourceWords.has(word)) {
        score += 2;
      }
    }

    if (/bachelor/.test(normalizedOption) && /bachelor/.test(normalizedSource)) {
      score += 4;
    }
    if (/master/.test(normalizedOption) && /master/.test(normalizedSource)) {
      score += 4;
    }
    if (/doctor/.test(normalizedOption) && /doctor/.test(normalizedSource)) {
      score += 4;
    }
    if (/engineering/.test(normalizedOption) && /engineering/.test(normalizedSource)) {
      score += 4;
    }
    if (/science/.test(normalizedOption) && /science/.test(normalizedSource)) {
      score += 4;
    }
    if (major && normalizedOption.includes(normalizeCompareText(major))) {
      score += 2;
    }

    if (sourceDegreeProfile.exactLabel && normalizedOption === sourceDegreeProfile.exactLabel) {
      score += 30;
    }

    if (sourceDegreeProfile.level && sourceDegreeProfile.level === optionDegreeProfile.level) {
      score += 8;
    }

    if (sourceDegreeProfile.hasScience && optionDegreeProfile.hasScience) {
      score += 8;
    }
    if (sourceDegreeProfile.hasArts && optionDegreeProfile.hasArts) {
      score += 8;
    }
    if (sourceDegreeProfile.hasEngineering && optionDegreeProfile.hasEngineering) {
      score += 10;
    }

    if (sourceDegreeProfile.hasScience && !sourceDegreeProfile.hasArts && optionDegreeProfile.hasArts) {
      score -= 14;
    }
    if (sourceDegreeProfile.hasArts && !sourceDegreeProfile.hasScience && optionDegreeProfile.hasScience) {
      score -= 10;
    }
    if (!sourceDegreeProfile.isCombined && optionDegreeProfile.isCombined) {
      score -= 18;
    }
    if (sourceDegreeProfile.isCombined && !optionDegreeProfile.isCombined) {
      score -= 6;
    }
    if (sourceDegreeProfile.hasEngineering && !optionDegreeProfile.hasEngineering && /engineering/.test(normalizedSource)) {
      score -= 12;
    }

    if (score > best.score) {
      best = { label: option.text, score };
    }
  }

  return best.score > 0 ? best.label : "";
}

function degreePhraseIncludesField(degreePhrase, fieldOfStudy) {
  if (!degreePhrase || !fieldOfStudy) {
    return false;
  }

  return normalizeCompareText(degreePhrase).includes(normalizeCompareText(fieldOfStudy));
}

function classifyDegreeProfile(normalizedText) {
  const text = normalizeCompareText(normalizedText);
  const level = /\bdoctor/.test(text)
    ? "doctor"
    : /\bmaster/.test(text)
      ? "master"
      : /\bbachelor/.test(text)
        ? "bachelor"
        : "";

  const hasArts = /\barts?\b/.test(text);
  const hasScience = /\bscience\b/.test(text);
  const hasEngineering = /\bengineering\b/.test(text);
  const isCombined = /\b(?:ba bs|bs ba|b a b s|bachelor of arts and bachelor of science|bachelor of science and bachelor of arts)\b/.test(text)
    || (/\bbachelor of arts\b/.test(text) && /\bbachelor of science\b/.test(text));

  let exactLabel = "";
  if (/\bbachelor of science\b/.test(text) && !hasArts && !isCombined) {
    exactLabel = "bachelor of science";
  } else if (/\bbachelor of arts\b/.test(text) && !hasScience && !isCombined) {
    exactLabel = "bachelor of arts";
  } else if (/\bbachelor of engineering\b/.test(text)) {
    exactLabel = "bachelor of engineering";
  } else if (/\bmaster of science\b/.test(text) && !hasArts && !isCombined) {
    exactLabel = "master of science";
  } else if (/\bmaster of arts\b/.test(text) && !hasScience && !isCombined) {
    exactLabel = "master of arts";
  } else if (/\bmaster of engineering\b/.test(text)) {
    exactLabel = "master of engineering";
  }

  return {
    exactLabel,
    hasArts,
    hasEngineering,
    hasScience,
    isCombined,
    level,
  };
}

function extractGraduationDate(transcriptText) {
  const collapsed = normalizeSpace(transcriptText);
  const patterns = [
    /(graduation|degree awarded|degree date|date of graduation|date of conferral|conferral)[^0-9A-Za-z]{0,20}(\d{4}[/-]\d{2}[/-]\d{2})/i,
    /(graduation|degree awarded|degree date|date of graduation|date of conferral|conferral)[^0-9A-Za-z]{0,20}(\d{2}[/-]\d{2}[/-]\d{4})/i,
  ];

  for (const pattern of patterns) {
    const match = collapsed.match(pattern);
    if (match?.[2]) {
      return normalizeDateCandidate(match[2]);
    }
  }

  return "";
}

function normalizeDateCandidate(value) {
  const trimmed = normalizeSpace(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month}-${day}`;
  }
  return "";
}

function normalizeFlexibleDateCandidate(value) {
  const trimmed = normalizeSpace(value).replace(/\./g, "/");
  const iso = normalizeDateCandidate(trimmed);
  if (iso) {
    return iso;
  }

  const monthName = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthName) {
    const [, monthText, dayText, yearText] = monthName;
    const month = monthNameToNumber(monthText);
    if (month) {
      return `${yearText}-${month}-${dayText.padStart(2, "0")}`;
    }
  }

  return "";
}

function monthNameToNumber(value) {
  const months = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  return months[normalizeSpace(value).toLowerCase()] || "";
}

function countryNameToCode(value) {
  const normalized = normalizeCompareText(value);
  if (normalized === "united states" || normalized === "usa" || normalized === "us") {
    return "US";
  }
  if (normalized === "canada") {
    return "CA";
  }
  if (normalized === "brazil") {
    return "BR";
  }
  return "";
}

function isNonUsCanadaCountryCode(value) {
  const code = normalizeSpace(value).toUpperCase();
  if (!code) {
    return false;
  }
  return code !== "US" && code !== "CA";
}

function buildDesiredFieldValues(form, extracted) {
  const desired = new Map(form.fields.map((field) => [field.label, field.kind === "select" ? field.selectedText : field.value]));

  if (extracted.schoolLookup?.name) {
    desired.set("School Name *", extracted.schoolLookup.name);
  } else if (extracted.schoolNameCandidate) {
    desired.set("School Name *", extracted.schoolNameCandidate);
  }

  if (extracted.schoolLookup?.key) {
    desired.set("School Key *", extracted.schoolLookup.key);
  }

  if (extracted.schoolLookup?.country) {
    const countryField = form.fieldMap.get("Country");
    const option = countryField?.options.find((candidate) => candidate.value === extracted.schoolLookup.country);
    if (option?.text) {
      desired.set("Country", option.text);
    }
  }

  if (extracted.degreeDetails.educationLevel) {
    desired.set("Level of Study *", extracted.degreeDetails.educationLevel);
  }

  if (extracted.degreeDetails.desiredDegreeLabel) {
    desired.set("Degree *", extracted.degreeDetails.desiredDegreeLabel);
  }

  desired.set("Degree Status *", DEGREE_STATUS_FINAL_LABEL);

  if (extracted.degreeDetails.major) {
    desired.set("Major", extracted.degreeDetails.major);
  }

  if (extracted.graduationDate) {
    desired.set("Graduation Date *yyyy-MM-dd", extracted.graduationDate);
  }

  return desired;
}

function diffFieldValues(form, desired) {
  const watchedLabels = [
    "School Name *",
    "School Key *",
    "Country",
    "Level of Study *",
    "Degree *",
    "Degree Status *",
    "Major",
    "Graduation Date *yyyy-MM-dd",
  ];

  return watchedLabels
    .map((label) => {
      const field = form.fieldMap.get(label);
      if (!field) {
        return null;
      }

      const from = normalizeSpace(field.displayValue);
      const to = normalizeSpace(desired.get(label) ?? from);
      if (!to || from === to) {
        return null;
      }

      return { label, from, to };
    })
    .filter(Boolean);
}

async function submitMaterialForm(readerPage, editContext, form, desired) {
  const payload = buildMaterialSavePayload(editContext, form, desired);
  const result = await readerPage.evaluate(async (request) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) {
      body.set(key, value ?? "");
    }

    const response = await fetch("/manage/database/acquire", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: body.toString(),
    });

    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }, payload);

  if (!result.ok || !/^OK\b/.test(result.text.trim())) {
    throw new Error(`Slate did not accept the transcript metadata save. Response: ${result.status} ${result.text.slice(0, 200)}`);
  }
}

function buildMaterialSavePayload(editContext, form, desired) {
  const serializedForm = new URLSearchParams();
  serializedForm.set("form", form.formId);

  for (const field of form.fields) {
    const desiredDisplayValue = desired.get(field.label);
    if (field.kind === "select") {
      const matchedOption = field.options.find((option) => option.text === desiredDisplayValue)
        || field.options.find((option) => option.text === field.selectedText)
        || field.options[0];
      serializedForm.set(field.name, matchedOption?.value || "");
    } else {
      serializedForm.set(field.name, desiredDisplayValue ?? field.value ?? "");
    }
  }

  return {
    cmd: "save",
    edit_mode: editContext.editMode,
    id: editContext.materialId,
    application: editContext.application,
    stream: editContext.stream,
    record: editContext.record,
    key: editContext.key,
    memo: "",
    transform: "",
    redact: "",
    form: serializedForm.toString(),
  };
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCompareText(value) {
  return normalizeSpace(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value) {
  return normalizeSpace(value)
    .toLowerCase()
    .split(" ")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function parseArgs(argv) {
  const options = {
    auditColumn: "G",
    browser: "brave",
    commentColumn: "",
    port: 9222,
    limit: null,
    nColumn: "D",
    nNumber: "",
    rowFrom: null,
    rowTo: null,
    save: false,
    sheetTab: "",
    sheetUrl: null,
    slateSearchUrl: null,
    statusColumn: "E",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--audit-column":
        options.auditColumn = next;
        index += 1;
        break;
      case "--browser":
        options.browser = next;
        index += 1;
        break;
      case "--comment-column":
        options.commentColumn = next;
        index += 1;
        break;
      case "--limit":
        options.limit = Number(next);
        index += 1;
        break;
      case "--n-column":
        options.nColumn = next;
        index += 1;
        break;
      case "--n-number":
        options.nNumber = String(next || "").trim();
        index += 1;
        break;
      case "--port":
        options.port = Number(next);
        index += 1;
        break;
      case "--row-from":
        options.rowFrom = Number(next);
        index += 1;
        break;
      case "--row-to":
        options.rowTo = Number(next);
        index += 1;
        break;
      case "--save":
      case "--write":
        options.save = true;
        break;
      case "--sheet-tab":
        options.sheetTab = String(next || "").trim();
        index += 1;
        break;
      case "--sheet-url":
        options.sheetUrl = next;
        index += 1;
        break;
      case "--slate-search-url":
        options.slateSearchUrl = next;
        index += 1;
        break;
      case "--status-column":
        options.statusColumn = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("The --port value must be a positive integer.");
  }

  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error("The --limit value must be a positive integer.");
  }

  if (options.rowFrom !== null && (!Number.isInteger(options.rowFrom) || options.rowFrom < 2)) {
    throw new Error("The --row-from value must be an integer row number of 2 or greater.");
  }

  if (options.rowTo !== null && (!Number.isInteger(options.rowTo) || options.rowTo < 2)) {
    throw new Error("The --row-to value must be an integer row number of 2 or greater.");
  }

  if (options.rowFrom !== null && options.rowTo !== null && options.rowFrom > options.rowTo) {
    throw new Error("--row-from cannot be greater than --row-to.");
  }

  options.auditColumn = normalizeColumnRef(options.auditColumn, "--audit-column");
  options.nColumn = normalizeColumnRef(options.nColumn, "--n-column");
  options.statusColumn = normalizeColumnRef(options.statusColumn, "--status-column");
  options.auditColumnIndex = columnRefToIndex(options.auditColumn);
  options.nColumnIndex = columnRefToIndex(options.nColumn);
  options.statusColumnIndex = columnRefToIndex(options.statusColumn);
  options.commentColumn = options.commentColumn
    ? normalizeColumnRef(options.commentColumn, "--comment-column")
    : indexToColumnRef(options.statusColumnIndex + 1);
  options.commentColumnIndex = columnRefToIndex(options.commentColumn);

  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run admit:send -- --n-number N15736118
  npm run admit:send -- --sheet-url "<google sheets url>" --sheet-tab Sheet1

Optional flags:
  --audit-column G
  --browser brave|chrome
  --port 9222
  --n-column D
  --limit 5
  --row-from 2
  --row-to 20
  --sheet-tab Test
  --save
  --slate-search-url "https://apply.engineering.nyu.edu/manage/lookup/search"
`);
}

async function writeRunReport(results, options, sheetInfo) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const reportPath = path.join(reportsDir, `admit-send-report-${timestamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: options.save ? "save" : "dry-run",
    nNumber: options.nNumber || null,
    sheetUrl: sheetInfo?.rawUrl || null,
    sheetTab: options.sheetTab || sheetInfo?.sheetTab || null,
    columns: {
      auditColumn: options.auditColumn,
      nColumn: options.nColumn,
      statusColumn: options.statusColumn,
      commentColumn: options.commentColumn,
    },
    results,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

async function createSlatePage(context, slateSearchUrl) {
  const page = await context.newPage();
  await page.goto(slateSearchUrl, { waitUntil: "domcontentloaded" });
  return page;
}

async function openApplicationTab(slatePage) {
  if (await isApplicationViewVisible(slatePage)) {
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const clicked = await clickApplicationTab(slatePage);
    if (!clicked) {
      throw new Error("Could not find the application tab on the Slate record.");
    }

    try {
      await waitForApplicationView(slatePage);
      return;
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

async function clickApplicationTab(slatePage) {
  const appTabLocator = slatePage
    .locator('ul.tabs a[data-tab="Application"], ul.tabs a[data-href*="/manage/lookup/application"]')
    .first();
  if ((await appTabLocator.count()) > 0) {
    await appTabLocator.click({ noWaitAfter: true });
    return true;
  }

  const lazyAppClicked = await slatePage.evaluate(() => {
    const candidate = document.querySelector('ul.tabs a[data-tab="Application"], ul.tabs a[data-href*="/manage/lookup/application"]');
    if (!(candidate instanceof HTMLElement)) {
      return false;
    }

    candidate.click();
    return true;
  });

  if (lazyAppClicked) {
    return true;
  }

  const roleBasedCandidates = [
    slatePage.locator("ul.tabs a").filter({ hasText: TERM_TAB_PATTERN }).first(),
    slatePage.getByRole("link", { name: TERM_TAB_PATTERN }).first(),
  ];

  for (const candidate of roleBasedCandidates) {
    if ((await candidate.count()) > 0) {
      await candidate.click({ noWaitAfter: true });
      return true;
    }
  }

  const domClicked = await slatePage.evaluate((patternSource) => {
    const matcher = new RegExp(patternSource, "i");
    const elements = Array.from(document.querySelectorAll("ul.tabs a"));
    const candidate = elements.find((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      return matcher.test(text);
    });

    if (!candidate) {
      return false;
    }

    candidate.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }, TERM_TAB_PATTERN.source);

  return domClicked;
}

async function isApplicationViewVisible(slatePage) {
  const signals = [
    slatePage.getByText("Checklist", { exact: true }),
    slatePage.getByText("University ID:", { exact: false }),
    slatePage.getByText("Current Bin:", { exact: false }),
    slatePage.getByText("Enrollment Audit:", { exact: false }),
    slatePage.getByText("Read Application", { exact: false }),
  ];

  for (const signal of signals) {
    if (await signal.isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
}

async function waitForApplicationView(slatePage) {
  await slatePage.waitForFunction(() => {
    const appTab = document.querySelector('ul.tabs a[data-tab="Application"], ul.tabs a[data-href*="/manage/lookup/application"]');
    const targetSelector = appTab?.getAttribute("data-div");
    if (!targetSelector) {
      return false;
    }

    const target = document.querySelector(targetSelector);
    if (!target) {
      return false;
    }

    return !target.classList.contains("hidden");
  }, { timeout: 15_000 }).catch(() => {});

  await slatePage.waitForFunction(() => {
    const bodyText = document.body?.innerText || "";
    return [
      "Checklist",
      "University ID:",
      "Current Bin:",
      "Enrollment Audit:",
      "Read Application",
    ].some((marker) => bodyText.includes(marker));
  }, { timeout: 20_000 });
}

async function captureErrorScreenshot(page, baseName) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const screenshotPath = path.join(reportsDir, `${baseName}-${timestamp}.png`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch {
    return null;
  }
}

function normalizeColumnRef(value, flagName) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error(`${flagName} must be a spreadsheet column label like D or AA.`);
  }
  return normalized;
}

function columnRefToIndex(columnRef) {
  let index = 0;
  for (const char of columnRef) {
    index = (index * 26) + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function indexToColumnRef(index) {
  let current = Number(index) + 1;
  let label = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    current = Math.floor((current - 1) / 26);
  }

  return label;
}

function parseSheetUrl(sheetUrl) {
  const url = new URL(sheetUrl);
  const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) {
    throw new Error("Could not parse the Google Sheet id from the provided URL.");
  }

  const sheetId = match[1];
  const gidMatch = extractGidFromUrl(sheetUrl);

  return {
    rawUrl: sheetUrl,
    origin: url.origin,
    sheetId,
    gid: gidMatch,
    editUrl: `${url.origin}/spreadsheets/d/${sheetId}/edit`,
  };
}

function extractGidFromUrl(value) {
  return value.match(/[#&]gid=([0-9]+)/)?.[1] ?? null;
}

async function resolveSheetInfo(sheetPage, sheetInfo, options) {
  await sheetPage.waitForLoadState("domcontentloaded");
  await delay(2_000);

  if (options.sheetTab) {
    const beforeUrl = sheetPage.url();
    const beforeGid = extractGidFromUrl(beforeUrl);
    const selectedTab = await clickSheetTabByName(sheetPage, options.sheetTab);
    if (!selectedTab) {
      throw new Error(`Could not find the Google Sheets tab named "${options.sheetTab}".`);
    }

    await waitForSheetTabActivation(sheetPage, selectedTab.name, beforeGid).catch(() => {});

    await delay(1_000);
    const tabUrl = sheetPage.url();
    const tabGid = extractGidFromUrl(tabUrl);
    if (tabGid) {
      return {
        ...sheetInfo,
        rawUrl: tabUrl,
        gid: tabGid,
        sheetTab: selectedTab.name,
      };
    }

    const activeTab = await getActiveSheetTab(sheetPage);
    if (activeTab?.gid) {
      return {
        ...sheetInfo,
        rawUrl: sheetPage.url(),
        gid: activeTab.gid,
        sheetTab: activeTab.name,
      };
    }
  }

  if (sheetInfo.gid) {
    return sheetInfo;
  }

  const currentUrl = sheetPage.url();
  const urlGid = extractGidFromUrl(currentUrl);
  if (urlGid) {
    return {
      ...sheetInfo,
      rawUrl: currentUrl,
      gid: urlGid,
      sheetTab: options.sheetTab || sheetInfo.sheetTab || "",
    };
  }

  return {
    ...sheetInfo,
    gid: "0",
    sheetTab: options.sheetTab || sheetInfo.sheetTab || "",
  };
}

async function clickSheetTabByName(sheetPage, requestedTabName) {
  const allTabs = await listSheetTabsOnPage(sheetPage);
  const wanted = normalizeSheetTabName(requestedTabName);
  const exact = allTabs.find((tab) => normalizeSheetTabName(tab.name) === wanted);
  const partial = allTabs.find((tab) => normalizeSheetTabName(tab.name).includes(wanted));
  const match = exact || partial;

  if (!match) {
    return null;
  }

  const locator = sheetPage
    .locator(".docs-sheet-tab")
    .filter({
      has: sheetPage.locator(".docs-sheet-tab-name", {
        hasText: new RegExp(`^${escapeRegex(match.name)}$`),
      }),
    })
    .first();

  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 5_000 });
  return match;
}

async function waitForSheetTabActivation(sheetPage, requestedTabName, previousGid) {
  const wanted = normalizeSheetTabName(requestedTabName);
  await sheetPage.waitForFunction(
    ({ expectedName, previousSheetGid }) => {
      const normalize = (value) => value.replace(/\s+/g, " ").replace(/^\d+/, "").trim().toLowerCase();
      const active = document.querySelector(".docs-sheet-tab.docs-sheet-active-tab .docs-sheet-tab-name")
        || document.querySelector(".docs-sheet-tab.docs-sheet-active-tab");
      const activeName = normalize(active?.textContent || "");
      const currentGid = window.location.href.match(/[#&]gid=([0-9]+)/)?.[1] ?? null;
      return activeName === expectedName || (currentGid && currentGid !== previousSheetGid);
    },
    { expectedName: wanted, previousSheetGid: previousGid ?? null },
    { timeout: 7_500 },
  );
}

async function getActiveSheetTab(sheetPage) {
  const tabs = await listSheetTabsOnPage(sheetPage);
  return tabs.find((tab) => tab.active) ?? null;
}

async function listSheetTabsOnPage(sheetPage) {
  return sheetPage.evaluate(() => {
    const normalize = (value) => value.replace(/\s+/g, " ").replace(/^\d+/, "").trim();
    const tabs = Array.from(document.querySelectorAll(".docs-sheet-tab"));

    return tabs
      .map((tab) => {
        const nameNode = tab.querySelector(".docs-sheet-tab-name");
        const name = normalize(nameNode?.textContent || tab.textContent || "");
        if (!name) {
          return null;
        }

        return {
          name,
          active: tab.classList.contains("docs-sheet-active-tab"),
          gid: window.location.href.match(/[#&]gid=([0-9]+)/)?.[1] ?? null,
        };
      })
      .filter(Boolean);
  });
}

function normalizeSheetTabName(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^\d+/, "").trim().toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchSheetRows(sheetPage, sheetInfo, options) {
  await ensureSheetPageContext(sheetPage, sheetInfo);

  const exportUrl = `${sheetInfo.origin}/spreadsheets/d/${sheetInfo.sheetId}/export?format=csv&gid=${sheetInfo.gid}`;
  let response;

  try {
    response = await sheetPage.evaluate(async (url) => {
      const res = await fetch(url, { credentials: "include" });
      return {
        ok: res.ok,
        status: res.status,
        text: await res.text(),
      };
    }, exportUrl);
  } catch {
    response = await fetchSheetCsvWithBrowserCookies(sheetPage, exportUrl);
  }

  if (!response.ok || /^\s*</.test(response.text)) {
    throw new Error("Could not export the Google Sheet as CSV. Confirm that this browser profile is logged into Google.");
  }

  const records = parseCsv(response.text, {
    relax_column_count: true,
    skip_empty_lines: false,
  });

  return records.slice(1).map((cells, index) => {
    const safeCells = Array.isArray(cells) ? cells : [];
    return {
      rowNumber: index + 2,
      nNumber: safeCells[options.nColumnIndex]?.trim() ?? "",
      originalStatus: safeCells[options.statusColumnIndex]?.trim() ?? "",
      originalComment: safeCells[options.commentColumnIndex]?.trim() ?? "",
      originalAudit: safeCells[options.auditColumnIndex]?.trim() ?? "",
      cells: safeCells,
    };
  });
}

async function ensureSheetPageContext(sheetPage, sheetInfo) {
  const currentUrl = sheetPage.url();
  if (currentUrl.includes(`/spreadsheets/d/${sheetInfo.sheetId}/`)) {
    return;
  }

  await safeSheetGoto(sheetPage, `${sheetInfo.editUrl}#gid=${sheetInfo.gid}&range=A1`);
}

async function safeSheetGoto(sheetPage, url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await sheetPage.goto(url, { waitUntil: "domcontentloaded" });
      await delay(2_000);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ERR_ABORTED") || attempt === 2) {
        throw error;
      }
      await delay(1_000);
    }
  }
}

async function fetchSheetCsvWithBrowserCookies(sheetPage, exportUrl) {
  const cookies = await sheetPage.context().cookies(exportUrl);
  const userAgent = await sheetPage.evaluate(() => navigator.userAgent);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

  const res = await fetch(exportUrl, {
    headers: {
      Cookie: cookieHeader,
      "User-Agent": userAgent,
      Accept: "text/csv,text/plain,*/*",
      Referer: sheetPage.url(),
    },
    redirect: "follow",
  });

  return {
    ok: res.ok,
    status: res.status,
    text: await res.text(),
  };
}

function makeSheetRangeUrl(sheetInfo, range) {
  return `${sheetInfo.editUrl}#gid=${sheetInfo.gid}&range=${encodeURIComponent(range)}`;
}

function planRows(sheetRows, options) {
  let rows = sheetRows.filter((row) => row.nNumber);

  rows = rows.filter((row) => ELIGIBLE_APP_STATUSES.has(row.originalStatus));
  rows = rows.filter((row) => !hasAuditMark(row.originalAudit));

  if (options.rowFrom !== null) {
    rows = rows.filter((row) => row.rowNumber >= options.rowFrom);
  }

  if (options.rowTo !== null) {
    rows = rows.filter((row) => row.rowNumber <= options.rowTo);
  }

  if (options.limit !== null) {
    rows = rows.slice(0, options.limit);
  }

  return rows;
}

function hasAuditMark(value) {
  const normalized = normalizeSpace(value);
  return normalized === AUDIT_DONE_MARK || normalized === "✔" || normalized === "✅";
}

async function writeAuditMarkToSheet(sheetPage, sheetInfo, options, rowNumber, nNumber) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targetRange = `${options.auditColumn}${rowNumber}`;
    await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, targetRange));
    await selectRange(sheetPage, targetRange).catch(() => {});
    await writeFormulaValue(sheetPage, AUDIT_DONE_MARK);
    const committed = await waitForSheetCellValue(
      sheetPage,
      sheetInfo,
      options,
      rowNumber,
      AUDIT_DONE_MARK,
      "originalAudit",
      4_000,
    );
    if (committed) {
      return true;
    }

    const currentUrl = sheetPage.url();
    if (!currentUrl.includes(`/spreadsheets/d/${sheetInfo.sheetId}/`)) {
      await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, targetRange));
    }

    await delay(500);
  }

  console.log(`  -> Warning: sent ${nNumber}, but could not mark ${options.auditColumn}${rowNumber} in Google Sheets.`);
  return false;
}

async function writeCommentsToSheet(sheetPage, sheetInfo, options, results) {
  await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, `${options.commentColumn}2`));
  const currentRows = await fetchSheetRows(sheetPage, sheetInfo, options);
  const currentRowsByNumber = new Map(currentRows.map((row) => [row.rowNumber, row]));
  const failures = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const existingValue = currentRowsByNumber.get(result.rowNumber)?.originalComment ?? "";
    if (existingValue === result.comment) {
      continue;
    }

    let wroteRow = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const targetRange = `${options.commentColumn}${result.rowNumber}`;
      await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, targetRange));
      await selectRange(sheetPage, targetRange).catch(() => {});
      await writeFormulaValue(sheetPage, result.comment);
      const committed = await waitForSheetCommentValue(
        sheetPage,
        sheetInfo,
        options,
        result.rowNumber,
        result.comment,
        4_000,
      );
      if (committed) {
        currentRowsByNumber.set(result.rowNumber, {
          ...currentRowsByNumber.get(result.rowNumber),
          rowNumber: result.rowNumber,
          nNumber: result.nNumber,
          originalComment: result.comment,
        });
        wroteRow = true;
        break;
      }

      const currentUrl = sheetPage.url();
      if (!currentUrl.includes(`/spreadsheets/d/${sheetInfo.sheetId}/`)) {
        await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, `${options.commentColumn}${result.rowNumber}`));
      }

      await delay(500);
    }

    if (!wroteRow) {
      failures.push({
        rowNumber: result.rowNumber,
        expected: result.comment,
        actual: currentRowsByNumber.get(result.rowNumber)?.originalComment ?? "",
      });
    }
  }

  return failures;
}

async function selectRange(sheetPage, range) {
  const nameBox = await findVisibleLocator(sheetPage, NAME_BOX_SELECTORS);
  if (!nameBox) {
    throw new Error("Could not find the Google Sheets name box.");
  }

  await nameBox.click();
  await nameBox.fill(range);
  await nameBox.press("Enter");
  await delay(300);
}

async function writeFormulaValue(sheetPage, value) {
  const formulaBar = await findVisibleLocator(sheetPage, FORMULA_BAR_SELECTORS);
  if (formulaBar) {
    await formulaBar.click({ clickCount: 2 });
    await delay(150);
    await sheetPage.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await sheetPage.keyboard.insertText(value);
    await sheetPage.keyboard.press("Enter");
    return;
  }

  await sheetPage.keyboard.insertText(value);
  await sheetPage.keyboard.press("Enter");
}

async function findVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  return null;
}

async function waitForSheetCommentValue(sheetPage, sheetInfo, options, rowNumber, expectedValue, timeoutMs) {
  return waitForSheetCellValue(sheetPage, sheetInfo, options, rowNumber, expectedValue, "originalComment", timeoutMs);
}

async function waitForSheetCellValue(sheetPage, sheetInfo, options, rowNumber, expectedValue, fieldName, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = await withTimeout(() => fetchSheetRows(sheetPage, sheetInfo, options), 5_000, []);
    const currentValue = rows.find((row) => row.rowNumber === rowNumber)?.[fieldName] ?? "";
    if (currentValue === expectedValue) {
      return true;
    }

    await delay(500);
  }

  return false;
}

const NAME_BOX_SELECTORS = [
  "input[aria-label='Name box']",
  "input[aria-label='Name box. Type a cell reference']",
  ".jfk-textinput.docs-name-box-input",
];

const FORMULA_BAR_SELECTORS = [
  "#t-formula-bar-input .cell-input",
  "textarea[aria-label='Formula bar']",
  "input[aria-label='Formula bar']",
];

function getBrowserExecutable(browserName) {
  const normalized = browserName.toLowerCase();
  if (normalized === "brave") {
    return "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  }

  if (normalized === "chrome" || normalized === "google-chrome") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  throw new Error(`Unsupported browser "${browserName}". Use "brave" or "chrome".`);
}

async function ensureBrowserLaunched(browserName, port) {
  const executablePath = getBrowserExecutable(browserName);
  const versionUrl = `http://127.0.0.1:${port}/json/version`;

  if (await isJsonEndpointReady(versionUrl)) {
    return;
  }

  spawn(executablePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
  }).unref();

  const timeoutAt = Date.now() + 20_000;
  while (Date.now() < timeoutAt) {
    if (await isJsonEndpointReady(versionUrl)) {
      return;
    }
    await delay(500);
  }

  throw new Error(`Could not connect to the browser on port ${port}.`);
}

async function isJsonEndpointReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
