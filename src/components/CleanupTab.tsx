import { useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RomScanResult, RebalanceMoveResult } from "../types";

interface Props {
  deckIp: string;
  password: string;
}

interface DuplicateRow {
  relativePath: string;
  size: number;
  internalAbsPath: string;
  sdAbsPath: string;
}

const DEFAULT_INTERNAL = "/home/deck/Emulation/roms";
const DEFAULT_SD = "/run/media/deck/EmuDeck/Emulation/roms";

function formatMB(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function joinPath(root: string, rel: string): string {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${r}/${rel}`;
}

export default function CleanupTab({ deckIp, password }: Props) {
  const [internalRoot, setInternalRoot] = useState(DEFAULT_INTERNAL);
  const [sdRoot, setSdRoot] = useState(DEFAULT_SD);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<RomScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({ done: 0, total: 0, current: "" });
  const [runLog, setRunLog] = useState<string[]>([]);
  const [rowStatus, setRowStatus] = useState<Map<string, "deleted" | "failed">>(new Map());

  // State for the interactive cross-format resolve modal.
  const [resolvingGroup, setResolvingGroup] = useState<CrossFormatGroup | null>(null);
  const [keepRel, setKeepRel] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolvedKeys, setResolvedKeys] = useState<Set<string>>(new Set());

  function groupKey(g: { system: string; stem: string }): string {
    return `${g.system}|${g.stem.toLowerCase()}`;
  }

  function openResolve(g: CrossFormatGroup) {
    setResolveError(null);
    // Default keep = largest file (usually highest quality / most data)
    const largest = [...g.entries].sort((a, b) => b.size - a.size)[0];
    setKeepRel(largest.relativePath);
    setResolvingGroup(g);
  }

  async function confirmResolve() {
    if (!resolvingGroup || !keepRel) return;
    const toDelete = resolvingGroup.entries.filter((e) => e.relativePath !== keepRel);
    if (toDelete.length === 0) {
      setResolvingGroup(null);
      return;
    }
    setResolving(true);
    setResolveError(null);
    const errors: string[] = [];
    for (const e of toDelete) {
      // An entry may live on internal, sd, or both. Delete every real copy.
      const paths: string[] = [];
      if (e.onInternal) paths.push(e.internalAbsPath);
      if (e.onSd) paths.push(e.sdAbsPath);
      for (const p of paths) {
        try {
          const r = await invoke<RebalanceMoveResult>("safe_delete_remote_file", {
            deckIp,
            deckPassword: password,
            path: p,
            expectedSize: e.size,
          });
          if (!r.ok) errors.push(`${p} -> ${r.message}`);
        } catch (err) {
          errors.push(`${p} -> ${String(err)}`);
        }
      }
    }
    setResolving(false);
    if (errors.length > 0) {
      setResolveError(errors.join("\n"));
    } else {
      setResolvedKeys((prev) => new Set(prev).add(groupKey(resolvingGroup)));
      setResolvingGroup(null);
    }
  }


  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setRunLog([]);
    setRowStatus(new Map());
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

  const duplicates = useMemo<DuplicateRow[]>(() => {
    if (!scanResult) return [];
    const out: DuplicateRow[] = [];
    for (const e of scanResult.entries) {
      if (e.internal_kind === "real" && e.sd_kind === "real") {
        out.push({
          relativePath: e.relative_path,
          size: e.size,
          internalAbsPath: joinPath(scanResult.internal_root, e.relative_path),
          sdAbsPath: joinPath(scanResult.sd_root, e.relative_path),
        });
      }
    }
    out.sort((a, b) => b.size - a.size); // biggest first to show the value of cleanup
    return out;
  }, [scanResult]);

  const wastedBytes = useMemo(() => duplicates.reduce((s, d) => s + d.size, 0), [duplicates]);

  // Cross-format duplicates: same game stored under different extensions in the same system
  // folder (e.g. snes/Mario.7z and snes/Mario.zip). Read-only report; we cannot guess which
  // format the user wants to keep, so no auto-delete.
  interface CrossFormatEntry {
    relativePath: string;
    extension: string;
    size: number;
    internalAbsPath: string;
    sdAbsPath: string;
    onInternal: boolean;
    onSd: boolean;
  }
  interface CrossFormatGroup {
    system: string;
    stem: string;
    entries: CrossFormatEntry[];
  }

  const crossFormatGroups = useMemo<CrossFormatGroup[]>(() => {
    if (!scanResult) return [];
    const result = scanResult;
    const NON_ROM_TOPS = new Set(["emulators", "cloud", "desktop", "store", "tools", "ports"]);
    // Same blacklist used in Rebalance/Fix-Paths so save files (.srm/.sav/.state), emulator
    // configs (.ini/.lua/.pat), executables, and metadata never appear in this report.
    const SKIP_EXTS = new Set([
      ".log", ".bak", ".tmp", ".old",
      ".srm", ".sav", ".save", ".state", ".st0", ".st1", ".st2", ".st3", ".st4", ".st5", ".st6", ".st7", ".st8", ".st9", ".dat",
      ".cue", ".gdi", ".m3u", ".ccd", ".sub",
      ".sh", ".bat", ".cmd", ".ps1",
      ".txt", ".md", ".ini", ".cfg", ".conf",
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
      ".xml", ".json", ".yaml", ".yml", ".html", ".htm", ".csv",
      ".pat", ".ips", ".ups", ".bps", ".xdelta",
      ".exe", ".dll", ".so", ".lua", ".ps",
      ".filepart", ".part", ".crdownload", ".aria2",
    ]);
    const groups = new Map<string, CrossFormatGroup>();
    for (const e of result.entries) {
      if (e.internal_kind !== "real" && e.sd_kind !== "real") continue;
      const parts = e.relative_path.split("/");
      if (parts.length !== 2) continue;
      const sys = parts[0].toLowerCase();
      if (NON_ROM_TOPS.has(sys)) continue;
      const fname = parts[1];
      const dotIdx = fname.lastIndexOf(".");
      if (dotIdx <= 0) continue;
      const stem = fname.slice(0, dotIdx);
      const ext = fname.slice(dotIdx).toLowerCase();
      if (SKIP_EXTS.has(ext)) continue;
      // Metadata files commonly named without an extension in front (handled by SKIP_EXTS above)
      // or where the filename itself is bookkeeping
      const fnameLc = fname.toLowerCase();
      if (fnameLc === "metadata.txt" || fnameLc === "systeminfo.txt" || fnameLc === "gamelist.xml") continue;
      const norm = stem.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!norm) continue;
      const key = `${sys}|${norm}`;
      let g = groups.get(key);
      if (!g) {
        g = { system: sys, stem, entries: [] };
        groups.set(key, g);
      }
      g.entries.push({
        relativePath: e.relative_path,
        extension: ext,
        size: e.size,
        internalAbsPath: joinPath(result.internal_root, e.relative_path),
        sdAbsPath: joinPath(result.sd_root, e.relative_path),
        onInternal: e.internal_kind === "real",
        onSd: e.sd_kind === "real",
      });
    }
    const out: CrossFormatGroup[] = [];
    for (const g of groups.values()) {
      if (g.entries.length < 2) continue;
      const exts = new Set(g.entries.map((x) => x.extension));
      if (exts.size < 2) continue;
      out.push(g);
    }
    out.sort((a, b) => a.system.localeCompare(b.system) || a.stem.localeCompare(b.stem));
    return out;
  }, [scanResult]);

  const crossFormatWaste = useMemo(() => {
    // Approximate wasted bytes = total - largest in each group
    let total = 0;
    for (const g of crossFormatGroups) {
      const sizes = g.entries.map((e) => e.size).sort((a, b) => b - a);
      for (let i = 1; i < sizes.length; i++) total += sizes[i];
    }
    return total;
  }, [crossFormatGroups]);

  const cleanupInternalCopies = useCallback(async () => {
    if (duplicates.length === 0) return;
    setApplying(true);
    setProgress({ done: 0, total: duplicates.length, current: "" });
    setRunLog([]);
    setRowStatus(new Map());
    const log: string[] = [];
    const status = new Map<string, "deleted" | "failed">();
    let okCount = 0;
    let failCount = 0;
    let freedBytes = 0;
    for (let i = 0; i < duplicates.length; i++) {
      const d = duplicates[i];
      setProgress({ done: i, total: duplicates.length, current: d.relativePath });
      try {
        const r = await invoke<RebalanceMoveResult>("safe_delete_remote_file", {
          deckIp,
          deckPassword: password,
          path: d.internalAbsPath,
          expectedSize: d.size,
        });
        if (r.ok) {
          okCount++;
          freedBytes += d.size;
          log.push(`OK   removed internal/${d.relativePath} (${formatMB(d.size)})`);
          status.set(d.relativePath, "deleted");
        } else {
          failCount++;
          log.push(`FAIL ${d.relativePath} - ${r.message}`);
          status.set(d.relativePath, "failed");
        }
      } catch (e) {
        failCount++;
        log.push(`FAIL ${d.relativePath} - ${String(e)}`);
        status.set(d.relativePath, "failed");
      }
      setRunLog([...log]);
      setRowStatus(new Map(status));
    }
    setProgress({ done: duplicates.length, total: duplicates.length, current: "" });
    log.push("");
    log.push(`Done: ${okCount} cleaned, ${failCount} failed, ${formatGB(freedBytes)} freed.`);
    setRunLog([...log]);
    setApplying(false);
  }, [duplicates, deckIp, password]);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyLog = useCallback(async (lines: string[]) => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState("copied");
    } catch { setCopyState("failed"); }
    setTimeout(() => setCopyState("idle"), 1500);
  }, []);

  return (
    <div className="rebalance-tab">
      <div className="rebalance-section">
        <div className="rebalance-section-title">Cleanup ROMs</div>
        <div className="rebalance-section-hint">
          Detects files that exist as REAL on BOTH internal storage and SD card (a sign that a previous rebalance run was interrupted between the copy step and the source-delete step). For each duplicate, removes the INTERNAL-side copy and keeps the SD-side copy, because ES-DE scans the SD root. Each delete is guarded: the file must exist, must be a regular file (not a symlink), and its current size on disk must match the expected size from the scan. Anything that does not match is skipped.
        </div>
      </div>

      <div className="rebalance-section">
        <label className="rebalance-label">Internal ROMs folder</label>
        <input className="rebalance-input" value={internalRoot} onChange={(e) => setInternalRoot(e.target.value)} disabled={scanning || applying} />
        <label className="rebalance-label">SD card ROMs folder</label>
        <input className="rebalance-input" value={sdRoot} onChange={(e) => setSdRoot(e.target.value)} disabled={scanning || applying} />
        <div className="rebalance-btn-row">
          <button className="rebalance-btn" onClick={runScan} disabled={scanning || applying}>
            {scanning ? "Scanning..." : "Scan for duplicates"}
          </button>
          <button
            className="rebalance-btn rebalance-btn-danger"
            onClick={cleanupInternalCopies}
            disabled={applying || scanning || duplicates.length === 0}
            title={duplicates.length === 0 ? "Run Scan first" : `Remove ${duplicates.length} duplicate file(s) from internal storage`}
          >
            Cleanup duplicates{duplicates.length > 0 ? ` (${duplicates.length})` : ""}
          </button>
        </div>
        {scanError && <div className="rebalance-error">{scanError}</div>}
      </div>

      {scanResult && duplicates.length === 0 && !applying && (
        <div className="rebalance-section">
          <div className="rebalance-section-hint">No duplicates found. Disks are clean.</div>
        </div>
      )}

      {(applying || runLog.length > 0) && (
        <div className="rebalance-section">
          <div className="rebalance-progress-header">
            <strong>{applying ? "Removing duplicates..." : "Cleanup complete"}</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>{progress.done} / {progress.total}</span>
              {!applying && runLog.length > 0 && (
                <button
                  className="rebalance-copy-btn"
                  onClick={() => copyLog(runLog)}
                  title="Copy cleanup log to clipboard"
                >
                  {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : "Copy"}
                </button>
              )}
            </div>
          </div>
          {applying && (
            <div className="rebalance-progress-bar">
              <div className="rebalance-progress-fill" style={{ width: `${progress.total === 0 ? 0 : (progress.done / progress.total) * 100}%` }} />
            </div>
          )}
          {applying && progress.current && (
            <div className="rebalance-progress-current">Currently: {progress.current}</div>
          )}
          <div className="rebalance-log">
            {runLog.slice(-300).map((line, i) => (
              <div className={`rebalance-log-line ${line.startsWith("FAIL") ? "fail" : line.startsWith("OK") ? "ok" : ""}`} key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {duplicates.length > 0 && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">
              {duplicates.length} duplicate{duplicates.length === 1 ? "" : "s"} found, {formatGB(wastedBytes)} wasted
            </span>
            <button
              className="rebalance-copy-btn"
              onClick={() => {
                const lines: string[] = [];
                lines.push(`Duplicate cleanup list - ${duplicates.length} files, ${formatGB(wastedBytes)} wasted`);
                lines.push(``);
                lines.push(`File\tSize\tInternal Path\tSD Path\tStatus`);
                for (const d of duplicates) {
                  const s = rowStatus.get(d.relativePath);
                  const statusText = s === "deleted" ? "Cleaned" : s === "failed" ? "Failed" : "Pending";
                  lines.push(`${d.relativePath}\t${formatMB(d.size)}\t${d.internalAbsPath}\t${d.sdAbsPath}\t${statusText}`);
                }
                copyLog(lines);
              }}
            >
              {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : "Copy list"}
            </button>
          </div>
          <table className="misplaced-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Internal path</th>
                <th>SD path</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {duplicates.map((d) => {
                const status = rowStatus.get(d.relativePath);
                const cls = status === "deleted" ? "misplaced-row-fixed"
                  : status === "failed" ? "misplaced-row-failed"
                  : "";
                return (
                  <tr key={d.relativePath} className={cls}>
                    <td title={d.relativePath}>{d.relativePath}</td>
                    <td>{formatMB(d.size)}</td>
                    <td title={d.internalAbsPath}>internal</td>
                    <td title={d.sdAbsPath}>sd (kept)</td>
                    <td>
                      {status === "deleted" && <span className="misplaced-badge-fixed">Cleaned</span>}
                      {status === "failed" && <span className="misplaced-badge-failed">Failed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {crossFormatGroups.filter((g) => !resolvedKeys.has(groupKey(g))).length > 0 && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">
              {crossFormatGroups.filter((g) => !resolvedKeys.has(groupKey(g))).length} cross-format duplicate group{crossFormatGroups.filter((g) => !resolvedKeys.has(groupKey(g))).length === 1 ? "" : "s"} found
              {crossFormatWaste > 0 ? ` (~${formatGB(crossFormatWaste)} wasted on duplicate formats)` : ""}
            </span>
            <button
              className="rebalance-copy-btn"
              onClick={() => {
                const lines: string[] = [];
                lines.push(`Cross-format duplicate groups - ${crossFormatGroups.length} groups, ~${formatGB(crossFormatWaste)} wasted`);
                lines.push(``);
                lines.push(`System\tGame (normalized)\tPath\tDisk\tSize`);
                for (const g of crossFormatGroups) {
                  for (const e of g.entries) {
                    const disk = e.onInternal && e.onSd ? "internal + sd" : e.onInternal ? "internal" : "sd";
                    const absPath = e.onInternal ? e.internalAbsPath : e.sdAbsPath;
                    lines.push(`${g.system}\t${g.stem}\t${absPath}\t${disk}\t${formatMB(e.size)}`);
                  }
                }
                copyLog(lines);
              }}
              title="Copy cross-format duplicate report to clipboard"
            >
              {copyState === "copied" ? "Copied!" : copyState === "failed" ? "Copy failed" : "Copy"}
            </button>
          </div>
          <div className="rebalance-section-hint">
            Same game stored under different extensions in the same system folder (for example <code>snes/Mario.7z</code> and <code>snes/Mario.zip</code>). These are NOT auto-deleted because we cannot guess which format you want to keep. Pick which copy to delete manually via SCP, the file manager, or by changing the extensions to disambiguate.
          </div>
          <table className="misplaced-table">
            <thead>
              <tr>
                <th>System</th>
                <th>Game (normalized)</th>
                <th>Path</th>
                <th>Disk</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {crossFormatGroups.filter((g) => !resolvedKeys.has(groupKey(g))).map((g) => (
                g.entries.map((e, idx) => (
                  <tr key={`${g.system}|${g.stem}|${e.relativePath}|${e.onInternal ? "i" : "s"}|${idx}`}>
                    {idx === 0 ? <td rowSpan={g.entries.length}>{g.system}</td> : null}
                    {idx === 0 ? <td rowSpan={g.entries.length}>{g.stem}</td> : null}
                    <td title={e.onInternal ? e.internalAbsPath : e.sdAbsPath}>{e.relativePath}</td>
                    <td>{e.onInternal && e.onSd ? "internal + sd" : e.onInternal ? "internal" : "sd"}</td>
                    <td>{formatMB(e.size)}</td>
                    {idx === 0 ? (
                      <td rowSpan={g.entries.length}>
                        <button
                          className="rebalance-btn rebalance-btn-danger"
                          style={{ padding: "4px 10px", fontSize: "0.72rem" }}
                          onClick={() => openResolve(g)}
                          disabled={resolving}
                        >
                          Cleanup duplicates
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resolvingGroup && (
        <div className="settings-overlay" onClick={() => !resolving && setResolvingGroup(null)}>
          <div className="cleanup-resolve-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="cleanup-resolve-title">
              Cross-format duplicates: {resolvingGroup.system}/{resolvingGroup.stem}
            </div>
            <div className="cleanup-resolve-hint">
              The files below look like the same game saved in different formats. Pick the ONE you want to KEEP. Every other entry in the list (across both disks) will be deleted.
            </div>
            <div className="cleanup-resolve-options">
              {resolvingGroup.entries.map((e) => {
                const disk = e.onInternal && e.onSd ? "internal + sd" : e.onInternal ? "internal" : "sd";
                return (
                  <label key={e.relativePath} className="cleanup-resolve-option">
                    <input
                      type="radio"
                      name="cleanup-keep"
                      checked={keepRel === e.relativePath}
                      onChange={() => setKeepRel(e.relativePath)}
                      disabled={resolving}
                    />
                    <span className="cleanup-resolve-ext">{e.extension}</span>
                    <span className="cleanup-resolve-path" title={e.onInternal ? e.internalAbsPath : e.sdAbsPath}>
                      {e.relativePath}
                    </span>
                    <span className="cleanup-resolve-disk">{disk}</span>
                    <span className="cleanup-resolve-size">{formatMB(e.size)}</span>
                  </label>
                );
              })}
            </div>
            {resolveError && <div className="rebalance-error" style={{ whiteSpace: "pre-wrap" }}>{resolveError}</div>}
            <div className="cleanup-resolve-actions">
              <button
                className="rebalance-copy-btn"
                onClick={() => setResolvingGroup(null)}
                disabled={resolving}
              >
                Cancel
              </button>
              <button
                className="rebalance-btn rebalance-btn-danger"
                onClick={confirmResolve}
                disabled={resolving || !keepRel}
              >
                {resolving ? "Deleting..." : `Delete the other ${resolvingGroup.entries.length - 1} file${resolvingGroup.entries.length === 2 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
