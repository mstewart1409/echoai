// logs.js — log viewer page (/logs).
//
// Reads /api/logs, which is in the server's SESSION_ONLY_PATHS: a cast token
// will not open it, only a real logged-in session. This file holds no
// credentials and no log data of its own — if the session is missing, the API
// returns 401 and we prompt for a login exactly like the main viewer does.

const AUTO_REFRESH_MS = 5000;
const MESSAGE_CLAMP = 400; // Chars shown before a message is collapsed.

const searchEl = document.getElementById("logSearch");
const sourceEl = document.getElementById("logSource");
const levelsEl = document.getElementById("logLevels");
const limitEl = document.getElementById("logLimit");
const autoRefreshEl = document.getElementById("logAutoRefresh");
const refreshBtnEl = document.getElementById("logRefreshBtn");
const copyBtnEl = document.getElementById("logCopyBtn");
const rowsEl = document.getElementById("logRows");
const statusEl = document.getElementById("logStatus");
const metaEl = document.getElementById("logMeta");

let autoRefreshTimer = null;
let lastRecords = [];

function selectedLevels() {
  return Array.from(levelsEl.querySelectorAll("input:checked")).map((el) => el.value);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("logs-status-error", isError);
}

/** Prompt for credentials and log in. Mirrors the main viewer's flow. */
async function login() {
  const status = await (await fetch("/api/auth/status")).json();
  if (status.authenticated) return true;
  const username = globalThis.prompt("Username", status.username_hint || "") || "";
  const password = globalThis.prompt("Password", "") || "";
  if (!username || !password) return false;
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.ok;
}

async function fetchLogs() {
  const params = new URLSearchParams({
    limit: limitEl.value,
    search: searchEl.value.trim(),
    source: sourceEl.value,
    levels: selectedLevels().join(","),
  });

  let res = await fetch(`/api/logs?${params}`);
  if (res.status === 401) {
    if (!(await login())) {
      setStatus("Sign-in required to view logs.", true);
      return;
    }
    res = await fetch(`/api/logs?${params}`);
  }
  if (!res.ok) {
    setStatus(`Failed to load logs (HTTP ${res.status}).`, true);
    return;
  }

  const data = await res.json();
  lastRecords = data.records || [];
  render(lastRecords);
  metaEl.textContent = `${data.log_file || "console only"} · level ${data.level}`;
  setStatus(
    lastRecords.length
      ? `Showing ${data.returned} of ${data.total} matching records.`
      : "No records match these filters."
  );
}

/** Short level label + CSS class. Keeps the table narrow on a phone. */
function levelClass(level) {
  if (level === "ERROR" || level === "CRITICAL") return "log-error";
  if (level === "WARNING") return "log-warn";
  if (level === "DEBUG") return "log-debug";
  return "log-info";
}

function render(records) {
  rowsEl.replaceChildren();
  for (const record of records) {
    const tr = document.createElement("tr");
    tr.className = levelClass(record.level);

    const time = document.createElement("td");
    // Drop the date — everything in a tail is almost always the same day.
    time.textContent = (record.ts || "").split(" ")[1] || record.ts || "";
    time.className = "log-col-time";

    const level = document.createElement("td");
    level.textContent = record.level;
    level.className = "log-col-level";

    const source = document.createElement("td");
    // Strip the package prefix — "echoai.client" reads better as "client".
    source.textContent = (record.name || "").replace(/^echoai\./, "");
    source.className = "log-col-source";

    const message = document.createElement("td");
    message.className = "log-col-message";
    const text = record.message || "";
    if (text.length > MESSAGE_CLAMP || text.includes("\n")) {
      // Long messages are usually tracebacks — collapse behind a disclosure.
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = text.split("\n")[0].slice(0, MESSAGE_CLAMP);
      const pre = document.createElement("pre");
      pre.textContent = text;
      details.append(summary, pre);
      message.appendChild(details);
    } else {
      message.textContent = text;
    }

    tr.append(time, level, source, message);
    rowsEl.appendChild(tr);
  }
}

function applyAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (autoRefreshEl.checked) {
    autoRefreshTimer = setInterval(() => { void fetchLogs(); }, AUTO_REFRESH_MS);
  }
}

/** Debounce the search box so typing doesn't hammer the Pi. */
let searchTimer = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void fetchLogs(); }, 300);
});

sourceEl.addEventListener("change", () => void fetchLogs());
limitEl.addEventListener("change", () => void fetchLogs());
levelsEl.addEventListener("change", () => void fetchLogs());
refreshBtnEl.addEventListener("click", () => void fetchLogs());
autoRefreshEl.addEventListener("change", applyAutoRefresh);

copyBtnEl.addEventListener("click", () => {
  const text = lastRecords
    .map((r) => `${r.ts} ${r.level} ${r.name} ${r.message}`)
    .join("\n");
  navigator.clipboard.writeText(text).catch(() => {});
});

void fetchLogs();
