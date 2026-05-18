const form = document.querySelector("#audit-form");
const stopButton = document.querySelector("#stopButton");
const actionCard = document.querySelector("#actionCard");
const actionButton = document.querySelector("#actionButton");
const actionTitle = document.querySelector("#actionTitle");
const actionDescription = document.querySelector("#actionDescription");
const consoleOutput = document.querySelector("#consoleOutput");
const runStatusPill = document.querySelector("#run-status-pill");
const heroStatusText = document.querySelector("#hero-status-text");
const heroProgressText = document.querySelector("#hero-progress-text");
const progressLabel = document.querySelector("#progress-label");
const progressDetail = document.querySelector("#progress-detail");
const progressFill = document.querySelector("#progress-fill");
const resultsHeadline = document.querySelector("#resultsHeadline");
const recentResultsList = document.querySelector("#recentResults");
const summaryCounts = {
  missing: document.querySelector("#count-missing"),
  complete: document.querySelector("#count-complete"),
  fotOnly: document.querySelector("#count-fotOnly"),
  podOnly: document.querySelector("#count-podOnly"),
};

const fields = {
  sheetUrl: document.querySelector("#sheetUrl"),
  nColumn: document.querySelector("#nColumn"),
  statusColumn: document.querySelector("#statusColumn"),
  browser: document.querySelector("#browser"),
  limit: document.querySelector("#limit"),
  rowFrom: document.querySelector("#rowFrom"),
  rowTo: document.querySelector("#rowTo"),
};

const STORAGE_KEY = "slate-audit-ui-config";
let currentState = null;
let eventSource = null;

function loadSavedConfig() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function getConfigFromForm() {
  return {
    sheetUrl: fields.sheetUrl.value.trim(),
    nColumn: fields.nColumn.value.trim().toUpperCase() || "D",
    statusColumn: fields.statusColumn.value.trim().toUpperCase() || "E",
    browser: fields.browser.value,
    limit: fields.limit.value.trim(),
    rowFrom: fields.rowFrom.value.trim(),
    rowTo: fields.rowTo.value.trim(),
  };
}

function applyConfigToForm(config) {
  fields.sheetUrl.value = config.sheetUrl || "";
  fields.nColumn.value = config.nColumn || "D";
  fields.statusColumn.value = config.statusColumn || "E";
  fields.browser.value = config.browser || "brave";
  fields.limit.value = config.limit || "";
  fields.rowFrom.value = config.rowFrom || "";
  fields.rowTo.value = config.rowTo || "";
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Request failed.");
  }

  return body;
}

async function refreshState() {
  const response = await fetch("/api/state");
  const state = await response.json();
  applyState(state, { replaceLogBuffer: true });
}

