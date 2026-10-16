import { useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatSize } from "../utils";
import DownloadMenu from "./DownloadMenu";

interface Props {
  deckIp: string;
  password: string;
  onDownload: (remotePath: string, isDir: boolean) => void;
}

interface SaveEntry {
  root_index: number;
  path: string;
  relative_path: string;
  size: number;
  modified: number;
}

// EmuDeck keeps every emulator's saves in Emulation/saves, as links into each
// emulator's own folder, on whichever drive EmuDeck was installed to.
const DEFAULT_INTERNAL = "/home/deck/Emulation/saves";
const DEFAULT_SD = "/run/media/deck/EmuDeck/Emulation/saves";

const ROOT_LABELS = ["Internal", "SD card"];

// A save state is anything in a states folder, or with a state file ending
// (RetroArch .state/.state1, PCSX2 .p2s, PPSSPP .ppst, Citra .cst and so on).
function isSaveState(relativePath: string): boolean {
  const p = "/" + relativePath.toLowerCase();
  return /\/(states|savestates|sstates)\//.test(p) || /\.(state\d*|state\.auto|st\d|ss\d|p2s|ppst|cst|frz)$/.test(p);
}

function formatDate(seconds: number): string {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SaveFinderTab({ deckIp, password, onDownload }: Props) {
  const [internalRoot, setInternalRoot] = useState(DEFAULT_INTERNAL);
  const [sdRoot, setSdRoot] = useState(DEFAULT_SD);
  const [scanning, setScanning] = useState(false);
  const [entries, setEntries] = useState<SaveEntry[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SaveEntry | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SaveEntry } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setEntries(null);
    setSelected(null);
    try {
      const r = await invoke<SaveEntry[]>("scan_save_files", {
        deckIp,
        deckPassword: password,
        roots: [internalRoot, sdRoot],
      });
      setEntries(r);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  }, [deckIp, password, internalRoot, sdRoot]);

  // Newest first, so the save from the last session is at the top before any
  // search is typed. The search matches any part of the path.
  const results = useMemo<SaveEntry[]>(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    const out = q ? entries.filter((e) => e.relative_path.toLowerCase().includes(q)) : [...entries];
    out.sort((a, b) => b.modified - a.modified);
    return out.slice(0, 500); // cap result list to keep the UI responsive
  }, [entries, search]);

  const states = useMemo(() => (entries ? entries.filter((e) => isSaveState(e.relative_path)).length : 0), [entries]);

  useEffect(() => { setSelected(null); }, [search]);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyPath = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch { setCopyState("failed"); }
    setTimeout(() => setCopyState("idle"), 1200);
  }, []);

  const total = entries?.length ?? 0;

  return (
    <div className="rebalance-tab">
      <div className="rebalance-section">
        <div className="rebalance-section-title">ROM Save Finder</div>
        <div className="rebalance-section-hint">
          Scan the emulator save folders, then search for a game to see where its save files and save states live, how big they are and when they were last saved.
        </div>
      </div>

      {/* Once scanned, search sits right under the description with its results
          directly below it, so matches show without scrolling. The folders and
          Re-scan move to the bottom. */}
      {entries && (
        <div className="rebalance-section">
          <label className="rebalance-label">Search</label>
          <input
            className="rebalance-input"
            placeholder="Game name, emulator or part of the path (e.g. Mario, retroarch, .srm)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="rebalance-section-hint" style={{ marginTop: 6 }}>
            {total === 0
              ? "No save files found in these folders. Check the folders below and scan again."
              : search.trim()
                ? results.length === 0
                  ? "No matches."
                  : `${results.length} match${results.length === 1 ? "" : "es"}${results.length === 500 ? " (capped at 500, refine your search to see more)" : ""}, newest first.`
                : `${total} file${total === 1 ? "" : "s"} (${total - states} save${total - states === 1 ? "" : "s"}, ${states} save state${states === 1 ? "" : "s"}), newest first${total > 500 ? ". Showing the newest 500" : ""}.`}
          </div>
          {results.length > 0 && (
            <table className="misplaced-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>Last saved</th>
                  <th>Found in</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr
                    key={r.path}
                    onClick={() => setSelected(r)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, entry: r });
                    }}
                    className={selected?.path === r.path ? "rom-finder-row-selected" : ""}
                    style={{ cursor: "pointer" }}
                    title="Click to see the full path. Right-click to download it."
                  >
                    <td>{r.relative_path}</td>
                    <td>{isSaveState(r.relative_path) ? "Save state" : "Save"}</td>
                    <td>{formatSize(r.size)}</td>
                    <td>{formatDate(r.modified)}</td>
                    <td>{ROOT_LABELS[r.root_index] ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {selected && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">{selected.relative_path.split("/").pop()}</span>
            <button className="rebalance-copy-btn" onClick={() => setSelected(null)}>Close</button>
          </div>
          <div className="rom-finder-detail">
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Type:</span>
              <span>{isSaveState(selected.relative_path) ? "Save state" : "Save"}</span>
            </div>
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Size:</span>
              <span>{formatSize(selected.size)}</span>
            </div>
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Last saved:</span>
              <span>{formatDate(selected.modified)}</span>
            </div>
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Path:</span>
              <span className="rom-finder-detail-path" onClick={() => copyPath(selected.path)} title="Click to copy">
                {selected.path}
              </span>
            </div>
            <div className="rom-finder-detail-hint">
              {copyState === "copied" ? "Path copied to clipboard." : copyState === "failed" ? "Copy failed." : "Click the path to copy it."}
            </div>
          </div>
        </div>
      )}

      <div className="rebalance-section">
        <label className="rebalance-label">Internal saves folder</label>
        <input className="rebalance-input" value={internalRoot} onChange={(e) => setInternalRoot(e.target.value)} disabled={scanning} />
        <label className="rebalance-label">SD card saves folder</label>
        <input className="rebalance-input" value={sdRoot} onChange={(e) => setSdRoot(e.target.value)} disabled={scanning} />
        <div className="rebalance-btn-row">
          <button className="rebalance-btn" onClick={runScan} disabled={scanning}>
            {scanning ? "Scanning..." : entries ? "Re-scan" : "Scan"}
          </button>
        </div>
        {scanError && <div className="rebalance-error">{scanError}</div>}
      </div>

      {menu && (
        <DownloadMenu
          x={menu.x}
          y={menu.y}
          onDownload={() => onDownload(menu.entry.path, false)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
