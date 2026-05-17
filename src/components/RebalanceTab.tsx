import { useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RomScanResult, RomScanEntry, RebalanceMoveResult } from "../types";

interface Props {
  deckIp: string;
  password: string;
}

interface MovePlanItem {
  entry: RomScanEntry;
  direction: "to_sd" | "to_internal";
  internalAbsPath: string;
  sdAbsPath: string;
}

const DEFAULT_INTERNAL = "/home/deck/Emulation/roms";
const DEFAULT_SD = "/run/media/deck/EmuDeck/Emulation/roms";

function formatGB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatMB(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function joinPath(root: string, rel: string): string {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${r}/${rel}`;
}

export default function RebalanceTab({ deckIp, password }: Props) {
  const [internalRoot, setInternalRoot] = useState(DEFAULT_INTERNAL);
  const [sdRoot, setSdRoot] = useState(DEFAULT_SD);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<RomScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [moveCursor, setMoveCursor] = useState<{ done: number; total: number; currentFile: string }>({ done: 0, total: 0, currentFile: "" });
  const [moveLog, setMoveLog] = useState<string[]>([]);
  // Per-button copy feedback. Multiple Copy buttons share this component so we key by
  // which button was clicked, otherwise both show "Copied!" at once.
  const [copyState, setCopyState] = useState<{ id: string | null; status: "copied" | "failed" }>({ id: null, status: "copied" });

  // Move strategy: largest-first finishes faster (fewer files moved for the same byte budget),
  // smallest-first balances disks more precisely but generates many tiny moves and runs longer.
  const [strategy, setStrategy] = useState<"smallest" | "largest">("largest");

  // User-configurable threshold: if the % used gap between the two disks is below this, the
  // planner considers them already balanced and returns an empty plan. Default 2.0 pp.
  const [balanceThreshold, setBalanceThreshold] = useState<number>(2);

  // Bidirectional planner: moves files from the less-full disk to the more-full one too,
  // so ROMs from many systems end up on both disks. Net byte movement is unchanged.
  const DISTRIBUTE_FRACTION = 0.3; // 30% of net budget moves "backwards" to add variety

  const copyScanLog = useCallback(async (lines: string[], id: string = "scan") => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyState({ id, status: "copied" });
    } catch {
      setCopyState({ id, status: "failed" });
    }
    setTimeout(() => setCopyState((prev) => (prev.id === id ? { id: null, status: "copied" } : prev)), 1500);
  }, []);

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanResult(null);
    setMoveLog([]);
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

  const plan = useMemo<MovePlanItem[]>(() => {
    if (!scanResult) return [];
    const result = scanResult;
    const { internal_total, internal_used, sd_total, sd_used, entries } = result;
    if (internal_total === 0 || sd_total === 0) return [];

    const internalFree = internal_total - internal_used;
    const sdFree = sd_total - sd_used;
    const internalFreePct = internalFree / internal_total;
    const sdFreePct = sdFree / sd_total;

    const primary: "to_sd" | "to_internal" = internalFreePct < sdFreePct ? "to_sd" : "to_internal";
    const reverse: "to_sd" | "to_internal" = primary === "to_sd" ? "to_internal" : "to_sd";

    let netBytes = 0;
    if (primary === "to_sd") {
      netBytes = (internal_total * sdFree - sd_total * internalFree) / (sd_total + internal_total);
    } else {
      netBytes = (sd_total * internalFree - internal_total * sdFree) / (sd_total + internal_total);
    }
    if (netBytes <= 0) return [];

    // Considered-balanced thresholds: skip the plan when the gap is already small enough
    // that shuffling more files is not worth the I/O cost.
    const BALANCE_NET_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500 MB safety floor
    const internalUsedPct = (internal_used / internal_total) * 100;
    const sdUsedPct = (sd_used / sd_total) * 100;
    const pctDiff = Math.abs(internalUsedPct - sdUsedPct);
    if (netBytes < BALANCE_NET_THRESHOLD_BYTES || pctDiff < balanceThreshold) {
      return [];
    }

    const reverseBudget = netBytes * DISTRIBUTE_FRACTION;
    const primaryBudget = netBytes + reverseBudget;

    // Build a set of "covered base names per system" for multi-file game shells: if a system
    // folder contains a .cue/.gdi/.m3u/.ccd, the matching .bin/.img/.sub siblings must NOT be
    // moved on their own (the pointer references them by relative path).
    const shellExt = new Set([".cue", ".gdi", ".m3u", ".ccd"]);
    const shellBaseBySystem = new Map<string, Set<string>>(); // system -> set of base names (no ext)
    for (const e of entries) {
      const parts = e.relative_path.split("/");
      if (parts.length < 2) continue;
      const top = parts[0].toLowerCase();
      const fname = parts[parts.length - 1].toLowerCase();
      const dot = fname.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = fname.slice(dot);
      if (!shellExt.has(ext)) continue;
      const base = fname.slice(0, dot);
      if (!shellBaseBySystem.has(top)) shellBaseBySystem.set(top, new Set());
      shellBaseBySystem.get(top)!.add(base);
    }

    // Skip entries that are clearly NOT user ROMs.
    function isRomCandidate(rel: string, sizeBytes: number): boolean {
      const parts = rel.split("/");
      if (parts.length < 2) return false;     // root-level files
      if (parts.length > 2) return false;     // anything deeper than system/file.ext (multi-file games, image dirs, save trees)
      const filename = parts[parts.length - 1].toLowerCase();
      const top = parts[0].toLowerCase();
      const dot = filename.lastIndexOf(".");
      const ext = dot >= 0 ? filename.slice(dot) : "";
      const baseName = dot >= 0 ? filename.slice(0, dot) : filename;

      // Top-level folders that hold non-ROM content
      const NON_ROM_TOPS = new Set(["emulators", "cloud", "desktop", "store", "tools", "ports"]);
      if (NON_ROM_TOPS.has(top)) return false;

      // EmuDeck / ES-DE metadata
      if (filename === "metadata.txt" || filename === "systeminfo.txt" || filename === "gamelist.xml") return false;
      if (filename.startsWith("gamelist.xml.")) return false;

      // Files without any extension are almost never ROMs (logs, READMEs, scripts)
      if (ext === "") return false;

      // Non-ROM file extensions
      const SKIP_EXTS = new Set([
        // logs, backups, temp
        ".log", ".bak", ".tmp", ".old",
        // saves and save states
        ".srm", ".sav", ".save", ".state", ".st0", ".st1", ".st2", ".st3", ".st4", ".st5", ".st6", ".st7", ".st8", ".st9", ".dat",
        // multi-file game shell formats (also drop their referenced .bin/.img/.sub below)
        ".cue", ".gdi", ".m3u", ".ccd", ".sub",
        // scripts and binaries (launchers, helper scripts)
        ".sh", ".bat", ".cmd", ".ps1",
        // text, config, docs
        ".txt", ".md", ".ini", ".cfg", ".conf", ".log",
        // images and media (ES-DE scraped art, manuals, screenshots)
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
        // data files for tools, not ROMs
        ".xml", ".json", ".yaml", ".yml", ".html", ".htm", ".csv",
        // emulator patches and helpers
        ".pat", ".ips", ".ups", ".bps", ".xdelta",
        // emulator binaries, scripts, configs (Model 2, MAME, etc. ship these alongside ROMs)
        ".exe", ".dll", ".so", ".lua", ".ps",
        // partial / in-progress downloads
        ".filepart", ".part", ".crdownload", ".aria2",
      ]);
      if (SKIP_EXTS.has(ext)) return false;

      // Disc-image formats with implausibly small sizes are stubs / corrupted leftovers,
      // not real ROMs. A legitimate CD/DVD image is always at least a few hundred KB.
      const DISC_IMAGE_EXTS = new Set([".chd", ".rvz", ".gcz", ".nkit.iso", ".wbfs", ".nrg"]);
      if (DISC_IMAGE_EXTS.has(ext) && sizeBytes < 100 * 1024) return false;

      // .bin / .img / .sub: only safe if no .cue/.gdi/.m3u/.ccd shell shares this basename
      // in the same system folder. Otherwise the pointer would dangle after a move.
      if (ext === ".bin" || ext === ".img" || ext === ".iso") {
        const shells = shellBaseBySystem.get(top);
        if (shells && shells.has(baseName)) return false;
        // Some shells use suffixed bin names like "Game (Track 01).bin" referenced by "Game.cue".
        // If any shell base is a prefix of this base (minus an obvious " (Track" suffix), skip.
        if (shells) {
          for (const s of shells) {
            if (baseName === s) return false;
            const trackIdx = baseName.indexOf(" (track ");
            if (trackIdx > 0 && baseName.slice(0, trackIdx) === s) return false;
          }
        }
        // For ISOs, no shell match means it is a self-contained image, keep it.
        // For .bin / .img with no shell, still risky; default skip.
        if (ext === ".bin" || ext === ".img") return false;
      }

      return true;
    }

    function buildCandidates(dir: "to_sd" | "to_internal"): MovePlanItem[] {
      const out: MovePlanItem[] = [];
      for (const e of entries) {
        if (!isRomCandidate(e.relative_path, e.size)) continue;
        if (dir === "to_sd") {
          if (e.internal_kind !== "real") continue;
          if (e.sd_kind === "real") continue;
        } else {
          if (e.sd_kind !== "real") continue;
          if (e.internal_kind === "real") continue;
        }
        out.push({
          entry: e,
          direction: dir,
          internalAbsPath: joinPath(result.internal_root, e.relative_path),
          sdAbsPath: joinPath(result.sd_root, e.relative_path),
        });
      }
      return out;
    }

    function topFolder(rel: string): string {
      const i = rel.indexOf("/");
      return i < 0 ? "(root)" : rel.slice(0, i);
    }

    function pickBySize(cands: MovePlanItem[], budget: number): MovePlanItem[] {
      const sorted = [...cands].sort((a, b) =>
        strategy === "smallest" ? a.entry.size - b.entry.size : b.entry.size - a.entry.size
      );
      const out: MovePlanItem[] = [];
      let moved = 0;
      for (const c of sorted) {
        if (moved >= budget) break;
        if (c.entry.size === 0) continue;
        out.push(c);
        moved += c.entry.size;
      }
      return out;
    }

    // Round-robin across systems: pick the smallest file from each system in turn, then the
    // 2nd smallest from each, etc. Gives one file per system before doubling up.
    function pickRoundRobin(cands: MovePlanItem[], budget: number): MovePlanItem[] {
      const grouped = new Map<string, MovePlanItem[]>();
      for (const c of cands) {
        const sys = topFolder(c.entry.relative_path);
        if (!grouped.has(sys)) grouped.set(sys, []);
        grouped.get(sys)!.push(c);
      }
      for (const arr of grouped.values()) arr.sort((a, b) =>
        strategy === "smallest" ? a.entry.size - b.entry.size : b.entry.size - a.entry.size
      );

      const systems = [...grouped.keys()].sort();
      const out: MovePlanItem[] = [];
      let moved = 0;
      let depth = 0;
      while (moved < budget) {
        let progressed = false;
        for (const sys of systems) {
          const arr = grouped.get(sys)!;
          if (depth < arr.length) {
            const f = arr[depth];
            if (f.entry.size === 0) { progressed = true; continue; }
            if (moved + f.entry.size > budget && out.length > 0) continue;
            out.push(f);
            moved += f.entry.size;
            progressed = true;
            if (moved >= budget) break;
          }
        }
        if (!progressed) break;
        depth++;
      }
      return out;
    }

    const primaryPicks = pickBySize(buildCandidates(primary), primaryBudget);
    const reversePicks = reverseBudget > 0
      ? pickRoundRobin(buildCandidates(reverse), reverseBudget)
      : [];

    return [...primaryPicks, ...reversePicks];
  }, [scanResult, strategy, balanceThreshold]);

  // Activity log composed from the scan + plan.
  const scanLog = useMemo<string[]>(() => {
    if (!scanResult) return [];
    const lines: string[] = [];
    const { internal_total, internal_used, sd_total, sd_used, entries } = scanResult;
    const internalFree = internal_total - internal_used;
    const sdFree = sd_total - sd_used;
    const internalFreePct = internal_total > 0 ? (internalFree / internal_total) * 100 : 0;
    const sdFreePct = sd_total > 0 ? (sdFree / sd_total) * 100 : 0;

    lines.push(`[scan] Internal root: ${scanResult.internal_root}`);
    lines.push(`[scan] SD root:       ${scanResult.sd_root}`);
    lines.push(`[scan] Scanned ${entries.length} file entries across both roots.`);
    const realInternal = entries.filter((e) => e.internal_kind === "real").length;
    const realSD = entries.filter((e) => e.sd_kind === "real").length;
    const symInternal = entries.filter((e) => e.internal_kind === "symlink").length;
    const symSD = entries.filter((e) => e.sd_kind === "symlink").length;
    lines.push(`[scan]   internal: ${realInternal} real, ${symInternal} symlink`);
    lines.push(`[scan]   sd:       ${realSD} real, ${symSD} symlink`);
    // Per-system breakdown of REAL files on each disk (top-level folder of the relative path)
    function topFolder(rel: string): string {
      const i = rel.indexOf("/");
      return i < 0 ? "(root)" : rel.slice(0, i);
    }
    const realInternalByFolder = new Map<string, number>();
    const realSDByFolder = new Map<string, number>();
    for (const e of entries) {
      if (e.internal_kind === "real") {
        const k = topFolder(e.relative_path);
        realInternalByFolder.set(k, (realInternalByFolder.get(k) ?? 0) + 1);
      }
      if (e.sd_kind === "real") {
        const k = topFolder(e.relative_path);
        realSDByFolder.set(k, (realSDByFolder.get(k) ?? 0) + 1);
      }
    }
    function fmtBreakdown(map: Map<string, number>): string {
      const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
      return rows.map(([k, v]) => `${k}=${v}`).join(", ");
    }
    if (realInternalByFolder.size > 0) {
      lines.push(`[scan]   internal real by system: ${fmtBreakdown(realInternalByFolder)}`);
    }
    if (realSDByFolder.size > 0) {
      lines.push(`[scan]   sd real by system:       ${fmtBreakdown(realSDByFolder)}`);
    }
    // Duplicates: files that are REAL on both disks. These should normally never exist.
    // If they do, the previous rebalance run did not finish cleanly (cp+mv happened but rm
    // failed or the SSH channel dropped before rm could run).
    const dupes = entries.filter((e) => e.internal_kind === "real" && e.sd_kind === "real");
    if (dupes.length > 0) {
      const dupesBytes = dupes.reduce((s, e) => s + e.size, 0);
      lines.push(`[!warn] DUPLICATES detected: ${dupes.length} files exist as REAL on BOTH disks (${formatGB(dupesBytes)} wasted). This usually means a previous rebalance run was interrupted between the copy step and the source-delete step. Use the Cleanup feature to remove the internal-side duplicates safely.`);
    }
    // Mirror the same filter used by the planner so the user sees what is skipped
    const shellExtLog = new Set([".cue", ".gdi", ".m3u", ".ccd"]);
    const shellBaseLog = new Map<string, Set<string>>();
    for (const e of entries) {
      const parts = e.relative_path.split("/");
      if (parts.length < 2) continue;
      const fname = parts[parts.length - 1].toLowerCase();
      const dot = fname.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = fname.slice(dot);
      if (!shellExtLog.has(ext)) continue;
      const tt = parts[0].toLowerCase();
      const base = fname.slice(0, dot);
      if (!shellBaseLog.has(tt)) shellBaseLog.set(tt, new Set());
      shellBaseLog.get(tt)!.add(base);
    }
    function isRomCandidateLog(rel: string, sizeBytes: number): boolean {
      const parts = rel.split("/");
      if (parts.length < 2 || parts.length > 2) return false;
      const filename = parts[parts.length - 1].toLowerCase();
      const top = parts[0].toLowerCase();
      const dot = filename.lastIndexOf(".");
      const ext = dot >= 0 ? filename.slice(dot) : "";
      const baseName = dot >= 0 ? filename.slice(0, dot) : filename;
      const NON_ROM_TOPS = new Set(["emulators", "cloud", "desktop", "store", "tools", "ports"]);
      if (NON_ROM_TOPS.has(top)) return false;
      if (filename === "metadata.txt" || filename === "systeminfo.txt" || filename === "gamelist.xml") return false;
      if (filename.startsWith("gamelist.xml.")) return false;
      if (ext === "") return false;
      const SKIP = new Set([
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
      if (SKIP.has(ext)) return false;
      const DISC_EXTS = new Set([".chd", ".rvz", ".gcz", ".nkit.iso", ".wbfs", ".nrg"]);
      if (DISC_EXTS.has(ext) && sizeBytes < 100 * 1024) return false;
      if (ext === ".bin" || ext === ".img" || ext === ".iso") {
        const shells = shellBaseLog.get(top);
        if (shells) {
          if (shells.has(baseName)) return false;
          for (const s of shells) {
            const trackIdx = baseName.indexOf(" (track ");
            if (trackIdx > 0 && baseName.slice(0, trackIdx) === s) return false;
          }
        }
        if (ext === ".bin" || ext === ".img") return false;
      }
      return true;
    }
    const skipped = entries.filter((e) => (e.internal_kind === "real" || e.sd_kind === "real") && !isRomCandidateLog(e.relative_path, e.size)).length;
    lines.push(`[scan]   skipped (not ROMs): ${skipped} entries (metadata, saves, scripts, images, configs, .bin/.img/.cue/.gdi pairs, deeper-than-system-folder paths, non-ROM top folders)`);
    lines.push("");
    lines.push(`[disk] Internal: ${formatGB(internal_used)} / ${formatGB(internal_total)} (${(100 - internalFreePct).toFixed(1)}% used, ${formatGB(internalFree)} free)`);
    lines.push(`[disk] SD card:  ${formatGB(sd_used)} / ${formatGB(sd_total)} (${(100 - sdFreePct).toFixed(1)}% used, ${formatGB(sdFree)} free)`);
    lines.push("");

    if (plan.length === 0) {
      lines.push(`[plan] Disks already balanced (or no movable candidates found). Nothing to do.`);
      return lines;
    }

    const toSdItems = plan.filter((p) => p.direction === "to_sd");
    const toInternalItems = plan.filter((p) => p.direction === "to_internal");
    const toSdBytes = toSdItems.reduce((s, p) => s + p.entry.size, 0);
    const toInternalBytes = toInternalItems.reduce((s, p) => s + p.entry.size, 0);
    const totalBytes = toSdBytes + toInternalBytes;
    const netBytes = toSdBytes - toInternalBytes;
    const netArrow = netBytes >= 0 ? "Internal -> SD" : "SD -> Internal";

    lines.push(`[plan] Net flow:  ${netArrow}, net ${formatGB(Math.abs(netBytes))}`);
    // Whichever side holds the larger byte total is the PRIMARY (strategy-sorted) pass.
    // The smaller side is the VARIETY (round-robin) pass. Label them by that, not by the
    // hardcoded direction names, so the labels stay correct when net flow reverses.
    const primaryIsToSd = toSdBytes >= toInternalBytes;
    const primaryNote = `${strategy} first`;
    const varietyNote = `round-robin across systems for variety, ${strategy} within each system`;
    if (toSdItems.length > 0) {
      lines.push(`[plan]   Internal -> SD: ${toSdItems.length} files, ${formatGB(toSdBytes)} (${primaryIsToSd ? primaryNote : varietyNote})`);
    }
    if (toInternalItems.length > 0) {
      lines.push(`[plan]   SD -> Internal: ${toInternalItems.length} files, ${formatGB(toInternalBytes)} (${primaryIsToSd ? varietyNote : primaryNote})`);
    }
    lines.push(`[plan] Total moves: ${plan.length} files, ${formatGB(totalBytes)}`);
    if (toSdItems.length > 0) {
      lines.push(`[plan] Symlinks:  Internal -> SD moves do NOT leave a symlink on internal (ES-DE does not scan there).`);
    }
    if (toInternalItems.length > 0) {
      lines.push(`[plan] Symlinks:  SD -> Internal moves replace the SD-side entry with a symlink pointing at internal, so ES-DE keeps the entry.`);
    }
    lines.push("");

    // Expected disk usage after applying both directions
    const newInternalUsed = internal_used - toSdBytes + toInternalBytes;
    const newSdUsed = sd_used + toSdBytes - toInternalBytes;
    const newInternalFreePct = ((internal_total - newInternalUsed) / internal_total) * 100;
    const newSdFreePct = ((sd_total - newSdUsed) / sd_total) * 100;
    lines.push(`[after] Internal would be: ${formatGB(newInternalUsed)} / ${formatGB(internal_total)} (${(100 - newInternalFreePct).toFixed(1)}% used, ${formatGB(internal_total - newInternalUsed)} free)`);
    lines.push(`[after] SD card would be:  ${formatGB(newSdUsed)} / ${formatGB(sd_total)} (${(100 - newSdFreePct).toFixed(1)}% used, ${formatGB(sd_total - newSdUsed)} free)`);
    lines.push("");

    if (toSdItems.length > 0) {
      lines.push(`[files] Internal -> SD (${toSdItems.length}):`);
      for (const p of toSdItems) {
        lines.push(`  ${p.entry.relative_path}  (${formatMB(p.entry.size)})`);
      }
      lines.push("");
    }
    if (toInternalItems.length > 0) {
      lines.push(`[files] SD -> Internal (${toInternalItems.length}):`);
      for (const p of toInternalItems) {
        lines.push(`  ${p.entry.relative_path}  (${formatMB(p.entry.size)})`);
      }
      lines.push("");
    }
    lines.push(`[plan] Click "Rebalance ROMs" below to apply this plan.`);
    return lines;
  }, [scanResult, plan, strategy]);

  const applyPlan = useCallback(async () => {
    if (plan.length === 0) return;
    setApplying(true);
    setMoveLog([]);
    setMoveCursor({ done: 0, total: plan.length, currentFile: "" });
    let okCount = 0;
    let failCount = 0;
    const newLog: string[] = [];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      setMoveCursor({ done: i, total: plan.length, currentFile: item.entry.relative_path });
      try {
        const r = await invoke<RebalanceMoveResult>("move_rom_file", {
          deckIp,
          deckPassword: password,
          internalPath: item.internalAbsPath,
          sdPath: item.sdAbsPath,
          direction: item.direction,
        });
        if (r.ok) {
          okCount++;
          newLog.push(`OK   ${item.entry.relative_path}`);
        } else {
          failCount++;
          newLog.push(`FAIL ${item.entry.relative_path} - ${r.message}`);
        }
      } catch (e) {
        failCount++;
        newLog.push(`FAIL ${item.entry.relative_path} - ${String(e)}`);
      }
      setMoveLog([...newLog]);
    }
    setMoveCursor({ done: plan.length, total: plan.length, currentFile: "" });
    newLog.push("");
    newLog.push(`Done: ${okCount} ok, ${failCount} failed.`);
    setMoveLog([...newLog]);
    setApplying(false);
  }, [plan, deckIp, password]);

  return (
    <div className="rebalance-tab">
      <div className="rebalance-section">
        <div className="rebalance-section-title">Rebalance ROMs between internal storage and SD card</div>
        <div className="rebalance-section-hint">
          ES-DE config says it scans <code>{DEFAULT_SD}</code>. Internal mirror is at <code>{DEFAULT_INTERNAL}</code>.
          The rebalancer moves the smallest real files across disks (and keeps a symlink behind) so ES-DE never loses sight of a ROM. Target: equal % free on each disk.
        </div>
      </div>

      <div className="rebalance-section">
        <label className="rebalance-label">Internal ROMs folder</label>
        <input className="rebalance-input" value={internalRoot} onChange={(e) => setInternalRoot(e.target.value)} disabled={scanning || applying} />
        <label className="rebalance-label">SD card ROMs folder (ES-DE scans here)</label>
        <input className="rebalance-input" value={sdRoot} onChange={(e) => setSdRoot(e.target.value)} disabled={scanning || applying} />
        <label className="rebalance-label" style={{ marginTop: 8 }}>Move strategy</label>
        <div className="rebalance-strategy-row">
          <label className={`rebalance-strategy-option ${strategy === "largest" ? "rebalance-strategy-active" : ""}`}>
            <input
              type="radio"
              name="rebalance-strategy"
              checked={strategy === "largest"}
              onChange={() => setStrategy("largest")}
              disabled={scanning || applying}
            />
            <span>Largest files first <span className="rebalance-strategy-hint">(faster, fewer moves)</span></span>
          </label>
          <label className={`rebalance-strategy-option ${strategy === "smallest" ? "rebalance-strategy-active" : ""}`}>
            <input
              type="radio"
              name="rebalance-strategy"
              checked={strategy === "smallest"}
              onChange={() => setStrategy("smallest")}
              disabled={scanning || applying}
            />
            <span>Smallest files first <span className="rebalance-strategy-hint">(slower, finer balance)</span></span>
          </label>
        </div>
        <label className="rebalance-label" style={{ marginTop: 8 }}>Balance threshold (% gap to skip planning)</label>
        <input
          type="number"
          className="rebalance-input"
          style={{ width: "100px", alignSelf: "flex-start" }}
          value={balanceThreshold}
          onChange={(e) => setBalanceThreshold(Math.max(0, Number(e.target.value) || 0))}
          min="0"
          step="0.1"
          disabled={scanning || applying}
        />
        <div className="rebalance-section-hint" style={{ marginTop: 2 }}>
          If the % used difference between the two disks is below this number, the planner considers them already balanced and proposes no moves. Default 2.0. Lower = stricter / more frequent rebalances; higher = more permissive / less churn.
        </div>
        <div className="rebalance-btn-row">
          <button className="rebalance-btn" onClick={runScan} disabled={scanning || applying}>
            {scanning ? "Scanning..." : "Scan"}
          </button>
          <button
            className="rebalance-btn rebalance-btn-danger"
            onClick={applyPlan}
            disabled={applying || scanning || !scanResult || plan.length === 0}
            title={!scanResult ? "Run Scan first" : plan.length === 0 ? "Nothing to rebalance" : "Apply the plan"}
          >
            Rebalance ROMs
          </button>
        </div>
        {scanError && <div className="rebalance-error">{scanError}</div>}
      </div>

      {scanLog.length > 0 && !applying && (
        <div className="rebalance-section">
          <div className="rebalance-log-header">
            <span className="rebalance-section-title">Scan activity</span>
            <button
              className="rebalance-copy-btn"
              onClick={() => copyScanLog(scanLog, "scan")}
              title="Copy log to clipboard"
            >
              {copyState.id === "scan" && copyState.status === "copied" ? "Copied!" : copyState.id === "scan" && copyState.status === "failed" ? "Copy failed" : "Copy"}
            </button>
          </div>
          <div className="rebalance-log">
            {scanLog.map((line, i) => {
              const cls = line.startsWith("[!warn]") ? "warn"
                : line.startsWith("[scan]") ? "scan"
                : line.startsWith("[disk]") ? "disk"
                : line.startsWith("[plan]") ? "plan"
                : line.startsWith("[after]") ? "after"
                : line.startsWith("[files]") ? "files"
                : "";
              return <div className={`rebalance-log-line ${cls}`} key={i}>{line || " "}</div>;
            })}
          </div>
        </div>
      )}

      {(applying || moveLog.length > 0) && (
        <div className="rebalance-section">
          <div className="rebalance-progress-header">
            <strong>{applying ? "Moving files..." : "Run complete"}</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span>{moveCursor.done} / {moveCursor.total}</span>
              {!applying && moveLog.length > 0 && (
                <button
                  className="rebalance-copy-btn"
                  onClick={() => copyScanLog(moveLog, "run")}
                  title="Copy run log to clipboard"
                >
                  {copyState.id === "run" && copyState.status === "copied" ? "Copied!" : copyState.id === "run" && copyState.status === "failed" ? "Copy failed" : "Copy"}
                </button>
              )}
            </div>
          </div>
          {applying && (
            <div className="rebalance-progress-bar">
              <div className="rebalance-progress-fill" style={{ width: `${moveCursor.total === 0 ? 0 : (moveCursor.done / moveCursor.total) * 100}%` }} />
            </div>
          )}
          {applying && moveCursor.currentFile && (
            <div className="rebalance-progress-current">Currently: {moveCursor.currentFile}</div>
          )}
          <div className="rebalance-log">
            {moveLog.slice(-200).map((line, i) => (
              <div className={`rebalance-log-line ${line.startsWith("FAIL") ? "fail" : line.startsWith("OK") ? "ok" : ""}`} key={i}>{line}</div>
            ))}
          </div>
          {!applying && (
            <button className="rebalance-btn" onClick={runScan}>Re-scan</button>
          )}
        </div>
      )}
    </div>
  );
}
