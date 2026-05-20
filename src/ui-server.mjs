import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(__dirname, "ui");
const port = Number(process.env.PORT || 4318);
const browserProfileDir = path.join(projectRoot, ".browser-profile");
const browserPort = 9222;

const STATUS_DEFINITIONS = {
  missing: {
    full: "Missing Required Docs - Needs to Stay on List",
    short: "Missing docs",
  },
  complete: {
    full: "FOT and POD are satisfied - Enrollment Audit Complete",
    short: "Audit complete",
  },
  fotOnly: {
    full: "FOT is satisfied | POD is unsatisfied - Needs to Stay on List",
    short: "FOT only",
  },
  podOnly: {
    full: "POD satisfied | FOT unsatisfied - Needs to Stay on List",
    short: "POD only",
  },
};

const STATUS_KEY_BY_TEXT = new Map(
  Object.entries(STATUS_DEFINITIONS).map(([key, value]) => [value.full, key]),
);

function createEmptySummary() {
  return {
    missing: 0,
    complete: 0,
    fotOnly: 0,
    podOnly: 0,
  };
}

const state = {
  status: "idle",
  mode: null,
  awaitingAction: null,
  logs: [],
  progress: null,
  recentResults: [],
  reportPath: null,
  error: null,
  summary: createEmptySummary(),
  startedAt: null,
  finishedAt: null,
  lastCommand: null,
  lastConfig: {
    sheetUrl: "",
    sheetTab: "",
    nColumn: "D",
    statusColumn: "E",
    commentColumn: "F",
    auditColumn: "G",
    browser: "brave",
    limit: "",
    rowFrom: "",
    rowTo: "",
  },
  writeProgress: null,
};

let activeRun = null;
let stoppedByUser = false;
let currentAuditRow = null;
const sseClients = new Set();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function appendLog(text) {
  if (!text) {
    return;
  }

  state.logs.push(text);
  if (state.logs.length > 400) {
    state.logs.splice(0, state.logs.length - 400);
  }

  broadcast("log", { text });
}

function inspectChunkOutput(text) {
  if (text.includes("Press Enter here when both pages are ready...")) {
    updateState({
      status: "waiting",
      awaitingAction: {
        type: "browserReady",
        title: "Are Google Sheets and Slate open?",
        description: "If both pages are open and ready in the browser window, continue here.",
        buttonLabel: "Yes, both are open",
      },
    });
  }

  if (text.includes("Press Enter to write the results into Google Sheets...")) {
    updateState({
      status: "waiting",
      awaitingAction: {
        type: "writeConfirm",
        title: "Ready To Write",
        description: "The audit is finished and the results are ready to be written into Google Sheets.",
        buttonLabel: "Write To Sheet",
      },
    });
  }

  if (text.includes("Writing results to Google Sheets...")) {
    updateState({
      status: "running",
      awaitingAction: null,
      writeProgress: {
        current: 0,
        total: state.progress?.total ?? 0,
        rowNumber: null,
        statusKey: null,
        statusText: null,
      },
    });
  }

  const reportMatch = text.match(/Saved (?:audit|transcript-sync) report to (.+\.json)/);
  if (reportMatch) {
    updateState({ reportPath: reportMatch[1].trim() });
  }

  const foundMatch = text.match(/Found (\d+) row\(s\) to audit\./);
  if (foundMatch) {
    updateState({
      progress: {
        current: 0,
        total: Number(foundMatch[1]),
        rowNumber: null,
        nNumber: null,
      },
    });
  }

  const transcriptFoundMatch = text.match(/Found (\d+) applicant\(s\) to inspect for exact "Final Official Transcript" materials\./);
  if (transcriptFoundMatch) {
    updateState({
      progress: {
        current: 0,
        total: Number(transcriptFoundMatch[1]),
        rowNumber: null,
        nNumber: null,
      },
    });
  }

  const admitSendFoundMatch = text.match(/Found (\d+) applicant\(s\) ready for the final Reader send step\./);
  if (admitSendFoundMatch) {
    updateState({
      progress: {
        current: 0,
        total: Number(admitSendFoundMatch[1]),
        rowNumber: null,
        nNumber: null,
      },
    });
  }

  const loadedMatch = text.match(/Loaded (\d+) row\(s\) from the report\./);
  if (loadedMatch) {
    updateState({
      progress: {
        current: 0,
        total: Number(loadedMatch[1]),
        rowNumber: null,
        nNumber: null,
      },
    });
  }
}

