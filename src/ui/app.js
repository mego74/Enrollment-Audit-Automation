const form = document.querySelector("#audit-form");
const stopButton = document.querySelector("#stopButton");
const transcriptRunButton = document.querySelector("#transcriptRunButton");
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
  sheetTab: document.querySelector("#sheetTab"),
  nColumn: document.querySelector("#nColumn"),
  statusColumn: document.querySelector("#statusColumn"),
  commentColumn: document.querySelector("#commentColumn"),
  browser: document.querySelector("#browser"),
  limit: document.querySelector("#limit"),
  rowFrom: document.querySelector("#rowFrom"),
  rowTo: document.querySelector("#rowTo"),
};

const STORAGE_KEY = "slate-audit-ui-config";
let currentState = null;
let eventSource = null;
let tabLoadTimer = null;
let loadedSheetTabsKey = "";

const DEFAULT_SHEET_TAB_LABEL = "Current sheet in link";
const LOADING_SHEET_TAB_LABEL = "Loading sheet tabs...";
const EMPTY_SHEET_TAB_LABEL = "No sheet tabs found";

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setSheetTabOptions(tabs = [], selectedValue = "", placeholderLabel = DEFAULT_SHEET_TAB_LABEL) {
  const previousValue = selectedValue || fields.sheetTab.dataset.requestedValue || fields.sheetTab.value || "";
  const options = [
    `<option value="">${escapeHtml(placeholderLabel)}</option>`,
    ...tabs.map((tab) => `<option value="${escapeHtml(tab.name)}">${escapeHtml(tab.name)}</option>`),
  ];

  fields.sheetTab.innerHTML = options.join("");
  const activeTab = tabs.find((tab) => tab.active)?.name || "";
  const preferredValue = tabs.some((tab) => tab.name === previousValue)
    ? previousValue
    : activeTab;
  fields.sheetTab.value = preferredValue;
  fields.sheetTab.dataset.requestedValue = preferredValue;
}

function setSheetTabLoading(isLoading) {
  fields.sheetTab.disabled = isLoading;
  if (isLoading) {
    setSheetTabOptions([], fields.sheetTab.value, LOADING_SHEET_TAB_LABEL);
  }
}

function getSheetTabLoadKey() {
  return `${fields.browser.value}::${fields.sheetUrl.value.trim()}`;
}

function getConfigFromForm() {
  return {
    sheetUrl: fields.sheetUrl.value.trim(),
    sheetTab: fields.sheetTab.value.trim(),
    nColumn: fields.nColumn.value.trim().toUpperCase() || "D",
    statusColumn: fields.statusColumn.value.trim().toUpperCase() || "E",
    commentColumn: fields.commentColumn.value.trim().toUpperCase() || "F",
    browser: fields.browser.value,
    limit: fields.limit.value.trim(),
    rowFrom: fields.rowFrom.value.trim(),
    rowTo: fields.rowTo.value.trim(),
  };
}

function applyConfigToForm(config) {
  fields.sheetUrl.value = config.sheetUrl || "";
  if (config.sheetTab) {
    const hasOption = Array.from(fields.sheetTab.options).some((option) => option.value === config.sheetTab);
    if (!hasOption) {
      setSheetTabOptions([{ name: config.sheetTab, active: false }], config.sheetTab, DEFAULT_SHEET_TAB_LABEL);
    }
    fields.sheetTab.value = config.sheetTab;
  } else if (!fields.sheetTab.options.length) {
    setSheetTabOptions();
  }
  fields.sheetTab.dataset.requestedValue = config.sheetTab || "";
  fields.nColumn.value = config.nColumn || "D";
  fields.statusColumn.value = config.statusColumn || "E";
  fields.commentColumn.value = config.commentColumn || "F";
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

async function loadSheetTabs({ silent = true } = {}) {
  const sheetUrl = fields.sheetUrl.value.trim();
  if (!sheetUrl) {
    loadedSheetTabsKey = "";
    setSheetTabOptions([], "", DEFAULT_SHEET_TAB_LABEL);
    return;
  }

  setSheetTabLoading(true);
  try {
    const response = await postJson("/api/sheet-tabs", {
      sheetUrl,
      browser: fields.browser.value,
    });

    if (response.tabs?.length) {
      const requestedValue = fields.sheetTab.dataset.requestedValue || "";
      const defaultValue = requestedValue || response.activeTab || "";
      setSheetTabOptions(response.tabs, defaultValue, DEFAULT_SHEET_TAB_LABEL);
      loadedSheetTabsKey = getSheetTabLoadKey();
      return;
    }

    loadedSheetTabsKey = getSheetTabLoadKey();
    setSheetTabOptions([], "", EMPTY_SHEET_TAB_LABEL);
  } catch (error) {
    loadedSheetTabsKey = "";
    setSheetTabOptions([], "", DEFAULT_SHEET_TAB_LABEL);
    if (!silent) {
      alert(error.message);
    }
  } finally {
    fields.sheetTab.disabled = false;
  }
}

function scheduleSheetTabLoad() {
  window.clearTimeout(tabLoadTimer);
  tabLoadTimer = window.setTimeout(() => {
    loadSheetTabs({ silent: true }).catch(() => {});
  }, 500);
}

function resetSheetTabDropdown() {
  loadedSheetTabsKey = "";
  fields.sheetTab.dataset.requestedValue = "";
  setSheetTabOptions([], "", DEFAULT_SHEET_TAB_LABEL);
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

function formatMode(mode) {
  if (mode === "transcriptSync") {
    return "FOT Check";
  }
  if (mode === "setup") {
    return "Sign-in Setup";
  }
  return "Audit";
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

  if (currentState?.mode === "transcriptSync" && progress?.total) {
    const ratio = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
    progressLabel.textContent = `${progress.current} of ${progress.total} applicants`;
    progressDetail.textContent = progress.rowNumber
      ? `Checking applicant on row ${progress.rowNumber}${progress.nNumber ? ` (${progress.nNumber})` : ""}.`
      : `Prepared for ${progress.total} applicants.`;
    heroProgressText.textContent = `${progress.current}/${progress.total}`;
    progressFill.style.width = `${ratio}%`;
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
  heroStatusText.textContent = `${formatMode(state.mode)} · ${formatStatus(state.status)}`;

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
  transcriptRunButton.disabled = busy;
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
  const endpoint = mode === "setup"
    ? "/api/setup"
    : mode === "transcriptSync"
      ? "/api/transcript-sync"
      : "/api/run";
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

transcriptRunButton.addEventListener("click", async () => {
  try {
    await startRun("transcriptSync");
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

fields.sheetUrl.addEventListener("input", () => {
  window.clearTimeout(tabLoadTimer);
  resetSheetTabDropdown();
});

fields.browser.addEventListener("change", () => {
  window.clearTimeout(tabLoadTimer);
  resetSheetTabDropdown();
});

fields.sheetTab.addEventListener("focus", () => {
  if (!fields.sheetUrl.value.trim()) {
    return;
  }

  if (loadedSheetTabsKey === getSheetTabLoadKey()) {
    return;
  }

  loadSheetTabs({ silent: false }).catch(() => {});
});

applyConfigToForm(loadSavedConfig());
refreshState().catch(() => {});
connectEvents();
