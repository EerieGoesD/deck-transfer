import { invoke } from "@tauri-apps/api/core";
import type { TransferStats } from "../types";
import { SPEED_OPTIONS } from "../types";
import { formatSize, formatSpeed } from "../utils";
import type { License } from "../licensing";

interface MacSettingsProps {
  connectionMode: "ethernet" | "wifi";
  speedLimit: number;
  transferProtocol: "sftp" | "scp";
  autoClear: boolean;
  connected: boolean;
  transferring: boolean;
  transferStats: TransferStats;
  metricsOn: boolean;
  lic: License;
  onConnectionMode: (mode: "ethernet" | "wifi") => void;
  onSpeedLimit: (limit: number) => void;
  onProtocol: (protocol: "sftp" | "scp") => void;
  onAutoClear: (on: boolean) => void;
  onMetrics: (on: boolean) => void;
  onDisconnect: () => void;
  onImported: () => void;
  onOpenDebug: () => void;
  onClose: () => void;
}

// Settings on a Mac, laid out like the Mac's own System Settings: sections, each
// a small heading over one rounded list of full-width rows, with switches and
// menus on the right of their row.
export default function MacSettings(p: MacSettingsProps) {
  const exportConfig = async () => {
    try {
      const json = await invoke<string>("export_profile");
      await invoke("save_profile_to_file", { json });
    } catch (e) {
      console.error("Export failed:", e);
    }
  };

  const importConfig = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        await invoke("import_profile", { json: text });
        p.onImported();
      } catch (err) {
        console.error("Import failed:", err);
      }
    };
    input.click();
  };

  return (
    <div className="dialog-overlay mac-settings-overlay" onClick={p.onClose}>
      <div className="mac-settings" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Settings">
        <div className="mac-settings-head">
          <h3>Settings</h3>
          <button className="mac-settings-close" onClick={p.onClose} title="Close" aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="mac-settings-body">
          <div className="mac-settings-heading">Connection</div>
          <div className="mac-settings-group">
            <label className="mac-settings-row">
              <span className="mac-settings-text">
                <span className="mac-settings-title">Connection mode</span>
                {p.connected && <span className="mac-settings-hint">Disconnect to change it.</span>}
              </span>
              <select
                className="mac-settings-select"
                value={p.connectionMode}
                disabled={p.connected}
                onChange={(e) => p.onConnectionMode(e.target.value as "ethernet" | "wifi")}
              >
                <option value="ethernet">Ethernet</option>
                <option value="wifi">Wi-Fi</option>
              </select>
            </label>
            {p.connected && (
              <button className="mac-settings-row mac-settings-action mac-settings-danger" onClick={p.onDisconnect}>
                Disconnect
              </button>
            )}
          </div>

          <div className="mac-settings-heading">Transfers</div>
          <div className="mac-settings-group">
            <label className="mac-settings-row">
              <span className="mac-settings-text">
                <span className="mac-settings-title">Transfer speed limit</span>
              </span>
              <select
                className="mac-settings-select"
                value={p.speedLimit}
                onChange={(e) => p.onSpeedLimit(Number(e.target.value))}
              >
                {SPEED_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="mac-settings-row">
              <span className="mac-settings-text">
                <span className="mac-settings-title">Transfer protocol</span>
                <span className="mac-settings-hint">
                  {p.transferProtocol === "sftp"
                    ? "Recommended for batches of small files. Reuses a single connection for all transfers."
                    : "Simple and reliable. Opens a new connection per file - slower for many small files."}
                </span>
              </span>
              <select
                className="mac-settings-select"
                value={p.transferProtocol}
                disabled={p.transferring}
                onChange={(e) => p.onProtocol(e.target.value as "sftp" | "scp")}
              >
                <option value="sftp">SFTP</option>
                <option value="scp">SCP</option>
              </select>
            </label>
            <label className="mac-settings-row">
              <span className="mac-settings-text">
                <span className="mac-settings-title">Auto-clear files after successful transfer</span>
              </span>
              <input
                type="checkbox"
                className="mac-switch"
                role="switch"
                checked={p.autoClear}
                onChange={(e) => p.onAutoClear(e.target.checked)}
              />
            </label>
          </div>

          <div className="mac-settings-heading">Display</div>
          <div className="mac-settings-group">
            <label className="mac-settings-row">
              <span className="mac-settings-text">
                <span className="mac-settings-title">Show app usage</span>
                <span className="mac-settings-hint">How much this app is using, shown under its name.</span>
              </span>
              <input
                type="checkbox"
                className="mac-switch"
                role="switch"
                checked={p.metricsOn}
                onChange={(e) => p.onMetrics(e.target.checked)}
              />
            </label>
          </div>

          <div className="mac-settings-heading">Transfer stats</div>
          <div className="mac-settings-group">
            <div className="mac-settings-row">
              <span className="mac-settings-title">Total transferred</span>
              <span className="mac-settings-value">{formatSize(p.transferStats.total_bytes)}</span>
            </div>
            <div className="mac-settings-row">
              <span className="mac-settings-title">Files sent</span>
              <span className="mac-settings-value">{p.transferStats.total_files}</span>
            </div>
            <div className="mac-settings-row">
              <span className="mac-settings-title">Sessions</span>
              <span className="mac-settings-value">{p.transferStats.total_sessions}</span>
            </div>
            <div className="mac-settings-row">
              <span className="mac-settings-title">Avg speed</span>
              <span className="mac-settings-value">
                {p.transferStats.avg_speed_bps > 0 ? formatSpeed(p.transferStats.avg_speed_bps) : "-"}
              </span>
            </div>
          </div>

          <div className="mac-settings-heading">Configuration</div>
          <div className="mac-settings-group">
            <button className="mac-settings-row mac-settings-action" onClick={exportConfig}>
              <span className="mac-settings-text">
                <span className="mac-settings-title">Export Config</span>
                <span className="mac-settings-hint">Save your saved Decks, bookmarks, and settings to a file.</span>
              </span>
            </button>
            <button className="mac-settings-row mac-settings-action" onClick={importConfig}>
              <span className="mac-settings-text">
                <span className="mac-settings-title">Import Config</span>
                <span className="mac-settings-hint">Restore them on a new Mac or after reinstalling.</span>
              </span>
            </button>
          </div>

          <div className="mac-settings-heading">Troubleshooting</div>
          <div className="mac-settings-group">
            <button className="mac-settings-row mac-settings-action" onClick={p.onOpenDebug}>
              <span className="mac-settings-title">Open Debug Logs</span>
            </button>
          </div>
        </div>

        <div className="mac-settings-actions">
          {p.lic.storeBuild && (
            <button className="mac-btn mac-btn-ghost" onClick={() => p.lic.restore(false)} disabled={p.lic.busy}>
              Restore Purchases
            </button>
          )}
          <div className="mac-settings-spacer" />
          <button className="mac-btn mac-btn-accent" onClick={p.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