function inspectLogLine(rawLine) {
  const text = rawLine.trim();
  if (!text) {
    return;
  }

  const progressMatch = text.match(/^\[(\d+)\/(\d+)\] (?:Auditing|Syncing) row (\d+) \(([^)]+)\)$/);
  if (progressMatch) {
    currentAuditRow = {
      current: Number(progressMatch[1]),
      total: Number(progressMatch[2]),
      rowNumber: Number(progressMatch[3]),
      nNumber: progressMatch[4],
    };
    updateState({
      status: "running",
      awaitingAction: null,
      progress: {
        ...currentAuditRow,
      },
    });
    return;
  }

  const admitSendMatch = text.match(/^-> (.+?) \[(Preview|Sent|Not sent)\] (.+)$/);
  if (admitSendMatch && currentAuditRow && state?.mode === "admitSend") {
    const applicantLabel = admitSendMatch[1].trim();
    const verb = admitSendMatch[2];
    const actionSummary = admitSendMatch[3].trim();
    const recentResults = upsertRecentResult(state.recentResults, {
      rowNumber: currentAuditRow.rowNumber,
      nNumber: currentAuditRow.nNumber,
      statusKey: "neutral",
      statusText: actionSummary,
      shortLabel: applicantLabel,
      written: verb === "Sent",
    });

    updateState({ recentResults });
    currentAuditRow = null;
    return;
  }

  const decisionMatch = text.match(/^-> (.+)$/);
  if (decisionMatch && currentAuditRow) {
    const statusText = decisionMatch[1].trim();
    const statusKey = STATUS_KEY_BY_TEXT.get(statusText);

    if (statusKey) {
      const summary = {
        ...state.summary,
        [statusKey]: state.summary[statusKey] + 1,
      };

      const recentResults = upsertRecentResult(state.recentResults, {
        rowNumber: currentAuditRow.rowNumber,
        nNumber: currentAuditRow.nNumber,
        statusKey,
        statusText,
        shortLabel: STATUS_DEFINITIONS[statusKey].short,
        written: false,
      });

      updateState({ summary, recentResults });
    }

    currentAuditRow = null;
    return;
  }

  const writeMatch = text.match(/^\[Write (\d+)\/(\d+)\] (Wrote|Already matched|Could not verify) row (\d+) -> (.+)$/);
  if (writeMatch) {
    const current = Number(writeMatch[1]);
    const total = Number(writeMatch[2]);
    const verb = writeMatch[3];
    const rowNumber = Number(writeMatch[4]);
    const statusText = writeMatch[5].trim();
    const statusKey = STATUS_KEY_BY_TEXT.get(statusText) ?? null;
    const recentResults = upsertRecentResult(state.recentResults, {
      rowNumber,
      nNumber: state.recentResults.find((item) => item.rowNumber === rowNumber)?.nNumber ?? "",
      statusKey,
      statusText,
      shortLabel: statusKey ? STATUS_DEFINITIONS[statusKey].short : statusText,
      written: verb !== "Could not verify",
    });

    updateState({
      status: "running",
      writeProgress: {
        current,
        total,
        rowNumber,
        statusKey,
        statusText,
        verb,
      },
      recentResults,
    });
    return;
  }
}

function upsertRecentResult(results, nextItem) {
  const existing = results.find((item) => item.rowNumber === nextItem.rowNumber);
  const merged = existing
    ? { ...existing, ...nextItem }
    : nextItem;
  const remaining = results.filter((item) => item.rowNumber !== nextItem.rowNumber);
  return [merged, ...remaining].slice(0, 3);
}

function shortReportPath(value) {
  if (!value) {
    return null;
  }

  return path.basename(value);
}

function updateState(patch) {
  Object.assign(state, patch);
  broadcast("state", serializeState());
}

function serializeState() {
  return {
    status: state.status,
    mode: state.mode,
    awaitingAction: state.awaitingAction,
    logs: state.logs,
    progress: state.progress,
    recentResults: state.recentResults,
    reportPath: shortReportPath(state.reportPath),
    error: state.error,
    summary: state.summary,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    lastCommand: state.lastCommand,
    lastConfig: state.lastConfig,
    writeProgress: state.writeProgress,
  };
}

