import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatSize, formatSpeed } from "../utils";
import ScheduleDialog from "./ScheduleDialog";
import RemoteFolderPicker from "./RemoteFolderPicker";
import type { Bookmark } from "../types";

interface SyncFileEntry {
  name: string;
  local_path: string;
  remote_path: string;
  local_size: number;
  remote_size: number;
  action: string;
  reason: string;
}

interface SyncPlan {
  local_dir: string;
  remote_dir: string;
  files: SyncFileEntry[];
  total_upload_bytes: number;
  total_upload_count: number;
  total_unchanged: number;
}

interface SyncProgress {
  file_name: string;
  file_index: number;
  total_files: number;
  bytes_sent: number;
  total_bytes: number;
  speed_bps: number;
  status: string;
}

interface ScheduleConfig {
  id: string;
  name: string;
  schedule_type: string;
  local_dir: string;
  remote_dir: string;
  deck_ip: string;
  deck_password: string;
  hour: number;
  minute: number;
  enabled: boolean;
  last_run: string | null;
  speed_limit: number;
}

interface SyncTabProps {
  deckIp: string;
  password: string;
  speedLimit: number;
  isPro: boolean;
  onUpgrade: () => void;
  bookmarks: Bookmark[];
}

export default function SyncTab({ deckIp, password, speedLimit, isPro, onUpgrade, bookmarks }: SyncTabProps) {
  const [localDir, setLocalDir] = useState("");
  const [remoteDir, setRemoteDir] = useState("/home/deck");
  const [schedules, setSchedules] = useState<ScheduleConfig[]>([]);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [comparing, setComparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncResult, setSyncResult] = useState<{ success: number; errors: number; bytes: number; errorList: string[] } | null>(null);

  // Listen for sync progress events
  useEffect(() => {
    const unlisten = listen<SyncProgress>("sync-progress", (event) => {
      setSyncProgress(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Load schedules
  useEffect(() => {
    invoke<ScheduleConfig[]>("get_schedules").then(setSchedules).catch(() => {});
  }, []);

  const loadSchedules = useCallback(() => {
    invoke<ScheduleConfig[]>("get_schedules").then(setSchedules).catch(() => {});
  }, []);

  const deleteSchedule = useCallback(async (id: string) => {
    await invoke("delete_schedule", { id });
    loadSchedules();
  }, [loadSchedules]);

  const pickLocalFolder = useCallback(async () => {
    try {
      const selected = await invoke<string | null>("pick_local_folder");
      if (selected) setLocalDir(selected);
    } catch {
      // Fallback: let user type it
    }
  }, []);

  const compare = useCallback(async () => {
    if (!localDir || !remoteDir) return;
    setComparing(true);
    setCompareError(null);
    setPlan(null);
    setSyncResult(null);
    try {
      const result = await invoke<SyncPlan>("compare_folders", {
        deckIp,
        deckPassword: password,
        localDir,
        remoteDir,
      });
      setPlan(result);
    } catch (e) {
      setCompareError(String(e));
    } finally {
      setComparing(false);
    }
  }, [localDir, remoteDir, deckIp, password]);

  const startSync = useCallback(async () => {
    if (!plan) return;
    setSyncing(true);
    setSyncProgress(null);
    setSyncResult(null);
    try {
      const result = await invoke<{ success_count: number; error_count: number; bytes_transferred: number; errors: string[] }>(
        "execute_sync",
        {
          deckIp,
          deckPassword: password,
          plan,
          speedLimit: speedLimit > 0 ? speedLimit : null,
        }
      );
      setSyncResult({
        success: result.success_count,
        errors: result.error_count,
        bytes: result.bytes_transferred,
        errorList: result.errors,
      });
      // Update stats
      if (result.success_count > 0) {
        invoke("update_transfer_stats", {
          bytes: result.bytes_transferred,
          files: result.success_count,
          speed: 0,
        }).catch(() => {});
      }
    } catch (e) {
      setSyncResult({ success: 0, errors: 1, bytes: 0, errorList: [String(e)] });
    } finally {
      setSyncing(false);
      setSyncProgress(null);
    }
  }, [plan, deckIp, password, speedLimit]);

  const uploads = plan?.files.filter((f) => f.action === "upload") || [];
  const unchanged = plan?.files.filter((f) => f.action === "skip") || [];

  return (
    <div className="sync-panel">
      {/* Folder selection */}
      <div className="sync-folders">
        <div className="sync-folder-box">
          <label className="sync-folder-label">Local folder</label>
          <div className="sync-folder-input-row">
            <input
              className="sync-folder-input"
              value={localDir}
              onChange={(e) => setLocalDir(e.target.value)}
              placeholder="C:\Users\...\my-files"
              disabled={syncing}
            />
            <button className="sync-browse-btn" onClick={pickLocalFolder} disabled={syncing}>
              Browse
            </button>
          </div>
        </div>
        <div className="sync-arrow">&#8594;</div>
        <div className="sync-folder-box">
          <label className="sync-folder-label">Deck folder</label>
          <div className="sync-folder-input-row">
            <input
              className="sync-folder-input"
              value={remoteDir}
              onChange={(e) => setRemoteDir(e.target.value)}
              placeholder="/home/deck/..."
              disabled={syncing}
            />
            <button
              className="sync-browse-btn"
              onClick={() => setShowFolderPicker(true)}
              disabled={syncing}
            >
              Browse
            </button>
          </div>
          {bookmarks.length > 0 && (
            <div className="sync-bookmarks-row">
              {bookmarks.map((b) => (
                <button
                  key={b.id}
                  className="sync-bookmark-chip"
                  onClick={() => setRemoteDir(b.path)}
                  title={b.path}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sync-actions">
        <button
          className="sync-compare-btn"
          onClick={compare}
          disabled={!localDir || !remoteDir || comparing || syncing}
        >
          {comparing ? "Comparing..." : "Compare"}
        </button>
        {plan && uploads.length > 0 && (
          <button
            className="sync-start-btn"
            onClick={startSync}
            disabled={syncing}
          >
            {syncing ? "Syncing..." : `Sync ${uploads.length} file${uploads.length !== 1 ? "s" : ""} (${formatSize(plan.total_upload_bytes)})`}
          </button>
        )}
      </div>

      {compareError && <div className="sync-error">{compareError}</div>}

      {/* Sync progress */}
      {syncing && syncProgress && (
        <div className="sync-progress-area">
          <div className="sync-progress-text">
            {syncProgress.file_index + 1} / {syncProgress.total_files} - {syncProgress.file_name}
            {syncProgress.speed_bps > 0 && ` - ${formatSpeed(syncProgress.speed_bps)}`}
          </div>
          <div className="sync-progress-track">
            <div
              className="sync-progress-fill"
              style={{ width: `${syncProgress.total_bytes > 0 ? Math.round((syncProgress.bytes_sent / syncProgress.total_bytes) * 100) : 0}%` }}
            />
          </div>
          <div className="sync-progress-overall">
            Overall: {Math.round(((syncProgress.file_index) / syncProgress.total_files) * 100)}%
          </div>
        </div>
      )}

      {/* Sync result */}
      {syncResult && (
        <div className={`sync-result ${syncResult.errors > 0 ? "sync-result-error" : "sync-result-success"}`}>
          <span>
            Sync complete: {syncResult.success} succeeded, {syncResult.errors} failed
            {syncResult.bytes > 0 && ` - ${formatSize(syncResult.bytes)} transferred`}
          </span>
          {syncResult.errorList.length > 0 && (
            <div className="sync-error-list">
              {syncResult.errorList.slice(0, 5).map((err, i) => (
                <div key={i} className="sync-error-item">{err}</div>
              ))}
              {syncResult.errorList.length > 5 && (
                <div className="sync-error-item">...and {syncResult.errorList.length - 5} more</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Diff view */}
      {plan && (
        <div className="sync-diff">
          {uploads.length === 0 && unchanged.length > 0 && (
            <div className="sync-up-to-date">Everything is up to date. No files to sync.</div>
          )}
          {uploads.length > 0 && (
            <div className="sync-diff-section">
              <div className="sync-diff-header">
                To upload ({uploads.length} file{uploads.length !== 1 ? "s" : ""} - {formatSize(plan.total_upload_bytes)})
              </div>
              <div className="sync-diff-list">
                {uploads.map((f, i) => (
                  <div key={i} className="sync-diff-item sync-diff-upload">
                    <span className="sync-diff-icon">{f.reason === "new" ? "+" : "~"}</span>
                    <span className="sync-diff-name">{f.name}</span>
                    <span className="sync-diff-size">{formatSize(f.local_size)}</span>
                    <span className="sync-diff-reason">
                      {f.reason === "new" ? "New" : "Changed"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {unchanged.length > 0 && (
            <div className="sync-diff-section">
              <div className="sync-diff-header sync-diff-header-muted">
                Unchanged ({unchanged.length} file{unchanged.length !== 1 ? "s" : ""})
              </div>
              <div className="sync-diff-list sync-diff-list-collapsed">
                {unchanged.slice(0, 10).map((f, i) => (
                  <div key={i} className="sync-diff-item sync-diff-skip">
                    <span className="sync-diff-icon">=</span>
                    <span className="sync-diff-name">{f.name}</span>
                    <span className="sync-diff-size">{formatSize(f.local_size)}</span>
                  </div>
                ))}
                {unchanged.length > 10 && (
                  <div className="sync-diff-item sync-diff-skip">
                    <span className="sync-diff-icon">...</span>
                    <span className="sync-diff-name">and {unchanged.length - 10} more unchanged files</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!plan && !comparing && !compareError && (
        <div className="sync-empty">
          <div className="sync-empty-icon">&#128260;</div>
          <p>Select a local folder and a Deck folder, then click Compare to see what needs syncing.</p>
          <p className="sync-empty-hint">Only new or changed files (by size) will be transferred.</p>
        </div>
      )}

      {/* Scheduled syncs */}
      <div className="schedule-section">
        <div className="schedule-section-header">
          <span className="schedule-section-title">
            Scheduled Syncs
            {!isPro && <span className="pro-badge-sm">PRO</span>}
          </span>
          <button
            className="schedule-add-btn"
            onClick={() => {
              if (isPro) {
                setShowScheduleDialog(true);
              } else {
                onUpgrade();
              }
            }}
          >
            + Add Schedule
          </button>
        </div>
        {schedules.length === 0 ? (
          <div className="schedule-empty">
            No scheduled syncs. {isPro ? "Click \"+ Add Schedule\" to create one." : "Upgrade to Pro to schedule automatic syncs."}
          </div>
        ) : (
          <div className="schedule-list">
            {schedules.map((s) => (
              <div key={s.id} className="schedule-item">
                <div className="schedule-item-info">
                  <span className="schedule-item-name">{s.name}</span>
                  <span className="schedule-item-time">
                    Daily at {s.hour.toString().padStart(2, "0")}:{s.minute.toString().padStart(2, "0")}
                  </span>
                  <span className="schedule-item-path">
                    {s.local_dir} &#8594; {s.remote_dir}
                  </span>
                  {s.last_run && (
                    <span className="schedule-item-last">
                      Last run: {new Date(s.last_run).toLocaleString()}
                    </span>
                  )}
                </div>
                <button
                  className="saved-conn-delete"
                  onClick={() => deleteSchedule(s.id)}
                  title="Delete schedule"
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Remote folder picker */}
      {showFolderPicker && (
        <RemoteFolderPicker
          deckIp={deckIp}
          password={password}
          initialPath={remoteDir}
          onSelect={(path) => {
            setRemoteDir(path);
            setShowFolderPicker(false);
          }}
          onClose={() => setShowFolderPicker(false)}
        />
      )}

      {/* Schedule dialog */}
      {showScheduleDialog && (
        <ScheduleDialog
          deckIp={deckIp}
          password={password}
          currentRemoteDir={remoteDir}
          onClose={() => setShowScheduleDialog(false)}
          onSaved={() => {
            setShowScheduleDialog(false);
            loadSchedules();
          }}
        />
      )}
    </div>
  );
}
