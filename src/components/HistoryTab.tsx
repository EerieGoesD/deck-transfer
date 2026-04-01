import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatSize } from "../utils";

interface TransferRecord {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  remote_dir: string;
  deck_ip: string;
  protocol: string;
  status: string;
  error: string | null;
  speed_bps: number;
  timestamp: string;
}

interface HistoryTabProps {
  deckIp: string | null;
  password: string;
  isPro: boolean;
  onUpgrade: () => void;
  onResend?: (files: { path: string; size: number }[], remoteDir: string) => void;
}

export default function HistoryTab({ deckIp, isPro, onUpgrade, onResend }: HistoryTabProps) {
  const [records, setRecords] = useState<TransferRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const loadHistory = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const [recs, count] = await Promise.all([
        invoke<TransferRecord[]>("get_transfer_history", { limit: pageSize, offset: p * pageSize }),
        invoke<number>("get_history_count"),
      ]);
      setRecords(recs);
      setTotalCount(count);
      setPage(p);
    } catch (e) {
      console.error("Failed to load history:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory(0);
  }, [loadHistory]);

  const clearHistory = useCallback(async () => {
    try {
      await invoke("clear_transfer_history");
      setRecords([]);
      setTotalCount(0);
      setPage(0);
    } catch (e) {
      console.error("Failed to clear history:", e);
    }
  }, []);

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return iso;
    }
  };

  // Group records by timestamp (same session = same second roughly)
  const groupBySession = (recs: TransferRecord[]) => {
    const groups: { remoteDir: string; deckIp: string; protocol: string; timestamp: string; records: TransferRecord[] }[] = [];
    for (const rec of recs) {
      const last = groups[groups.length - 1];
      if (last && last.remoteDir === rec.remote_dir && last.deckIp === rec.deck_ip && last.timestamp === rec.timestamp) {
        last.records.push(rec);
      } else {
        groups.push({
          remoteDir: rec.remote_dir,
          deckIp: rec.deck_ip,
          protocol: rec.protocol,
          timestamp: rec.timestamp,
          records: [rec],
        });
      }
    }
    return groups;
  };

  const sessions = groupBySession(records);
  const totalPages = Math.ceil(totalCount / pageSize);

  if (loading) {
    return <div className="tab-placeholder"><p>Loading history...</p></div>;
  }

  if (records.length === 0) {
    return (
      <div className="tab-placeholder">
        <div className="tab-placeholder-icon">&#128203;</div>
        <h2>Transfer History</h2>
        <p>No transfers recorded yet. Your transfer history will appear here.</p>
      </div>
    );
  }

  return (
    <div className="history-panel">
      {!isPro && (
        <div className="pro-cta-banner">
          <div className="pro-cta-content">
            <span className="pro-badge">PRO</span>
            <div className="pro-cta-text">
              <strong>Unlock re-send and more</strong>
              <span>Re-send past transfers with one click, schedule automatic syncs, and get desktop notifications.</span>
            </div>
          </div>
          <div className="pro-cta-price">EUR 3.00/month</div>
          <button className="pro-upgrade-btn" onClick={onUpgrade}>Upgrade to Pro</button>
        </div>
      )}
      <div className="history-header">
        <span className="history-count">{totalCount} transfer{totalCount !== 1 ? "s" : ""} recorded</span>
        <button className="clear-all-btn" onClick={clearHistory}>Clear History</button>
      </div>
      <div className="history-list">
        {sessions.map((session, si) => (
          <div key={si} className="history-session">
            <div className="history-session-header">
              <span className="history-session-date">{formatDate(session.timestamp)}</span>
              <span className="history-session-meta">
                {session.protocol.toUpperCase()} to {session.deckIp}:{session.remoteDir}
              </span>
              {onResend && deckIp && (
                <button
                  className="history-resend-btn"
                  onClick={() =>
                    onResend(
                      session.records
                        .filter((r) => r.status === "complete")
                        .map((r) => ({ path: r.file_path, size: r.file_size })),
                      session.remoteDir
                    )
                  }
                  title="Re-send these files"
                >
                  Re-send
                </button>
              )}
            </div>
            <div className="history-session-files">
              {session.records.map((rec) => (
                <div
                  key={rec.id}
                  className={`history-file ${rec.status === "error" ? "history-file-error" : ""}`}
                >
                  <span className="history-file-name">{rec.file_name}</span>
                  <span className="history-file-size">{formatSize(rec.file_size)}</span>
                  <span className={`history-file-status ${rec.status === "error" ? "status-error" : ""}`}>
                    {rec.status === "complete" ? "Done" : "Failed"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="history-pagination">
          <button disabled={page === 0} onClick={() => loadHistory(page - 1)}>Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => loadHistory(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