function broadcast(event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function validateColumnRef(value, fallback) {
  const normalized = String(value || fallback || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error("Column values must look like D or AA.");
  }
  return normalized;
}

function normalizeConfig(input) {
  return {
    sheetUrl: String(input.sheetUrl || "").trim(),
    sheetTab: String(input.sheetTab || "").trim(),
    nColumn: validateColumnRef(input.nColumn, "D"),
    statusColumn: validateColumnRef(input.statusColumn, "E"),
    commentColumn: validateColumnRef(input.commentColumn, "F"),
    auditColumn: validateColumnRef(input.auditColumn, "G"),
    browser: input.browser === "chrome" ? "chrome" : "brave",
    limit: input.limit ? String(input.limit).trim() : "",
    rowFrom: input.rowFrom ? String(input.rowFrom).trim() : "",
    rowTo: input.rowTo ? String(input.rowTo).trim() : "",
    overwrite: false,
    dryRun: Boolean(input.dryRun),
    reportPath: input.reportPath ? String(input.reportPath).trim() : "",
  };
}

function buildRunArgs(config, mode) {
  if (!config.sheetUrl) {
    throw new Error("Spreadsheet URL is required.");
  }

  const scriptPath = mode === "transcriptSync"
    ? path.join(projectRoot, "src", "transcript-sync.mjs")
    : mode === "admitSend"
      ? path.join(projectRoot, "src", "admit-send.mjs")
      : path.join(projectRoot, "src", "audit.mjs");

  const args = [
    scriptPath,
    "--sheet-url",
    config.sheetUrl,
    "--n-column",
    config.nColumn,
    "--status-column",
    config.statusColumn,
    "--browser",
    config.browser,
  ];

  if (config.sheetTab) {
    args.push("--sheet-tab", config.sheetTab);
  }

  if (mode === "transcriptSync") {
    args.push("--comment-column", config.commentColumn);
  }

  if (mode === "admitSend") {
    args.push("--audit-column", config.auditColumn);
  }

  if (mode === "setup") {
    args.push("--setup-only");
    return args;
  }

  if (config.limit) {
    args.push("--limit", config.limit);
  }

  if (config.rowFrom) {
    args.push("--row-from", config.rowFrom);
  }

  if (config.rowTo) {
    args.push("--row-to", config.rowTo);
  }

  if (config.reportPath) {
    args.push("--report", config.reportPath);
  }

  if (mode === "audit" && config.overwrite) {
    args.push("--overwrite");
  }

  if (mode === "transcriptSync") {
    args.push("--save");
  }

  if (mode === "admitSend") {
    args.push("--save");
  }

  if (mode === "audit" && config.dryRun) {
    args.push("--dry-run");
  }

  return args;
}

function parseSheetUrl(sheetUrl) {
  const url = new URL(sheetUrl);
  const match = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) {
    throw new Error("Could not parse the Google Sheet id from the provided URL.");
  }

  return {
    rawUrl: sheetUrl,
    sheetId: match[1],
  };
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

async function isJsonEndpointReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBrowserLaunched(browserName, debugPort) {
  const executablePath = getBrowserExecutable(browserName);
  const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;

  if (await isJsonEndpointReady(versionUrl)) {
    return;
  }

  spawn(executablePath, [
    `--remote-debugging-port=${debugPort}`,
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

  throw new Error(`Could not connect to the browser on port ${debugPort}.`);
}

function normalizeSheetTabName(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^\d+/, "").trim();
}

async function loadSheetTabs(config) {
  const sheetInfo = parseSheetUrl(config.sheetUrl);
  await ensureBrowserLaunched(config.browser, browserPort);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    try {
      await page.goto(sheetInfo.rawUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded");
      await delay(2_000);

      const payload = await page.evaluate(() => {
        const normalize = (value) => value.replace(/\s+/g, " ").replace(/^\d+/, "").trim();
        const tabs = Array.from(document.querySelectorAll(".docs-sheet-tab"))
          .map((tab) => {
            const nameNode = tab.querySelector(".docs-sheet-tab-name");
            const name = normalize(nameNode?.textContent || tab.textContent || "");
            if (!name) {
              return null;
            }

            return {
              name,
              active: tab.classList.contains("docs-sheet-active-tab"),
            };
          })
          .filter(Boolean);

        return {
          title: document.title,
          tabs,
          currentUrl: window.location.href,
        };
      });

      const uniqueTabs = [];
      const seen = new Set();
      for (const tab of payload.tabs) {
        const key = normalizeSheetTabName(tab.name).toLowerCase();
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        uniqueTabs.push(tab);
      }

      return {
        tabs: uniqueTabs,
        activeTab: uniqueTabs.find((tab) => tab.active)?.name ?? "",
        title: payload.title,
        currentUrl: payload.currentUrl,
      };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

function startRun(mode, config) {
  if (activeRun) {
    throw new Error("Another run is already active. Stop it or wait for it to finish.");
  }

  const args = buildRunArgs(config, mode);
  stoppedByUser = false;
  state.logs = [];
  currentAuditRow = null;

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  activeRun = child;
  updateState({
    status: "running",
    mode,
    awaitingAction: null,
    progress: null,
    recentResults: [],
    reportPath: null,
    error: null,
    summary: createEmptySummary(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastCommand: [process.execPath, ...args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))].join(" "),
    lastConfig: config,
    writeProgress: null,
  });

  const stdoutHandle = createStreamHandler("stdout");
  const stderrHandle = createStreamHandler("stderr");
  child.stdout.on("data", stdoutHandle);
  child.stderr.on("data", stderrHandle);

  child.on("exit", (code, signal) => {
    activeRun = null;
    updateState({
      status: stoppedByUser ? "stopped" : code === 0 ? "completed" : "failed",
      awaitingAction: null,
      finishedAt: new Date().toISOString(),
      error: stoppedByUser ? null : code === 0 ? null : `Process exited with code ${code}${signal ? ` (${signal})` : ""}.`,
    });
  });
}

function createStreamHandler(source) {
  let buffer = "";

  return (chunk) => {
    const text = normalizeLineEndings(chunk.toString("utf8"));
    appendLog(text);
    buffer += text;
    inspectChunkOutput(buffer);

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      inspectLogLine(line);
    }

    if (source === "stderr" && text.trim()) {
      updateState({ error: text.trim() });
    }
  };
}

function stopRun() {
  if (!activeRun) {
    return false;
  }

  stoppedByUser = true;
  activeRun.kill("SIGTERM");
  setTimeout(() => {
    if (activeRun) {
      activeRun.kill("SIGKILL");
    }
  }, 1_500).unref();
  return true;
}

async function serveStaticFile(response, relativePath, contentType) {
  const filePath = path.join(uiRoot, relativePath);
  const body = await fs.readFile(filePath);
  response.writeHead(200, { "Content-Type": contentType });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/") {
      await serveStaticFile(response, "index.html", "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      await serveStaticFile(response, "app.js", "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/styles.css") {
      await serveStaticFile(response, "styles.css", "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, serializeState());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(`event: state\ndata: ${JSON.stringify(serializeState())}\n\n`);
      sseClients.add(response);
      request.on("close", () => {
        sseClients.delete(response);
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/run") {
      const body = normalizeConfig(await readRequestBody(request));
      startRun("audit", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/transcript-sync") {
      const body = normalizeConfig(await readRequestBody(request));
      startRun("transcriptSync", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admit-send") {
      const body = normalizeConfig(await readRequestBody(request));
      startRun("admitSend", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sheet-tabs") {
      const body = normalizeConfig(await readRequestBody(request));
      if (!body.sheetUrl) {
        throw new Error("Spreadsheet URL is required.");
      }
      const tabs = await loadSheetTabs(body);
      sendJson(response, 200, { ok: true, ...tabs });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/setup") {
      const body = normalizeConfig(await readRequestBody(request));
      startRun("setup", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/respond") {
      if (!activeRun) {
        sendJson(response, 409, { ok: false, error: "No active run is waiting for input." });
        return;
      }
      activeRun.stdin.write("\n");
      updateState({ status: "running", awaitingAction: null });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/stop") {
      const stopped = stopRun();
      sendJson(response, stopped ? 200 : 409, { ok: stopped, error: stopped ? null : "No active run to stop." });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. If the UI is already open, keep using it. Otherwise stop the old server and run "npm run ui" again.`);
    process.exit(1);
  }

  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Slate Audit UI is running at http://127.0.0.1:${port}`);
});
