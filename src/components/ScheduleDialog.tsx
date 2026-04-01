import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

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

interface ScheduleDialogProps {
  deckIp: string;
  password: string;
  currentRemoteDir: string;
  onClose: () => void;
  onSaved: () => void;
  existing?: ScheduleConfig;
}

export default function ScheduleDialog({
  deckIp,
  password,
  currentRemoteDir,
  onClose,
  onSaved,
  existing,
}: ScheduleDialogProps) {
  const [name, setName] = useState(existing?.name || "");
  const [localDir, setLocalDir] = useState(existing?.local_dir || "");
  const [remoteDir, setRemoteDir] = useState(existing?.remote_dir || currentRemoteDir);
  const [hour, setHour] = useState(existing?.hour ?? 2);
  const [minute, setMinute] = useState(existing?.minute ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFolder = useCallback(async () => {
    try {
      const selected = await invoke<string | null>("pick_local_folder");
      if (selected) setLocalDir(selected);
    } catch {
      // User cancelled
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !localDir.trim() || !remoteDir.trim()) {
      setError("Please fill in all fields.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const schedule: ScheduleConfig = {
        id: existing?.id || crypto.randomUUID(),
        name: name.trim(),
        schedule_type: "sync",
        local_dir: localDir.trim(),
        remote_dir: remoteDir.trim(),
        deck_ip: deckIp,
        deck_password: password,
        hour,
        minute,
        enabled: true,
        last_run: existing?.last_run || null,
        speed_limit: 0,
      };
      await invoke("create_schedule", { schedule });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [name, localDir, remoteDir, hour, minute, deckIp, password, existing, onSaved]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="schedule-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="schedule-dialog-header">
          <h2>{existing ? "Edit Schedule" : "New Schedule"}</h2>
          <button className="settings-close" onClick={onClose}>x</button>
        </div>

        <div className="schedule-field">
          <label className="schedule-label">Name</label>
          <input
            className="schedule-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nightly mod sync"
          />
        </div>

        <div className="schedule-field">
          <label className="schedule-label">Local folder</label>
          <div className="schedule-input-row">
            <input
              className="schedule-input"
              value={localDir}
              onChange={(e) => setLocalDir(e.target.value)}
              placeholder="C:\Users\...\my-files"
            />
            <button className="sync-browse-btn" onClick={pickFolder}>Browse</button>
          </div>
        </div>

        <div className="schedule-field">
          <label className="schedule-label">Deck folder</label>
          <input
            className="schedule-input"
            value={remoteDir}
            onChange={(e) => setRemoteDir(e.target.value)}
            placeholder="/home/deck/..."
          />
        </div>

        <div className="schedule-field">
          <label className="schedule-label">Run at</label>
          <div className="schedule-time-row">
            <select
              className="schedule-time-select"
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i.toString().padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="schedule-time-sep">:</span>
            <select
              className="schedule-time-select"
              value={minute}
              onChange={(e) => setMinute(Number(e.target.value))}
            >
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>
                  {m.toString().padStart(2, "0")}
                </option>
              ))}
            </select>
            <span className="schedule-time-hint">daily</span>
          </div>
        </div>

        {error && <div className="schedule-error">{error}</div>}

        <div className="schedule-actions">
          <button className="schedule-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : existing ? "Update" : "Create Schedule"}
          </button>
          <button className="schedule-cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