function appendLog(text) {
  consoleOutput.textContent += text;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function replaceLogs(logs) {
  consoleOutput.textContent = Array.isArray(logs) ? logs.join("") : "";
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function formatRecentLabel(item) {
  const rowPart = item.rowNumber ? `Row ${item.rowNumber}` : "Row";
  return item.nNumber ? `${rowPart} · ${item.nNumber}` : rowPart;
}

function formatStatus(status) {
  switch (status) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Idle";
  }
}

function updateProgress(progress) {
  if (currentState?.writeProgress?.total) {
    const writeProgress = currentState.writeProgress;
    if (currentState?.status === "completed") {
      progressLabel.textContent = "Results saved to Google Sheets";
      progressDetail.textContent = `${writeProgress.current} result${writeProgress.current === 1 ? "" : "s"} were written successfully.`;
      heroProgressText.textContent = "Done";
      progressFill.style.width = "100%";
      return;
    }

    const ratio = Math.max(0, Math.min(100, Math.round((writeProgress.current / writeProgress.total) * 100)));
    progressLabel.textContent = `Writing ${writeProgress.current} of ${writeProgress.total} results`;
    progressDetail.textContent = writeProgress.rowNumber
      ? `Saving row ${writeProgress.rowNumber} into Google Sheets.`
      : "Sending results into Google Sheets.";
    heroProgressText.textContent = `${writeProgress.current}/${writeProgress.total}`;
    progressFill.style.width = `${ratio}%`;
    return;
  }

  if (currentState?.status === "running" && currentState?.mode === "setup") {
    progressLabel.textContent = "Opening sign-in pages";
    progressDetail.textContent = "If Google Sheets or Slate asks you to log in, finish that in the browser window.";
    heroProgressText.textContent = "Opening";
    progressFill.style.width = "16%";
    return;
  }

  if (!progress || !progress.total) {
    if (currentState?.status === "waiting") {
      progressLabel.textContent = "Waiting for your confirmation";
      progressDetail.textContent = currentState?.awaitingAction?.description || "Finish the step in the browser, then continue here.";
      heroProgressText.textContent = "Waiting on you";
      progressFill.style.width = "12%";
      return;
    }

    if (currentState?.status === "completed" && currentState?.mode === "setup") {
      progressLabel.textContent = "Sign-in pages are ready";
      progressDetail.textContent = "Your browser session is saved. You can start the audit whenever you are ready.";
      heroProgressText.textContent = "Ready";
      progressFill.style.width = "100%";
      return;
    }

    progressLabel.textContent = currentState?.status === "completed" ? "Run complete" : "No active run";
    progressDetail.textContent = currentState?.error || "Start a run from the left panel.";
    heroProgressText.textContent = currentState?.status === "completed" ? "Finished" : "Waiting to start";
    progressFill.style.width = "0%";
    return;
  }

  const ratio = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
  progressLabel.textContent = `${progress.current} of ${progress.total} rows`;
  progressDetail.textContent = progress.rowNumber
    ? `Currently touching row ${progress.rowNumber}${progress.nNumber ? ` (${progress.nNumber})` : ""}.`
    : `Prepared for ${progress.total} rows.`;
  heroProgressText.textContent = `${progress.current}/${progress.total}`;
  progressFill.style.width = `${ratio}%`;
}

function renderSummary(summary = {}) {
  for (const [key, element] of Object.entries(summaryCounts)) {
    element.textContent = String(summary[key] ?? 0);
  }
}

function renderRecentResults(results = []) {
  if (!results.length) {
    resultsHeadline.textContent = "No rows processed yet";
    recentResultsList.innerHTML = `
      <li class="results-empty">Live decisions will appear here as the audit runs.</li>
    `;
    return;
  }

  resultsHeadline.textContent = `Last ${results.length} row${results.length === 1 ? "" : "s"}`;
  recentResultsList.innerHTML = results
    .map((item) => `
      <li class="result-item">
        <div class="result-main">
          <strong>${formatRecentLabel(item)}</strong>
          <span>${item.shortLabel || item.statusText}</span>
        </div>
        <div class="result-tags">
          <span class="result-chip result-chip-${item.statusKey || "neutral"}">${item.shortLabel || "Updated"}</span>
          ${item.written ? '<span class="result-chip result-chip-written">Saved</span>' : ""}
        </div>
      </li>
    `)
    .join("");
}

function updateActionCard(action) {
  if (!action) {
    actionCard.classList.add("hidden");
    return;
  }

  actionTitle.textContent = action.title;
  actionDescription.textContent = action.description;
  actionButton.textContent = action.buttonLabel;
  actionCard.classList.remove("hidden");
}

function applyState(state, options = {}) {
  currentState = state;

  if (!document.activeElement || document.activeElement.tagName !== "INPUT") {
    applyConfigToForm(state.lastConfig || loadSavedConfig());
  }

  runStatusPill.textContent = formatStatus(state.status);
  heroStatusText.textContent = formatStatus(state.status);

  if (options.replaceLogBuffer && state.logs) {
    replaceLogs(state.logs);
  }

  updateProgress(state.progress);
  updateActionCard(state.awaitingAction);
  renderSummary(state.summary);
  renderRecentResults(state.recentResults);

  const busy = state.status === "running" || state.status === "waiting";
  stopButton.disabled = !busy;
  stopButton.classList.toggle("hidden", !busy);
  form.querySelector("#runButton").disabled = busy;
}

function connectEvents() {
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("state", (event) => {
    applyState(JSON.parse(event.data), { replaceLogBuffer: false });
  });
  eventSource.addEventListener("log", (event) => {
    const { text } = JSON.parse(event.data);
    appendLog(text);
  });
}

async function startRun(mode, overrides = {}) {
  const config = {
    ...getConfigFromForm(),
    ...overrides,
  };

  saveConfig(config);
  const endpoint = mode === "setup" ? "/api/setup" : "/api/run";
  await postJson(endpoint, config);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await startRun("audit");
  } catch (error) {
    alert(error.message);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await postJson("/api/stop");
  } catch (error) {
    alert(error.message);
  }
});

actionButton.addEventListener("click", async () => {
  try {
    await postJson("/api/respond");
  } catch (error) {
    alert(error.message);
  }
});

applyConfigToForm(loadSavedConfig());
refreshState().catch(() => {});
connectEvents();
