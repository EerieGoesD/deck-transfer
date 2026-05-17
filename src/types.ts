export interface FileEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  progress: number;
  speed: number;
  eta: number;
  status: "pending" | "transferring" | "paused" | "complete" | "error";
  error?: string;
}

export interface DeckInfo {
  ip: string;
  hostname: string;
  interface_name: string;
}

export interface RemoteDirEntry {
  name: string;
  is_dir: boolean;
}

export interface Conflict {
  fileId: string;
  fileName: string;
  localSize: number;
  remoteSize: number;
}

export interface Settings {
  speedLimit: number;
  autoClear: boolean;
  connectionMode: "ethernet" | "wifi";
  directEthernet: boolean | null;
  transferProtocol: "sftp" | "scp";
}

export interface SavedConnection {
  id: string;
  hostname: string;
  ip: string;
  password: string;
  connection_mode: string;
  last_used: string;
}

export interface Bookmark {
  id: string;
  path: string;
  label: string;
  connection_id: string | null;
}

export interface TransferStats {
  total_bytes: number;
  total_files: number;
  total_sessions: number;
  avg_speed_bps: number;
}

export type ConflictAction = "replace" | "skip" | "replace-all" | "skip-all" | "cancel";

export type Tab = "transfer" | "sync" | "history" | "rebalance" | "fix-rom-paths" | "cleanup" | "rom-finder" | "settings";

export interface RomScanEntry {
  relative_path: string;
  internal_kind: "real" | "symlink" | "missing";
  sd_kind: "real" | "symlink" | "missing";
  size: number;
  real_location: "internal" | "sd" | "none" | "both";
  symlink_target_internal: string;
  symlink_target_sd: string;
}

export interface RomScanResult {
  internal_root: string;
  sd_root: string;
  internal_total: number;
  internal_used: number;
  sd_total: number;
  sd_used: number;
  entries: RomScanEntry[];
}

export interface RebalanceMoveResult {
  ok: boolean;
  message: string;
}

export const SPEED_OPTIONS = [
  { label: "Unlimited", value: 0 },
  { label: "1 MB/s", value: 1024 * 1024 },
  { label: "5 MB/s", value: 5 * 1024 * 1024 },
  { label: "10 MB/s", value: 10 * 1024 * 1024 },
  { label: "25 MB/s", value: 25 * 1024 * 1024 },
  { label: "50 MB/s", value: 50 * 1024 * 1024 },
  { label: "100 MB/s", value: 100 * 1024 * 1024 },
];
