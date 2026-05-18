import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(__dirname, "ui");
const port = Number(process.env.PORT || 4318);

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
    nColumn: "D",
    statusColumn: "E",
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

  const reportMatch = text.match(/Saved audit report to (.+\.json)/);
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

  const progressMatch = text.match(/^\[(\d+)\/(\d+)\] Auditing row (\d+) \(([^)]+)\)$/);
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
    nColumn: validateColumnRef(input.nColumn, "D"),
    statusColumn: validateColumnRef(input.statusColumn, "E"),
    browser: input.browser === "chrome" ? "chrome" : "brave",
    limit: input.limit ? String(input.limit).trim() : "",
    rowFrom: input.rowFrom ? String(input.rowFrom).trim() : "",
    rowTo: input.rowTo ? String(input.rowTo).trim() : "",
    overwrite: false,
    dryRun: Boolean(input.dryRun),
    reportPath: input.reportPath ? String(input.reportPath).trim() : "",
  };
}

function buildAuditArgs(config, mode) {
  if (!config.sheetUrl) {
    throw new Error("Spreadsheet URL is required.");
  }

  const args = [
    path.join(projectRoot, "src", "audit.mjs"),
    "--sheet-url",
    config.sheetUrl,
    "--n-column",
    config.nColumn,
    "--status-column",
    config.statusColumn,
    "--browser",
    config.browser,
  ];

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

  if (config.overwrite) {
    args.push("--overwrite");
  }

  if (config.dryRun) {
    args.push("--dry-run");
  }

  return args;
}

function startRun(mode, config) {
  if (activeRun) {
    throw new Error("Another audit run is already active. Stop it or wait for it to finish.");
  }

  const args = buildAuditArgs(config, mode);
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
      error: stoppedByUser ? null : code === 0 ? null : `Audit process exited with code ${code}${signal ? ` (${signal})` : ""}.`,
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
