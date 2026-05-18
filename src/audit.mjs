import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { parse as parseCsv } from "csv-parse/sync";
import { chromium } from "playwright-core";

const APP_STATUS = {
  missing: "Missing Required Docs - Needs to Stay on List",
  complete: "FOT and POD are satisfied - Enrollment Audit Complete",
  fotOnly: "FOT is satisfied | POD is unsatisfied - Needs to Stay on List",
  podOnly: "POD satisfied | FOT unsatisfied - Needs to Stay on List",
};

const TERM_TAB_PATTERN = /\b(Fall|Spring|Summer|Winter)\b.*\b(20)?\d{2}\b/i;
const NAME_BOX_SELECTORS = [
  "#t-name-box",
  'input[aria-label="Name box"]',
  'input[aria-label*="name box" i]',
];
const FORMULA_BAR_SELECTORS = [
  "#t-formula-bar-input .cell-input",
  "#t-formula-bar-input",
  'textarea[aria-label="Formula bar"]',
  'textarea[aria-label*="formula" i]',
];
const SCREENSHOT_DIRNAME = "reports";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const browserProfileDir = path.join(projectRoot, ".browser-profile");
const reportsDir = path.join(projectRoot, SCREENSHOT_DIRNAME);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(browserProfileDir, { recursive: true });
  await fs.mkdir(reportsDir, { recursive: true });

  const sheetUrl = options.sheetUrl ?? "";
  const slateSearchUrl = options.slateSearchUrl ?? "https://apply.engineering.nyu.edu/manage/lookup/search";

  if (!sheetUrl) {
    throw new Error("Missing --sheet-url. Pass the Google Sheets tab URL you want to audit.");
  }

  let sheetInfo = parseSheetUrl(sheetUrl);

  console.log(`Using ${options.browser} with a reusable browser profile in ${browserProfileDir}`);
  await ensureBrowserLaunched(options.browser, options.port);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  context.on("dialog", (dialog) => {
    dialog.dismiss().catch(() => {});
  });

  const sheetPage = await context.newPage();
  const slatePage = await context.newPage();

  await sheetPage.goto(sheetInfo.rawUrl, { waitUntil: "domcontentloaded" });
  await slatePage.goto(slateSearchUrl, { waitUntil: "domcontentloaded" });

  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("");
    console.log("If Google Sheets or Slate asks you to log in, do that in the opened browser window now.");
    console.log("Use this browser profile for future runs so your session stays saved.");
    await terminal.question("Press Enter here when both pages are ready... ");

    sheetInfo = await resolveSheetInfo(sheetPage, sheetInfo, options);
    console.log(`Using Google Sheet gid ${sheetInfo.gid}`);

    if (options.setupOnly) {
      console.log("Setup mode finished. No rows were processed in setup mode.");
      console.log("Next run the actual audit command, for example:");
      console.log(`npm run audit -- --sheet-url "${sheetInfo.rawUrl}" --limit 5 --dry-run`);
      return;
    }

    if (options.reportPath) {
      const writableResults = await loadWritableResultsFromReport(options.reportPath, options);
      await maybeWriteResults(terminal, sheetPage, sheetInfo, writableResults, options, "report");
      return;
    }

    const sheetRows = await fetchSheetRows(sheetPage, sheetInfo, options);
    const workItems = planRows(sheetRows, options);

    if (workItems.length === 0) {
      console.log("No rows matched the current filters. Nothing to do.");
      return;
    }

    console.log("");
    console.log(`Found ${workItems.length} row(s) to audit.`);
    if (options.dryRun) {
      console.log("Dry run is enabled, so results will be computed but not written back.");
    }

    const results = [];
    for (let index = 0; index < workItems.length; index += 1) {
      const row = workItems[index];
      console.log(`[${index + 1}/${workItems.length}] Auditing row ${row.rowNumber} (${row.nNumber})`);

      try {
        const audit = await auditStudent(slatePage, slateSearchUrl, row.nNumber);
        const appStatus = mapAuditStatus(audit);

        const result = {
          rowNumber: row.rowNumber,
          name: row.name,
          nNumber: row.nNumber,
          originalStatus: row.originalStatus,
          appStatus,
          fotSatisfied: audit.fotSatisfied,
          podSatisfied: audit.podSatisfied,
          fotRowsFound: audit.fotRowsFound,
          podRowFound: audit.podRowFound,
          notes: audit.notes,
          rawChecklistRows: audit.relevantRows,
          error: null,
        };

        results.push(result);
        console.log(`  -> ${appStatus}`);
      } catch (error) {
        const screenshotPath = await captureErrorScreenshot(slatePage, `slate-row-${row.rowNumber}`);
        results.push({
          rowNumber: row.rowNumber,
          name: row.name,
          nNumber: row.nNumber,
          originalStatus: row.originalStatus,
          appStatus: null,
          fotSatisfied: null,
          podSatisfied: null,
          fotRowsFound: 0,
          podRowFound: false,
          notes: [],
          rawChecklistRows: [],
          error: error instanceof Error ? error.message : String(error),
          screenshotPath,
        });
        console.log(`  -> Manual review needed (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    const reportPath = await writeRunReport(sheetInfo, results, options);
    console.log("");
    console.log(`Saved audit report to ${reportPath}`);

    const writableResults = results.filter((result) => result.appStatus);
    await maybeWriteResults(terminal, sheetPage, sheetInfo, writableResults, options, "audit");
  } finally {
    terminal.close();
  }
}

async function maybeWriteResults(terminal, sheetPage, sheetInfo, writableResults, options, sourceLabel) {
  if (sourceLabel === "report") {
    console.log("");
    console.log(`Loaded ${writableResults.length} row(s) from the report.`);
  }

  if (options.dryRun) {
    if (sourceLabel === "report") {
      console.log("Dry run is enabled, so results will not be written back.");
      for (const result of writableResults) {
        console.log(`  row ${result.rowNumber} (${result.nNumber}) -> ${result.appStatus}`);
      }
    }
    return;
  }

  if (writableResults.length === 0) {
    console.log("No computed statuses were safe to write back.");
    return;
  }

  console.log("");
  console.log(`Ready to write ${writableResults.length} status value(s) back into column ${options.statusColumn}.`);
  await terminal.question("Press Enter to write the results into Google Sheets... ");

  console.log("Writing results to Google Sheets...");
  const writeFailures = await writeStatusesToSheet(sheetPage, sheetInfo, options, writableResults);
  await delay(5_000);
  const verificationRows = await fetchSheetRows(sheetPage, sheetInfo, options);
  const verificationFailures = verifyWriteBack(verificationRows, writableResults);
  const allFailures = mergeWriteFailures(writeFailures, verificationFailures);

  if (allFailures.length === 0) {
    console.log("Google Sheet update verified.");
  } else {
    console.log("Some rows could not be verified after write-back:");
    for (const failure of allFailures) {
      console.log(`  - row ${failure.rowNumber}: expected "${failure.expected}" but found "${failure.actual}"`);
    }
  }
}

function parseArgs(argv) {
  const options = {
    browser: "brave",
    port: 9222,
    limit: null,
    nColumn: "D",
    rowFrom: null,
    rowTo: null,
    reportPath: null,
    sheetTab: "",
    statusColumn: "E",
    overwrite: false,
    dryRun: false,
    setupOnly: false,
    sheetUrl: null,
    slateSearchUrl: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--browser":
        options.browser = next;
        index += 1;
        break;
      case "--port":
        options.port = Number(next);
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
      case "--row-from":
        options.rowFrom = Number(next);
        index += 1;
        break;
      case "--row-to":
        options.rowTo = Number(next);
        index += 1;
        break;
      case "--status-column":
        options.statusColumn = next;
        index += 1;
        break;
      case "--report":
        options.reportPath = next;
        index += 1;
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
      case "--overwrite":
        options.overwrite = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--setup-only":
        options.setupOnly = true;
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

  options.nColumn = normalizeColumnRef(options.nColumn, "--n-column");
  options.statusColumn = normalizeColumnRef(options.statusColumn, "--status-column");
  options.nColumnIndex = columnRefToIndex(options.nColumn);
  options.statusColumnIndex = columnRefToIndex(options.statusColumn);

  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run audit -- --sheet-url "<google sheets url>"

Optional flags:
  --browser brave|chrome
  --port 9222
  --limit 5
  --n-column D
  --row-from 14
  --row-to 20
  --report reports/audit-report-...json
  --sheet-tab Test
  --status-column E
  --overwrite
  --dry-run
  --setup-only
  --slate-search-url "https://apply.engineering.nyu.edu/manage/lookup/search"
`);
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

  const pageGid = await sheetPage.evaluate(() => {
    const current = new URL(window.location.href);
    const direct = current.hash.match(/gid=([0-9]+)/)?.[1];
    if (direct) {
      return direct;
    }

    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (activeTab) {
      const href = activeTab.getAttribute("href");
      const activeMatch = href?.match(/gid=([0-9]+)/);
      if (activeMatch) {
        return activeMatch[1];
      }
    }

    const firstTabLink = document.querySelector('a[href*="gid="]');
    const fallbackMatch = firstTabLink?.getAttribute("href")?.match(/gid=([0-9]+)/);
    return fallbackMatch?.[1] ?? null;
  });

  if (pageGid) {
    return {
      ...sheetInfo,
      gid: pageGid,
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

function makeSheetRangeUrl(sheetInfo, range) {
  return `${sheetInfo.editUrl}#gid=${sheetInfo.gid}&range=${encodeURIComponent(range)}`;
}

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

  const dataRows = records.slice(1).map((cells, index) => {
    const safeCells = Array.isArray(cells) ? cells : [];
    return {
      rowNumber: index + 2,
      name: [safeCells[0], safeCells[1]].find(Boolean)?.trim() ?? "",
      decision: safeCells[2]?.trim() ?? "",
      nNumber: safeCells[options.nColumnIndex]?.trim() ?? "",
      originalStatus: safeCells[options.statusColumnIndex]?.trim() ?? "",
      cells: safeCells,
    };
  });

  return dataRows;
}

async function ensureSheetPageContext(sheetPage, sheetInfo) {
  const currentUrl = sheetPage.url();
  if (currentUrl.includes(`/spreadsheets/d/${sheetInfo.sheetId}/`)) {
    return;
  }

  await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, "A1"));
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

function planRows(sheetRows, options) {
  let rows = sheetRows.filter((row) => row.nNumber);

  if (!options.overwrite) {
    rows = rows.filter((row) => !row.originalStatus);
  }

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

async function loadWritableResultsFromReport(reportPath, options) {
  const resolvedPath = path.isAbsolute(reportPath) ? reportPath : path.join(projectRoot, reportPath);
  const payload = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  let results = Array.isArray(payload.results) ? payload.results.filter((result) => result.appStatus) : [];

  if (options.rowFrom !== null) {
    results = results.filter((result) => result.rowNumber >= options.rowFrom);
  }

  if (options.rowTo !== null) {
    results = results.filter((result) => result.rowNumber <= options.rowTo);
  }

  if (options.limit !== null) {
    results = results.slice(0, options.limit);
  }

  return results;
}

async function auditStudent(slatePage, slateSearchUrl, nNumber) {
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
  const resultCount = await slatePage.locator('table.table tbody tr').count();
  if (resultCount < 1) {
    throw new Error(`No Slate result was found for ${nNumber}.`);
  }

  await resultLink.click();
  await slatePage.waitForURL(/\/manage\/lookup\/record\?id=/, { timeout: 15_000 }).catch(() => {});
  await slatePage.waitForLoadState("domcontentloaded");
  await openApplicationTab(slatePage);
  await waitForApplicationView(slatePage);

  const relevantRows = await extractRelevantChecklistRows(slatePage);
  const proofOfDegree = relevantRows.find((row) => /^Proof of Degree$/i.test(row.subject));
  const finalOfficialTranscriptRows = relevantRows.filter((row) => /^Final Official Transcript\b/i.test(row.subject));

  return {
    podSatisfied: proofOfDegree ? isChecklistRowSatisfied(proofOfDegree) : false,
    fotSatisfied: finalOfficialTranscriptRows.length === 0
      ? false
      : finalOfficialTranscriptRows.every((row) => isChecklistRowSatisfied(row)),
    podRowFound: Boolean(proofOfDegree),
    fotRowsFound: finalOfficialTranscriptRows.length,
    relevantRows,
    notes: buildAuditNotes(proofOfDegree, finalOfficialTranscriptRows),
  };
}

async function openApplicationTab(slatePage) {
  if (await isApplicationViewVisible(slatePage)) {
    return;
  }

  const clicked = await clickApplicationTab(slatePage);
  if (!clicked) {
    throw new Error("Could not find the Fall 26 application tab on the Slate record.");
  }

  await waitForApplicationView(slatePage);
}

async function clickApplicationTab(slatePage) {
  const appTabLocator = slatePage.locator('a[data-tab="Application"]').first();
  if ((await appTabLocator.count()) > 0) {
    await appTabLocator.click();
    return true;
  }

  const lazyAppClicked = await slatePage.evaluate(() => {
    const candidate = document.querySelector('a[data-tab="Application"]');
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
    slatePage.getByRole("link", { name: TERM_TAB_PATTERN }).first(),
    slatePage.getByRole("tab", { name: TERM_TAB_PATTERN }).first(),
    slatePage.getByRole("button", { name: TERM_TAB_PATTERN }).first(),
  ];

  for (const candidate of roleBasedCandidates) {
    if ((await candidate.count()) > 0) {
      await candidate.click();
      return true;
    }
  }

  const textCandidate = slatePage.getByText(TERM_TAB_PATTERN).first();
  if ((await textCandidate.count()) > 0) {
    await textCandidate.click();
    return true;
  }

  const domClicked = await slatePage.evaluate((patternSource) => {
    const matcher = new RegExp(patternSource, "i");
    const elements = Array.from(document.querySelectorAll("a, button, td, div, span"));
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
    slatePage.getByText("Read Application", { exact: false }),
    slatePage.getByText("Proof of Degree", { exact: false }),
    slatePage.getByText("Final Official Transcript", { exact: false }),
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
    const appTab = document.querySelector('a[data-tab="Application"]');
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
      "Read Application",
      "Proof of Degree",
      "Final Official Transcript",
    ].some((marker) => bodyText.includes(marker));
  }, { timeout: 15_000 });

  await slatePage.waitForLoadState("networkidle").catch(() => {});

  await slatePage.waitForFunction(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const hasChecklist = text.includes("Checklist");
    const hasUniversityId = text.includes("University ID:");
    const hasRequiredDocRow =
      text.includes("Proof of Degree") || text.includes("Final Official Transcript");

    return hasChecklist && hasUniversityId && hasRequiredDocRow;
  }, { timeout: 15_000 });
}

async function extractRelevantChecklistRows(slatePage) {
  return slatePage.evaluate(() => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const subjectPatterns = [/^Proof of Degree$/i, /^Final Official Transcript\b/i];
    const visibleChecklistTable = Array.from(document.querySelectorAll("table.checklist_table"))
      .find((table) => {
        const panel = table.closest("div");
        return Boolean(table) && Boolean(panel) && panel.offsetParent !== null;
      });

    if (!visibleChecklistTable) {
      return [];
    }

    return Array.from(visibleChecklistTable.querySelectorAll("tbody tr[data-id]"))
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("td"));
        const subject = normalize(cells[2]?.textContent || "");
        const section = normalize(cells[3]?.textContent || "");
        const statusSelect = row.querySelector("select.checklist_status_select");
        const selectedStatus = normalize(statusSelect?.selectedOptions?.[0]?.textContent || "");
        const statusValue = normalize(statusSelect?.value || "");
        const dataLast = normalize(statusSelect?.getAttribute("data-last") || "");
        const status = selectedStatus || dataLast || statusValue || "Awaiting";

        return {
          subject,
          section,
          status,
          statusValue,
          dataLast,
          rowClass: row.className || "",
          rawText: normalize(row.textContent || ""),
        };
      })
      .filter((row) => subjectPatterns.some((pattern) => pattern.test(row.subject)));
  });
}

