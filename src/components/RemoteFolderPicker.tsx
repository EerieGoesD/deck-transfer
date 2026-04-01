import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RemoteDirEntry {
  name: string;
  is_dir: boolean;
}

interface RemoteFolderPickerProps {
  deckIp: string;
  password: string;
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export default function RemoteFolderPicker({
  deckIp,
  password,
  initialPath,
  onSelect,
  onClose,
}: RemoteFolderPickerProps) {
  const [currentDir, setCurrentDir] = useState(initialPath || "/home/deck");
  const [entries, setEntries] = useState<RemoteDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDir = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<RemoteDirEntry[]>("list_remote_dir", {
          deckIp,
          deckPassword: password,
          remotePath: path,
        });
        setEntries(result);
        setCurrentDir(path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [deckIp, password]
  );

  useEffect(() => {
    loadDir(currentDir);
  }, []);

  const navigateUp = useCallback(() => {
    const parent = currentDir.split("/").slice(0, -1).join("/") || "/";
    loadDir(parent);
  }, [currentDir, loadDir]);

  const folders = entries.filter((e) => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="rfp-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rfp-header">
          <h2>Select Deck Folder</h2>
          <button className="settings-close" onClick={onClose}>x</button>
        </div>

        <div className="rfp-path">
          <span className="rfp-path-label">Current:</span>
          <span className="rfp-path-value">{currentDir}</span>
        </div>

        <div className="rfp-list">
          {loading ? (
            <div className="rfp-loading">Loading...</div>
          ) : error ? (
            <div className="rfp-error">{error}</div>
          ) : (
            <>
              {currentDir !== "/" && (
                <button className="rfp-entry rfp-entry-up" onClick={navigateUp}>
                  <span className="rfp-entry-icon">..</span>
                  <span>Parent folder</span>
                </button>
              )}
              {folders.length === 0 && (
                <div className="rfp-empty">No subfolders</div>
              )}
              {folders.map((folder) => (
                <button
                  key={folder.name}
                  className="rfp-entry"
                  onClick={() => {
                    const newPath = currentDir === "/" ? `/${folder.name}` : `${currentDir}/${folder.name}`;
                    loadDir(newPath);
                  }}
                >
                  <span className="rfp-entry-icon">&#128193;</span>
                  <span>{folder.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="rfp-actions">
          <button className="rfp-select-btn" onClick={() => onSelect(currentDir)}>
            Select this folder
          </button>
          <button className="schedule-cancel-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
