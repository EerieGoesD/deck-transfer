import { invoke } from "@tauri-apps/api/core";

// State
const filters: Record<string, boolean> = { INFO: true, WARN: true, ERROR: true };
let allLogs: string[] = [];
let searchQuery = "";

// Build UI
document.body.innerHTML = `
<div id="app">
  <div class="toolbar">
    <div class="filters">
      <button class="filter-btn active" data-level="INFO">INFO</button>
      <button class="filter-btn active" data-level="WARN">WARN</button>
      <button class="filter-btn active" data-level="ERROR">ERROR</button>
    </div>
    <input type="text" id="search" placeholder="Search logs..." />
    <div class="spacer"></div>
    <button class="btn" id="copyBtn">Copy All</button>
    <button class="btn" id="exportBtn">Export</button>
    <button class="btn btn-danger" id="clearBtn">Clear</button>
  </div>
  <div class="log-container" id="logContainer">
    <div class="empty">No logs yet. Interact with the app to generate logs.</div>
  </div>
  <div class="statusbar">
    <span id="logCount">0 entries</span>
    <span id="filterStatus">All levels shown</span>
  </div>
</div>
`;

// Inject styles
const style = document.createElement("style");
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1b2e;
    color: #e8e8f0;
    height: 100vh;
    overflow: hidden;
    user-select: none;
  }

  #app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #3a3d5c;
    background: #252742;
    flex-shrink: 0;
  }

  .filters { display: flex; gap: 4px; }

  .filter-btn {
    font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid #3a3d5c;
    color: #9496b0;
    background: transparent;
    transition: all 0.12s;
    user-select: none;
  }

  .filter-btn:hover { border-color: #9496b0; }

  .filter-btn.active[data-level="INFO"] {
    background: rgba(26, 159, 255, 0.15);
    border-color: #1a9fff;
    color: #47b3ff;
  }
  .filter-btn.active[data-level="WARN"] {
    background: rgba(250, 204, 21, 0.15);
    border-color: #facc15;
    color: #facc15;
  }
  .filter-btn.active[data-level="ERROR"] {
    background: rgba(248, 113, 113, 0.15);
    border-color: #f87171;
    color: #f87171;
  }

  #search {
    background: #1a1b2e;
    border: 1px solid #3a3d5c;
    border-radius: 4px;
    color: #e8e8f0;
    font-size: 11px;
    padding: 5px 10px;
    width: 180px;
    outline: none;
    transition: border-color 0.15s;
  }
  #search:focus { border-color: #1a9fff; }
  #search::placeholder { color: #9496b0; opacity: 0.5; }

  .spacer { flex: 1; }

  .btn {
    font-size: 11px;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid #3a3d5c;
    color: #9496b0;
    background: transparent;
    transition: all 0.12s;
  }
  .btn:hover { border-color: #1a9fff; color: #e8e8f0; }
  .btn-danger:hover { border-color: #f87171; color: #f87171; }

  .log-container {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px;
    font-family: "Cascadia Code", "Fira Code", Consolas, monospace;
    font-size: 11px;
    line-height: 1.7;
    user-select: text;
  }

  .log-container::-webkit-scrollbar { width: 6px; }
  .log-container::-webkit-scrollbar-track { background: #1a1b2e; }
  .log-container::-webkit-scrollbar-thumb { background: #3a3d5c; border-radius: 3px; }

  .empty {
    color: #9496b0;
    font-size: 12px;
    padding: 40px 0;
    text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .log-line {
    padding: 1px 0;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .log-line .ts { color: #9496b0; margin-right: 8px; }
  .log-line .level {
    font-weight: 600;
    margin-right: 6px;
    display: inline-block;
    min-width: 40px;
  }
  .log-line .msg { color: #e8e8f0; }

  .log-line.lvl-INFO .level { color: #47b3ff; }
  .log-line.lvl-WARN .level { color: #facc15; }
  .log-line.lvl-ERROR .level { color: #f87171; }
  .log-line.lvl-ERROR .msg { color: #f87171; }

  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    border-top: 1px solid #3a3d5c;
    background: #252742;
    font-size: 10px;
    color: #9496b0;
    flex-shrink: 0;
  }

  .copied {
    color: #4ade80 !important;
    border-color: #4ade80 !important;
  }
`;
document.head.appendChild(style);

// Elements
const logContainer = document.getElementById("logContainer")!;
const searchInput = document.getElementById("search") as HTMLInputElement;
const logCountEl = document.getElementById("logCount")!;
const filterStatusEl = document.getElementById("filterStatus")!;
const copyBtn = document.getElementById("copyBtn")!;
const exportBtn = document.getElementById("exportBtn")!;
const clearBtn = document.getElementById("clearBtn")!;

// Parse a log line: "[HH:MM:SS.mmm] LEVEL message"
function parseLine(line: string): { ts: string; level: string; msg: string } {
  const match = line.match(/^\[([^\]]+)\]\s+(INFO|WARN|ERROR)\s+(.*)$/);
  if (match) {
    return { ts: match[1], level: match[2], msg: match[3] };
  }
  return { ts: "", level: "INFO", msg: line };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLogs() {
  const frag = document.createDocumentFragment();
  let visibleCount = 0;

  for (const line of allLogs) {
    const parsed = parseLine(line);
    if (!filters[parsed.level]) continue;
    if (searchQuery && !parsed.msg.toLowerCase().includes(searchQuery)) continue;

    const div = document.createElement("div");
    div.className = `log-line lvl-${parsed.level}`;
    div.innerHTML = `<span class="ts">${escapeHtml(parsed.ts)}</span><span class="level">${parsed.level}</span><span class="msg">${escapeHtml(parsed.msg)}</span>`;
    frag.appendChild(div);
    visibleCount++;
  }

  logContainer.innerHTML = "";
  if (visibleCount === 0) {
    logContainer.innerHTML = `<div class="empty">${allLogs.length === 0 ? "No logs yet. Interact with the app to generate logs." : "No logs match current filters."}</div>`;
  } else {
    logContainer.appendChild(frag);
  }

  logCountEl.textContent = `${visibleCount} / ${allLogs.length} entries`;

  const activeFilters = Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k]) => k);
  filterStatusEl.textContent =
    activeFilters.length === 3
      ? "All levels shown"
      : activeFilters.length === 0
      ? "All levels hidden"
      : `Showing: ${activeFilters.join(", ")}`;
}

function scrollToBottom() {
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Poll logs from backend
let prevLength = 0;
async function pollLogs() {
  try {
    const logs = await invoke<string[]>("get_debug_logs");
    if (logs.length !== prevLength) {
      prevLength = logs.length;
      allLogs = logs;
      renderLogs();
      scrollToBottom();
    }
  } catch (_) {
    // ignore
  }
}

setInterval(pollLogs, 500);
pollLogs();

// Filter buttons
document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const level = (btn as HTMLElement).dataset.level!;
    filters[level] = !filters[level];
    btn.classList.toggle("active", filters[level]);
    renderLogs();
  });
});

// Search
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value.toLowerCase();
  renderLogs();
});

// Copy all visible logs to clipboard
copyBtn.addEventListener("click", async () => {
  const lines = logContainer.querySelectorAll(".log-line");
  const text = Array.from(lines)
    .map((el) => {
      const ts = el.querySelector(".ts")?.textContent || "";
      const level = el.querySelector(".level")?.textContent || "";
      const msg = el.querySelector(".msg")?.textContent || "";
      return `${ts} ${level} ${msg}`;
    })
    .join("\n");

  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy All";
      copyBtn.classList.remove("copied");
    }, 1500);
  } catch (_) {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.textContent = "Copy All";
      copyBtn.classList.remove("copied");
    }, 1500);
  }
});

// Export as TXT
exportBtn.addEventListener("click", () => {
  const text = allLogs.join("\n");
  if (!text) return;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `deck-transfer-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// Clear logs
clearBtn.addEventListener("click", async () => {
  try {
    await invoke("clear_debug_logs");
  } catch (_) {
    // ignore
  }
  allLogs = [];
  prevLength = 0;
  renderLogs();
});
