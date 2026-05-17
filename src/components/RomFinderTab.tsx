import { useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RomScanResult, RomScanEntry } from "../types";

interface Props {
  deckIp: string;
  password: string;
}

interface FoundRow {
  relativePath: string;
  size: number;
  internalKind: "real" | "symlink" | "missing";
  sdKind: "real" | "symlink" | "missing";
  realLocation: "internal" | "sd" | "none" | "both";
  internalAbsPath: string;
  sdAbsPath: string;
  internalTarget: string;
  sdTarget: string;
}

const DEFAULT_INTERNAL = "/home/deck/Emulation/roms";
const DEFAULT_SD = "/run/media/deck/EmuDeck/Emulation/roms";

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function joinPath(root: string, rel: string): string {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${r}/${rel}`;
}

function formatLocation(realLocation: FoundRow["realLocation"]): string {
  switch (realLocation) {
    case "internal": return "Internal (real file)";
    case "sd": return "SD card (real file)";
    case "both": return "BOTH (duplicate, run Cleanup ROMs)";
    case "none": return "Neither (orphaned symlinks)";
  }
}

export default function RomFinderTab({ deckIp, password }: Props) {
  const [internalRoot, setInternalRoot] = useState(DEFAULT_INTERNAL);
  const [sdRoot, setSdRoot] = useState(DEFAULT_SD);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<RomScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<FoundRow | null>(null);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setSelectedRow(null);
    try {
      const r = await invoke<RomScanResult>("scan_rom_layout", {
        deckIp,
        deckPassword: password,
        internalRoot,
        sdRoot,
      });
      setScanResult(r);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  }, [deckIp, password, internalRoot, sdRoot]);

  // Live filter on the cached scan result
  const results = useMemo<FoundRow[]>(() => {
    if (!scanResult) return [];
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const out: FoundRow[] = [];
    for (const e of scanResult.entries as RomScanEntry[]) {
      if (!e.relative_path.toLowerCase().includes(q)) continue;
      out.push({
        relativePath: e.relative_path,
        size: e.size,
        internalKind: e.internal_kind,
        sdKind: e.sd_kind,
        realLocation: e.real_location,
        internalAbsPath: joinPath(scanResult.internal_root, e.relative_path),
        sdAbsPath: joinPath(scanResult.sd_root, e.relative_path),
        internalTarget: e.symlink_target_internal,
        sdTarget: e.symlink_target_sd,
      });
    }
    out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return out.slice(0, 500); // cap result list to keep the UI responsive
  }, [scanResult, search]);

  // Clear selection when search/results change
  useEffect(() => { setSelectedRow(null); }, [search]);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyPath = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch { setCopyState("failed"); }
    setTimeout(() => setCopyState("idle"), 1200);
  }, []);

  return (
    <div className="rebalance-tab">
      <div className="rebalance-section">
        <div className="rebalance-section-title">ROM Finder</div>
        <div className="rebalance-section-hint">
          Scan both ROM roots once, then search across all 17000+ entries to find where a specific ROM lives. Tells you whether the real file is on internal storage, the SD card, both (duplicate), or neither (orphan symlink).
        </div>
      </div>

      <div className="rebalance-section">
        <label className="rebalance-label">Internal ROMs folder</label>
        <input className="rebalance-input" value={internalRoot} onChange={(e) => setInternalRoot(e.target.value)} disabled={scanning} />
        <label className="rebalance-label">SD card ROMs folder</label>
        <input className="rebalance-input" value={sdRoot} onChange={(e) => setSdRoot(e.target.value)} disabled={scanning} />
        <div className="rebalance-btn-row">
          <button className="rebalance-btn" onClick={runScan} disabled={scanning}>
            {scanning ? "Scanning..." : scanResult ? "Re-scan" : "Scan"}
          </button>
        </div>
        {scanError && <div className="rebalance-error">{scanError}</div>}
        {scanResult && (
          <div className="rebalance-section-hint" style={{ marginTop: 6 }}>
            Scan ready: {scanResult.entries.length} entries indexed.
          </div>
        )}
      </div>

      {scanResult && (
        <div className="rebalance-section">
          <label className="rebalance-label">Search</label>
          <input
            className="rebalance-input"
            placeholder="Game name or part of the path (e.g. Mario, snes/, .chd)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search.trim() && (
            <div className="rebalance-section-hint" style={{ marginTop: 6 }}>
              {results.length === 0 ? "No matches." : `${results.length} match${results.length === 1 ? "" : "es"}${results.length === 500 ? " (capped at 500, refine your search to see more)" : ""}.`}
            </div>
          )}
        </div>
      )}

      {results.length > 0 && (
        <div className="rebalance-section">
          <table className="misplaced-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Real location</th>
                <th>Internal</th>
                <th>SD card</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr
                  key={r.relativePath}
                  onClick={() => setSelectedRow(r)}
                  className={selectedRow?.relativePath === r.relativePath ? "rom-finder-row-selected" : ""}
                  style={{ cursor: "pointer" }}
                  title="Click to see full paths"
                >
                  <td>{r.relativePath}</td>
                  <td>{formatSize(r.size)}</td>
                  <td>{formatLocation(r.realLocation)}</td>
                  <td>{r.internalKind}</td>
                  <td>{r.sdKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRow && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">{selectedRow.relativePath}</span>
            <button className="rebalance-copy-btn" onClick={() => setSelectedRow(null)}>Close</button>
          </div>
          <div className="rom-finder-detail">
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Size:</span>
              <span>{formatSize(selectedRow.size)}</span>
            </div>
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Real bytes live on:</span>
              <span>{formatLocation(selectedRow.realLocation)}</span>
            </div>
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">Internal ({selectedRow.internalKind}):</span>
              <span className="rom-finder-detail-path" onClick={() => copyPath(selectedRow.internalAbsPath)} title="Click to copy">
                {selectedRow.internalAbsPath}
              </span>
            </div>
            {selectedRow.internalKind === "symlink" && selectedRow.internalTarget && (
              <div className="rom-finder-detail-row">
                <span className="rom-finder-detail-label">Internal target:</span>
                <span className="rom-finder-detail-path">{selectedRow.internalTarget}</span>
              </div>
            )}
            <div className="rom-finder-detail-row">
              <span className="rom-finder-detail-label">SD card ({selectedRow.sdKind}):</span>
              <span className="rom-finder-detail-path" onClick={() => copyPath(selectedRow.sdAbsPath)} title="Click to copy">
                {selectedRow.sdAbsPath}
              </span>
            </div>
            {selectedRow.sdKind === "symlink" && selectedRow.sdTarget && (
              <div className="rom-finder-detail-row">
                <span className="rom-finder-detail-label">SD target:</span>
                <span className="rom-finder-detail-path">{selectedRow.sdTarget}</span>
              </div>
            )}
            <div className="rom-finder-detail-hint">
              {copyState === "copied" ? "Path copied to clipboard." : copyState === "failed" ? "Copy failed." : "Click a path to copy it."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
