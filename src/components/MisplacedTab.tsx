import { useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RomScanResult, RebalanceMoveResult } from "../types";

interface Props {
  deckIp: string;
  password: string;
}

interface MisplacedRow {
  disk: "internal" | "sd";
  currentSystem: string;
  suggestedSystem: string | null; // null = unusual but no destination
  relativePath: string;
  filename: string;
  size: number;
  ext: string;
  currentAbsPath: string;
  suggestedAbsPath: string | null;
  kind: "real" | "symlink";
}

const DEFAULT_INTERNAL = "/home/deck/Emulation/roms";
const DEFAULT_SD = "/run/media/deck/EmuDeck/Emulation/roms";

function formatMB(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function joinPath(root: string, rel: string): string {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${r}/${rel}`;
}

function topFolder(rel: string): string {
  const i = rel.indexOf("/");
  return i < 0 ? "(root)" : rel.slice(0, i);
}

function extOf(filename: string): string {
  const lower = filename.toLowerCase();
  const i = lower.lastIndexOf(".");
  if (i < 0) return "(no-ext)";
  return lower.slice(i);
}

// Skip non-ROM entries before analysis. Same filter as the rebalance tab.
function isAnalysisCandidate(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.length < 2 || parts.length > 2) return false;
  const filename = parts[parts.length - 1].toLowerCase();
  const top = parts[0].toLowerCase();
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot) : "";
  const NON_ROM_TOPS = new Set(["emulators", "cloud", "desktop", "store", "tools", "ports"]);
  if (NON_ROM_TOPS.has(top)) return false;
  if (filename === "metadata.txt" || filename === "systeminfo.txt" || filename === "gamelist.xml") return false;
  if (filename.startsWith("gamelist.xml.")) return false;
  if (ext === "") return false;
  const SKIP = new Set([
    ".log", ".bak", ".tmp", ".old",
    ".srm", ".sav", ".save", ".state", ".st0", ".st1", ".st2", ".st3", ".st4", ".st5", ".st6", ".st7", ".st8", ".st9", ".dat",
    ".sh", ".bat", ".cmd", ".ps1",
    ".txt", ".md", ".ini", ".cfg", ".conf",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
    ".xml", ".json", ".yaml", ".yml", ".html", ".htm", ".csv",
    ".pat", ".ips", ".ups", ".bps", ".xdelta",
    ".exe", ".dll", ".so", ".lua", ".ps",
    ".filepart", ".part", ".crdownload", ".aria2",
  ]);
  if (SKIP.has(ext)) return false;
  return true;
}

export default function MisplacedTab({ deckIp, password }: Props) {
  const [internalRoot, setInternalRoot] = useState(DEFAULT_INTERNAL);
  const [sdRoot, setSdRoot] = useState(DEFAULT_SD);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<RomScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [moveLog, setMoveLog] = useState<string[]>([]);
  const [rowStatus, setRowStatus] = useState<Map<string, "fixed" | "failed">>(new Map());

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setSelected(new Set());
    setMoveLog([]);
    setRowStatus(new Map());
    try {
      const r = await invoke<RomScanResult>("scan_rom_layout", {
        deckIp, deckPassword: password, internalRoot, sdRoot,
      });
      setScanResult(r);
    } catch (e) {
      setScanError(String(e));
    } finally {
      setScanning(false);
    }
  }, [deckIp, password, internalRoot, sdRoot]);

  // Build per-(disk,system) extension distributions, then derive misplaced rows.
  const { misplacedRows, canonicalMap } = useMemo<{
    misplacedRows: MisplacedRow[];
    canonicalMap: Map<string, Set<string>>; // key = `${disk}:${system}` -> set of canonical exts
  }>(() => {
    if (!scanResult) return { misplacedRows: [], canonicalMap: new Map() };
    const result = scanResult;

    // distribution[disk][system][ext] = count
    type SysMap = Map<string, Map<string, number>>;
    const dist: { internal: SysMap; sd: SysMap } = { internal: new Map(), sd: new Map() };

    function bump(disk: "internal" | "sd", sys: string, ext: string) {
      if (!dist[disk].has(sys)) dist[disk].set(sys, new Map());
      const sm = dist[disk].get(sys)!;
      sm.set(ext, (sm.get(ext) ?? 0) + 1);
    }

    for (const e of scanResult.entries) {
      if (!isAnalysisCandidate(e.relative_path)) continue;
      const sys = topFolder(e.relative_path);
      const fname = e.relative_path.slice(e.relative_path.lastIndexOf("/") + 1);
      const ext = extOf(fname);
      if (e.internal_kind === "real" || e.internal_kind === "symlink") bump("internal", sys, ext);
      if (e.sd_kind === "real" || e.sd_kind === "symlink") bump("sd", sys, ext);
    }

    // Canonical = extensions that are >= 50% of a folder's files.
    const canonical = new Map<string, Set<string>>();
    function buildCanonical(disk: "internal" | "sd") {
      for (const [sys, em] of dist[disk]) {
        let total = 0;
        for (const c of em.values()) total += c;
        if (total === 0) continue;
        const set = new Set<string>();
        for (const [ext, c] of em) {
          if (c / total >= 0.5) set.add(ext);
        }
        canonical.set(`${disk}:${sys}`, set);
      }
    }
    buildCanonical("internal");
    buildCanonical("sd");

    // Reverse index: for each extension, which (disk,system) pairs have it as canonical?
    const extToCanonicalKeys = new Map<string, string[]>();
    for (const [key, exts] of canonical) {
      for (const ext of exts) {
        if (!extToCanonicalKeys.has(ext)) extToCanonicalKeys.set(ext, []);
        extToCanonicalKeys.get(ext)!.push(key);
      }
    }

    const rows: MisplacedRow[] = [];

    for (const e of scanResult.entries) {
      if (!isAnalysisCandidate(e.relative_path)) continue;
      const sys = topFolder(e.relative_path);
      const fname = e.relative_path.slice(e.relative_path.lastIndexOf("/") + 1);
      const ext = extOf(fname);

      function consider(disk: "internal" | "sd", kind: "real" | "symlink") {
        const em = dist[disk].get(sys);
        if (!em) return;
        let total = 0;
        for (const c of em.values()) total += c;
        const here = em.get(ext) ?? 0;
        const share = total > 0 ? here / total : 0;
        // Flag only if rare in current folder (< 5%) and the system folder name doesn't match the extension.
        if (share >= 0.05) return;
        if (sys.toLowerCase() === ext.replace(".", "")) return; // ".gb" in "gb/" folder is fine

        // Find canonical destinations for this extension on the SAME disk
        const candidates = (extToCanonicalKeys.get(ext) ?? []).filter((k) => k.startsWith(`${disk}:`) && k !== `${disk}:${sys}`);
        let suggested: string | null = null;
        if (candidates.length === 1) {
          suggested = candidates[0].slice(`${disk}:`.length);
        }

        const root = disk === "internal" ? result.internal_root : result.sd_root;
        const currentAbsPath = joinPath(root, e.relative_path);
        const suggestedAbsPath = suggested
          ? joinPath(root, `${suggested}/${fname}`)
          : null;

        rows.push({
          disk,
          currentSystem: sys,
          suggestedSystem: suggested,
          relativePath: e.relative_path,
          filename: fname,
          size: e.size,
          ext,
          currentAbsPath,
          suggestedAbsPath,
          kind,
        });
      }

      if (e.internal_kind === "real") consider("internal", "real");
      else if (e.internal_kind === "symlink") consider("internal", "symlink");
      if (e.sd_kind === "real") consider("sd", "real");
      else if (e.sd_kind === "symlink") consider("sd", "symlink");
    }

    // Keep only rows with a clear destination. "Unusual extensions" without one canonical
    // home elsewhere on the same disk are mostly false positives (alternative valid formats
    // like .gen/.32x in megadrive, or generic archives like .7z/.zip in ps2/n64).
    const actionable = rows.filter((r) => r.suggestedSystem !== null);

    actionable.sort((a, b) => {
      if (a.disk !== b.disk) return a.disk.localeCompare(b.disk);
      if (a.currentSystem !== b.currentSystem) return a.currentSystem.localeCompare(b.currentSystem);
      return a.filename.localeCompare(b.filename);
    });

    return { misplacedRows: actionable, canonicalMap: canonical };
  }, [scanResult]);

  function rowKey(r: MisplacedRow): string {
    return `${r.disk}:${r.currentAbsPath}`;
  }

  const actionableRows = useMemo(() => misplacedRows.filter((r) => r.suggestedAbsPath), [misplacedRows]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllActionable = useCallback(() => {
    setSelected(new Set(actionableRows.map(rowKey)));
  }, [actionableRows]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const applyMoves = useCallback(async () => {
    const picks = actionableRows.filter((r) => selected.has(rowKey(r)));
    if (picks.length === 0) return;
    setApplying(true);
    setMoveLog([]);
    setRowStatus(new Map());
    const log: string[] = [];
    const status = new Map<string, "fixed" | "failed">();
    let okCount = 0;
    let failCount = 0;
    for (const r of picks) {
      const key = rowKey(r);
      try {
        const res = await invoke<RebalanceMoveResult>("rename_remote_file", {
          deckIp,
          deckPassword: password,
          srcPath: r.currentAbsPath,
          dstPath: r.suggestedAbsPath!,
        });
        if (res.ok) {
          okCount++;
          log.push(`OK   ${r.relativePath} -> ${r.suggestedSystem}/${r.filename}`);
          status.set(key, "fixed");
        } else {
          failCount++;
          log.push(`FAIL ${r.relativePath} - ${res.message}`);
          status.set(key, "failed");
        }
      } catch (e) {
        failCount++;
        log.push(`FAIL ${r.relativePath} - ${String(e)}`);
        status.set(key, "failed");
      }
      setMoveLog([...log]);
      setRowStatus(new Map(status));
    }
    log.push("");
    log.push(`Done: ${okCount} fixed, ${failCount} failed.`);
    setMoveLog([...log]);
    setApplying(false);
    setSelected(new Set());
  }, [actionableRows, selected, deckIp, password]);

  const copyAnalysis = useCallback(async () => {
    const lines: string[] = [];
    lines.push(`Misplaced ROM analysis`);
    lines.push(`Internal root: ${scanResult?.internal_root}`);
    lines.push(`SD root:       ${scanResult?.sd_root}`);
    lines.push(``);
    lines.push(`Canonical extensions (>= 50% of folder):`);
    const keys = [...canonicalMap.keys()].sort();
    for (const k of keys) {
      const exts = [...(canonicalMap.get(k) ?? new Set())].sort();
      if (exts.length > 0) lines.push(`  ${k}: ${exts.join(", ")}`);
    }
    lines.push(``);
    lines.push(`Misplaced (${misplacedRows.length}):`);
    for (const r of misplacedRows) {
      const dst = r.suggestedSystem ? ` -> ${r.disk}:${r.suggestedSystem}` : `  (no clear destination)`;
      lines.push(`  [${r.disk}] ${r.relativePath}  (${formatMB(r.size)}, ${r.ext})${dst}`);
    }
    await navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }, [scanResult, canonicalMap, misplacedRows]);

  return (
    <div className="rebalance-tab">
      <div className="rebalance-section">
        <div className="rebalance-section-title">Fix ROM paths</div>
        <div className="rebalance-section-hint">
          Detects files whose extension is unusual for the folder they sit in. Uses pure majority rule: if `.sms` is the canonical extension of <code>mastersystem/</code> (more than 50% of files there) and only 3% of <code>gamegear/</code> files are `.sms`, those `.sms` files in <code>gamegear/</code> are flagged. Moves stay on the same disk (instant rename, no copy).
        </div>
      </div>

      <div className="rebalance-section">
        <label className="rebalance-label">Internal ROMs folder</label>
        <input className="rebalance-input" value={internalRoot} onChange={(e) => setInternalRoot(e.target.value)} disabled={scanning || applying} />
        <label className="rebalance-label">SD card ROMs folder</label>
        <input className="rebalance-input" value={sdRoot} onChange={(e) => setSdRoot(e.target.value)} disabled={scanning || applying} />
        <div className="rebalance-btn-row">
          <button className="rebalance-btn" onClick={runScan} disabled={scanning || applying}>
            {scanning ? "Scanning..." : "Scan for misplaced ROMs"}
          </button>
          <button
            className="rebalance-btn rebalance-btn-danger"
            onClick={applyMoves}
            disabled={applying || scanning || selected.size === 0}
            title={selected.size === 0 ? "Select rows in the table below first" : "Move the selected files"}
          >
            Fix ROM paths{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </div>
        {scanError && <div className="rebalance-error">{scanError}</div>}
      </div>

      {scanResult && misplacedRows.length === 0 && !applying && (
        <div className="rebalance-section">
          <div className="rebalance-section-hint">No misplaced ROMs found. Library looks clean.</div>
        </div>
      )}

      {(applying || moveLog.length > 0) && (
        <div className="rebalance-section">
          <div className="rebalance-section-title">{applying ? "Moving..." : "Run complete"}</div>
          <div className="rebalance-log">
            {moveLog.map((line, i) => (
              <div className={`rebalance-log-line ${line.startsWith("FAIL") ? "fail" : line.startsWith("OK") ? "ok" : ""}`} key={i}>{line}</div>
            ))}
          </div>
        </div>
      )}

      {misplacedRows.length > 0 && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">
              {misplacedRows.length} misplaced ROM{misplacedRows.length === 1 ? "" : "s"} found
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="rebalance-copy-btn" onClick={selectAllActionable}>Select all suggested</button>
              <button className="rebalance-copy-btn" onClick={clearSelection}>Clear</button>
              <button className="rebalance-copy-btn" onClick={copyAnalysis}>Copy</button>
            </div>
          </div>
          <table className="misplaced-table">
            <thead>
              <tr>
                <th></th>
                <th>Disk</th>
                <th>Current</th>
                <th>File</th>
                <th>Ext</th>
                <th>Size</th>
                <th>Kind</th>
                <th>Suggested</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {misplacedRows.map((r) => {
                const key = rowKey(r);
                const canSelect = !!r.suggestedAbsPath;
                const status = rowStatus.get(key);
                const rowClass = status === "fixed" ? "misplaced-row-fixed"
                  : status === "failed" ? "misplaced-row-failed"
                  : canSelect ? ""
                  : "misplaced-row-noop";
                return (
                  <tr key={key} className={rowClass}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!canSelect || applying || status === "fixed"}
                        checked={selected.has(key)}
                        onChange={() => toggleSelect(key)}
                      />
                    </td>
                    <td>{r.disk}</td>
                    <td>{r.currentSystem}</td>
                    <td title={r.relativePath}>{r.filename}</td>
                    <td>{r.ext}</td>
                    <td>{formatMB(r.size)}</td>
                    <td>{r.kind}</td>
                    <td>{r.suggestedSystem ?? "(no clear destination)"}</td>
                    <td>
                      {status === "fixed" && <span className="misplaced-badge-fixed">Fixed</span>}
                      {status === "failed" && <span className="misplaced-badge-failed">Failed</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