function isChecklistRowSatisfied(row) {
  const status = (row.status || "").trim().toLowerCase();
  const rowClass = (row.rowClass || "").toLowerCase();

  if (rowClass.includes("checklist_missing")) {
    return false;
  }

  if (["awaiting", "missing", "hide", "scan..."].includes(status)) {
    return false;
  }

  if (["received", "received copy", "waived", "complete", "completed", "satisfied"].includes(status)) {
    return true;
  }

  if (rowClass.includes("checklist_received")) {
    return true;
  }

  return false;
}

function buildAuditNotes(proofOfDegree, finalOfficialTranscriptRows) {
  const notes = [];
  if (!proofOfDegree) {
    notes.push("Proof of Degree row was not found.");
  }
  if (finalOfficialTranscriptRows.length === 0) {
    notes.push("No Final Official Transcript rows were found.");
  }
  return notes;
}

function mapAuditStatus(audit) {
  if (audit.fotSatisfied && audit.podSatisfied) {
    return APP_STATUS.complete;
  }

  if (audit.fotSatisfied && !audit.podSatisfied) {
    return APP_STATUS.fotOnly;
  }

  if (!audit.fotSatisfied && audit.podSatisfied) {
    return APP_STATUS.podOnly;
  }

  return APP_STATUS.missing;
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

async function writeRunReport(sheetInfo, results, options) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const reportPath = path.join(reportsDir, `audit-report-${sheetInfo.gid}-${timestamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    columns: {
      nColumn: options.nColumn,
      statusColumn: options.statusColumn,
    },
    sheetUrl: sheetInfo.rawUrl,
    results,
  };

  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

async function writeStatusesToSheet(sheetPage, sheetInfo, options, results) {
  await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, `${options.statusColumn}2`));
  const currentRows = await fetchSheetRows(sheetPage, sheetInfo, options);
  const currentRowsByNumber = new Map(currentRows.map((row) => [row.rowNumber, row]));
  const failures = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result.appStatus) {
      continue;
    }

    const existingValue = currentRowsByNumber.get(result.rowNumber)?.originalStatus ?? "";
    if (existingValue === result.appStatus) {
      console.log(`[Write ${index + 1}/${results.length}] Already matched row ${result.rowNumber} -> ${result.appStatus}`);
      continue;
    }

    let wroteRow = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await selectRange(sheetPage, `${options.statusColumn}${result.rowNumber}`);
      await writeFormulaValue(sheetPage, result.appStatus);
      const committed = await waitForSheetValue(
        sheetPage,
        sheetInfo,
        options,
        result.rowNumber,
        result.appStatus,
        4_000,
      );
      if (committed) {
        currentRowsByNumber.set(result.rowNumber, {
          rowNumber: result.rowNumber,
          name: result.name,
          nNumber: result.nNumber,
          originalStatus: result.appStatus,
        });
        console.log(`[Write ${index + 1}/${results.length}] Wrote row ${result.rowNumber} -> ${result.appStatus}`);
        wroteRow = true;
        break;
      }

      const currentUrl = sheetPage.url();
      if (!currentUrl.includes(`/spreadsheets/d/${sheetInfo.sheetId}/`)) {
        await safeSheetGoto(sheetPage, makeSheetRangeUrl(sheetInfo, `${options.statusColumn}${result.rowNumber}`));
      }

      await delay(500);
    }

    if (!wroteRow) {
      console.log(`[Write ${index + 1}/${results.length}] Could not verify row ${result.rowNumber} -> ${result.appStatus}`);
      failures.push({
        rowNumber: result.rowNumber,
        expected: result.appStatus,
        actual: currentRowsByNumber.get(result.rowNumber)?.originalStatus ?? "",
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

async function waitForSheetValue(sheetPage, sheetInfo, options, rowNumber, expectedValue, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = await fetchSheetRows(sheetPage, sheetInfo, options);
    const currentValue = rows.find((row) => row.rowNumber === rowNumber)?.originalStatus ?? "";
    if (currentValue === expectedValue) {
      return true;
    }

    await delay(500);
  }

  return false;
}

function verifyWriteBack(sheetRows, expectedResults) {
  const rowsByNumber = new Map(sheetRows.map((row) => [row.rowNumber, row]));
  return expectedResults
    .map((result) => {
      const actual = rowsByNumber.get(result.rowNumber)?.originalStatus ?? "";
      return {
        rowNumber: result.rowNumber,
        expected: result.appStatus,
        actual,
      };
    })
    .filter((result) => result.expected !== result.actual);
}

function mergeWriteFailures(writeFailures, verificationFailures) {
  const merged = new Map();

  for (const failure of [...writeFailures, ...verificationFailures]) {
    merged.set(failure.rowNumber, failure);
  }

  return [...merged.values()].sort((left, right) => left.rowNumber - right.rowNumber);
}

main().catch((error) => {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
