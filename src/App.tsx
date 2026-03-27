import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface FileEntry {
  id: string;
  name: string;
  path: string;
  size: number;
  progress: number;
  speed: number;
  eta: number;
  status: "pending" | "transferring" | "complete" | "error";
  error?: string;
}

interface DeckInfo {
  ip: string;
  hostname: string;
  interface_name: string;
}

interface RemoteDirEntry {
  name: string;
  is_dir: boolean;
}

interface Conflict {
  fileId: string;
  fileName: string;
  localSize: number;
  remoteSize: number;
}

type ConflictAction = "replace" | "skip" | "replace-all" | "skip-all" | "cancel";

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return bps + " B/s";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(0) + " KB/s";
  if (bps < 1024 * 1024 * 1024)
    return (bps / (1024 * 1024)).toFixed(1) + " MB/s";
  return (bps / (1024 * 1024 * 1024)).toFixed(2) + " GB/s";
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const MAX_RETRIES = 2;

function App() {
  const [deck, setDeck] = useState<DeckInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    scanned: 0,
    total: 0,
    current_interface: "",
  });
  const [scanError, setScanError] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const [currentDir, setCurrentDir] = useState("/home/deck");
  const [dirEntries, setDirEntries] = useState<RemoteDirEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const breadcrumbsRef = useRef<HTMLDivElement>(null);

  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const conflictResolveRef = useRef<((action: ConflictAction) => void) | null>(null);

  // Listen for scan progress
  useEffect(() => {
    const unlisten = listen<{
      scanned: number;
      total: number;
      current_interface: string;
    }>("scan-progress", (event) => {
      setScanProgress(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for transfer progress
  useEffect(() => {
    const unlisten = listen<{
      file_id: string;
      bytes_sent: number;
      total_bytes: number;
      speed_bps: number;
      eta_seconds: number;
    }>("transfer-progress", (event) => {
      const { file_id, bytes_sent, total_bytes, speed_bps, eta_seconds } =
        event.payload;
      const progress =
        total_bytes > 0 ? Math.round((bytes_sent / total_bytes) * 100) : 0;
      setFiles((prev) =>
        prev.map((f) =>
          f.id === file_id
            ? { ...f, progress, speed: speed_bps, eta: eta_seconds }
            : f
        )
      );
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const loadDir = useCallback(
    async (dirPath: string) => {
      if (!deck) return;
      setDirLoading(true);
      setDirError(null);
      try {
        const entries = await invoke<RemoteDirEntry[]>("list_remote_dir", {
          deckIp: deck.ip,
          deckPassword: password,
          remotePath: dirPath,
        });
        setDirEntries(entries);
        setCurrentDir(dirPath);
      } catch (e) {
        setDirError(String(e));
      } finally {
        setDirLoading(false);
      }
    },
    [deck, password]
  );

  useEffect(() => {
    if (deck) loadDir("/home/deck");
  }, [deck]);

  // Auto-scroll breadcrumbs to show the deepest folder
  useEffect(() => {
    if (breadcrumbsRef.current) {
      breadcrumbsRef.current.scrollLeft = breadcrumbsRef.current.scrollWidth;
    }
  }, [currentDir]);

  const navigateTo = useCallback(
    (folderName: string) => {
      const newPath =
        currentDir === "/" ? `/${folderName}` : `${currentDir}/${folderName}`;
      loadDir(newPath);
    },
    [currentDir, loadDir]
  );

  const navigateUp = useCallback(() => {
    const parent = currentDir.split("/").slice(0, -1).join("/") || "/";
    loadDir(parent);
  }, [currentDir, loadDir]);

  const navigateToBreadcrumb = useCallback(
    (index: number) => {
      const parts = currentDir.split("/").filter(Boolean);
      const path = "/" + parts.slice(0, index + 1).join("/");
      loadDir(path);
    },
    [currentDir, loadDir]
  );

  const scanForDeck = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanProgress({ scanned: 0, total: 0, current_interface: "" });
    try {
      const result = await invoke<DeckInfo>("scan_for_deck", {
        deckPassword: password,
      });
      setDeck(result);
    } catch (e) {
      setScanError(String(e));
      setDeck(null);
    } finally {
      setScanning(false);
    }
  }, [password]);

  const addFiles = useCallback((paths: string[], sizes: number[]) => {
    const newFiles: FileEntry[] = paths.map((path, i) => ({
      id: crypto.randomUUID(),
      name: path.split(/[/\\]/).pop() || path,
      path,
      size: sizes[i] || 0,
      progress: 0,
      speed: 0,
      eta: 0,
      status: "pending",
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const paths: string[] = [];
      const sizes: number[] = [];
      if (e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          paths.push(file.name);
          sizes.push(file.size);
        }
      }
      if (paths.length > 0) addFiles(paths, sizes);
    },
    [addFiles]
  );

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await invoke<{ path: string; size: number }[]>("pick_files");
      if (selected.length > 0) {
        addFiles(
          selected.map((f) => f.path),
          selected.map((f) => f.size)
        );
      }
    } catch (e) {
      console.error("File pick failed:", e);
    }
  }, [addFiles]);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const waitForConflictResolution = (): Promise<ConflictAction> => {
    return new Promise((resolve) => {
      conflictResolveRef.current = resolve;
    });
  };

  const handleConflictAction = useCallback((action: ConflictAction) => {
    setShowConflictDialog(false);
    if (conflictResolveRef.current) {
      conflictResolveRef.current(action);
      conflictResolveRef.current = null;
    }
  }, []);

  const transferWithRetry = useCallback(
    async (file: FileEntry, deckIp: string, deckPw: string, remoteDir: string) => {
      let lastError = "";
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await invoke("transfer_file", {
            fileId: file.id,
            filePath: file.path,
            deckIp,
            deckPassword: deckPw,
            remoteDir,
          });
          return; // success
        } catch (e) {
          lastError = String(e);
          const isRetryable =
            lastError.includes("exchange encryption") ||
            lastError.includes("handshake") ||
            lastError.includes("Connection reset");
          if (!isRetryable || attempt === MAX_RETRIES) {
            throw new Error(lastError);
          }
          // Brief pause before retry
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw new Error(lastError);
    },
    []
  );

  const startTransfer = useCallback(async () => {
    if (!deck || files.length === 0) return;

    const pendingToSend = files.filter((f) => f.status !== "complete");
    if (pendingToSend.length === 0) return;

    try {
      // Check for conflicts
      const checks = await invoke<{ file_name: string; exists: boolean; remote_size: number }[]>(
        "check_remote_files",
        {
          deckIp: deck.ip,
          deckPassword: password,
          remoteDir: currentDir,
          fileNames: pendingToSend.map((f) => f.name),
        }
      );

      const foundConflicts: Conflict[] = [];
      for (const check of checks) {
        if (check.exists) {
          const localFile = pendingToSend.find((f) => f.name === check.file_name);
          if (localFile) {
            foundConflicts.push({
              fileId: localFile.id,
              fileName: check.file_name,
              localSize: localFile.size,
              remoteSize: check.remote_size,
            });
          }
        }
      }

      // Show conflict dialog if any
      const toSkip = new Set<string>();
      if (foundConflicts.length > 0) {
        setConflicts(foundConflicts);
        setShowConflictDialog(true);

        const action = await waitForConflictResolution();

        if (action === "cancel") return;
        if (action === "skip" || action === "skip-all") {
          for (const c of foundConflicts) toSkip.add(c.fileId);
        }
        // "replace" or "replace-all" - transfer everything, overwrite
      }

      // Mark skipped
      if (toSkip.size > 0) {
        setFiles((prev) =>
          prev.map((f) =>
            toSkip.has(f.id) ? { ...f, status: "complete", progress: 0, error: "Skipped" } : f
          )
        );
      }

      setTransferring(true);

      for (const file of pendingToSend) {
        if (toSkip.has(file.id)) continue;

        setFiles((prev) =>
          prev.map((f) =>
            f.id === file.id
              ? { ...f, status: "transferring", progress: 0, speed: 0, eta: 0, error: undefined }
              : f
          )
        );

        try {
          await transferWithRetry(file, deck.ip, password, currentDir);

          setFiles((prev) =>
            prev.map((f) =>
              f.id === file.id
                ? { ...f, status: "complete", progress: 100, speed: 0, eta: 0 }
                : f
            )
          );

          // Auto-refresh directory after each successful transfer
          loadDir(currentDir);
        } catch (e) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === file.id ? { ...f, status: "error", error: String(e) } : f
            )
          );
        }
      }

      setTransferring(false);
    } catch (e) {
      console.error("Pre-transfer check failed:", e);
      setTransferring(false);
    }
  }, [deck, files, password, currentDir, loadDir, transferWithRetry]);

  const pendingFiles = files.filter((f) => f.status !== "complete");
  const breadcrumbs = currentDir.split("/").filter(Boolean);
  const folders = dirEntries.filter((e) => e.is_dir);
  const remoteFiles = dirEntries.filter((e) => !e.is_dir);

  return (
    <div className="app">
      <div className="header">
        <h1>Deck Transfer</h1>
        <div
          className={`connection-status ${deck ? "connected" : scanning ? "scanning" : "disconnected"}`}
        >
          <span className={`status-dot ${scanning ? "scanning" : ""}`} />
          {deck ? "Connected" : scanning ? "Scanning..." : "Not connected"}
        </div>
      </div>

      {deck ? (
        <div className="main-layout">
          {/* Left panel */}
          <div className="panel-left">
            <div className="panel-header">
              <span className="panel-title">Destination</span>
              <span className="panel-subtitle">Files will be sent here</span>
            </div>

            <div className="breadcrumb-bar">
              <button
                className="breadcrumb-up"
                onClick={navigateUp}
                disabled={currentDir === "/" || dirLoading}
                title="Go up"
              >
                &larr;
              </button>
              <button
                className="breadcrumb-refresh"
                onClick={() => loadDir(currentDir)}
                disabled={dirLoading}
                title="Refresh"
              >
                &#8635;
              </button>
              <div className="breadcrumbs" title={currentDir} ref={breadcrumbsRef}>
                <button className="breadcrumb-item" onClick={() => loadDir("/")}>
                  /
                </button>
                {breadcrumbs.map((part, i) => (
                  <span key={i} className="breadcrumb-segment">
                    <span className="breadcrumb-sep">/</span>
                    <button
                      className={`breadcrumb-item ${i === breadcrumbs.length - 1 ? "breadcrumb-current" : ""}`}
                      onClick={() => navigateToBreadcrumb(i)}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="dir-list">
              {dirLoading ? (
                <div className="dir-empty">Loading...</div>
              ) : dirError ? (
                <div className="dir-error">{dirError}</div>
              ) : (
                <>
                  {currentDir !== "/" && (
                    <button className="dir-entry dir-entry-up" onClick={navigateUp}>
                      <span className="dir-entry-icon">..</span>
                      <span className="dir-entry-name">Parent folder</span>
                    </button>
                  )}
                  {folders.map((entry) => (
                    <button
                      key={entry.name}
                      className="dir-entry dir-entry-folder"
                      onClick={() => navigateTo(entry.name)}
                    >
                      <span className="dir-entry-icon">&#128193;</span>
                      <span className="dir-entry-name">{entry.name}</span>
                    </button>
                  ))}
                  {remoteFiles.map((entry) => (
                    <div key={entry.name} className="dir-entry dir-entry-file">
                      <span className="dir-entry-icon">&#128196;</span>
                      <span className="dir-entry-name">{entry.name}</span>
                    </div>
                  ))}
                  {folders.length === 0 && remoteFiles.length === 0 && (
                    <div className="dir-empty">Empty folder</div>
                  )}
                </>
              )}
            </div>

            <div className="selected-path" title={currentDir}>
              Sending to: {currentDir}
            </div>
          </div>

          {/* Right panel */}
          <div className="panel-right">
            <div className="panel-header">
              <span className="panel-title">Files to send</span>
              {files.length > 0 && (
                <span className="panel-subtitle">
                  {files.length} file{files.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            <div className="panel-content">
              <div
                className={`drop-zone ${files.length > 0 ? "drop-zone-compact" : ""} ${dragOver ? "drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={handleBrowse}
              >
                {files.length === 0 ? (
                  <>
                    <div className="drop-zone-icon">+</div>
                    <p>
                      Drop files here or{" "}
                      <span className="browse-link">browse</span>
                    </p>
                  </>
                ) : (
                  <p>+ Drop or click to add more files</p>
                )}
              </div>

              {files.length > 0 && (
                <div className="file-list">
                  {files.map((file) => (
                    <div
                      className={`file-item ${file.status === "error" ? "file-item-error" : ""}`}
                      key={file.id}
                    >
                      <div className="file-item-info">
                        <div className="file-item-name">{file.name}</div>
                        <div className="file-item-meta">
                          <span className="file-item-size">
                            {formatSize(file.size)}
                          </span>
                          {file.status === "transferring" && file.speed > 0 && (
                            <>
                              <span className="file-item-speed">
                                {formatSpeed(file.speed)}
                              </span>
                              <span className="file-item-eta">
                                ETA {formatEta(file.eta)}
                              </span>
                            </>
                          )}
                        </div>
                        {file.status === "error" && file.error && (
                          <div className="file-item-error-msg">{file.error}</div>
                        )}
                      </div>
                      <div className="file-item-right">
                        {(file.status === "transferring" ||
                          file.status === "complete") && (
                          <div className="file-item-progress">
                            <div
                              className={`file-item-progress-bar ${file.status === "complete" ? "complete" : ""}`}
                              style={{ width: `${file.progress}%` }}
                            />
                          </div>
                        )}
                        <div
                          className={`file-item-status ${file.status === "error" ? "status-error" : ""}`}
                        >
                          {file.status === "pending" && "Waiting"}
                          {file.status === "transferring" && `${file.progress}%`}
                          {file.status === "complete" && "Done"}
                          {file.status === "error" && "Failed"}
                        </div>
                        {file.status !== "transferring" && (
                          <button
                            className="remove-btn"
                            onClick={() => removeFile(file.id)}
                          >
                            x
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              className="transfer-btn"
              disabled={pendingFiles.length === 0 || transferring}
              onClick={startTransfer}
            >
              {transferring
                ? "Transferring..."
                : `Send ${pendingFiles.length} file${pendingFiles.length !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      ) : (
        <div className="setup-guide">
          <h2>Connect your Steam Deck</h2>
          <div className="setup-steps">
            <div className="step">
              <span className="step-number">1</span>
              <span>Plug an ethernet cable between your PC and Steam Deck</span>
            </div>
            <div className="step">
              <span className="step-number">2</span>
              <div>
                On the Deck, enable Developer Mode:
                <br />
                <span className="step-detail">
                  Settings &gt; System &gt; Enable Developer Mode
                </span>
              </div>
            </div>
            <div className="step">
              <span className="step-number">3</span>
              <div>
                Switch to Desktop Mode, open Konsole (terminal), and run:
                <br />
                <code>passwd</code>
                <span className="step-detail"> - set a password for SSH login</span>
                <br />
                <code>sudo systemctl enable sshd</code>
                <span className="step-detail"> - enable SSH on boot</span>
                <br />
                <code>sudo systemctl start sshd</code>
                <span className="step-detail"> - start SSH now</span>
              </div>
            </div>
            <div className="step">
              <span className="step-number">4</span>
              <span>Enter your Deck password below and click Scan</span>
            </div>
          </div>

          <div className="password-field">
            <label htmlFor="deck-password">Deck password</label>
            <input
              id="deck-password"
              type="password"
              placeholder="The password you set with passwd"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password && !scanning) scanForDeck();
              }}
            />
          </div>

          {scanning && scanProgress.total > 0 && (
            <div className="scan-progress-container">
              <div className="scan-progress-bar">
                <div
                  className="scan-progress-fill"
                  style={{
                    width: `${Math.round((scanProgress.scanned / scanProgress.total) * 100)}%`,
                  }}
                />
              </div>
              <div className="scan-progress-text">
                Scanning {scanProgress.current_interface} -{" "}
                {scanProgress.scanned}/{scanProgress.total} addresses
              </div>
            </div>
          )}

          {scanError && !scanning && (
            <div className="scan-error">{scanError}</div>
          )}

          <button
            className="scan-btn"
            onClick={scanForDeck}
            disabled={scanning || !password}
          >
            {scanning ? "Scanning..." : "Scan for Steam Deck"}
          </button>
        </div>
      )}

      <div className="footer">
        <span>
          Made by{" "}
          <a href="https://eeriegoesd.com" target="_blank" rel="noreferrer" className="footer-author">
            EERIE
          </a>
        </span>
        <span className="footer-sep">|</span>
        <a href="https://buymeacoffee.com/eeriegoesd" target="_blank" rel="noreferrer">
          Buy Me a Coffee
        </a>
        <span className="footer-sep">|</span>
        <a href="https://github.com/EerieGoesD/deck-transfer/discussions" target="_blank" rel="noreferrer">Feedback</a>
        <span className="footer-sep">|</span>
        <a href="https://github.com/EerieGoesD/deck-transfer/issues" target="_blank" rel="noreferrer">Report Issue</a>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
      />

      {/* Conflict dialog */}
      {showConflictDialog && conflicts.length > 0 && (
        <div className="dialog-overlay">
          <div className="dialog">
            <div className="dialog-title">
              {conflicts.length === 1
                ? "File already exists"
                : `${conflicts.length} files already exist`}
            </div>
            <div className="dialog-body">
              <div className="conflict-list">
                {conflicts.map((c) => (
                  <div key={c.fileId} className="conflict-row">
                    <div className="conflict-name">{c.fileName}</div>
                    <div className="conflict-sizes">
                      <span>Local: {formatSize(c.localSize)}</span>
                      <span>Remote: {formatSize(c.remoteSize)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="dialog-hint">
                What would you like to do with {conflicts.length === 1 ? "this file" : "these files"}?
              </div>
            </div>
            <div className="dialog-actions">
              <div className="dialog-actions-row">
                <button
                  className="dialog-btn dialog-btn-primary"
                  onClick={() => handleConflictAction("replace-all")}
                >
                  Replace {conflicts.length === 1 ? "" : "all "}existing
                </button>
                <button
                  className="dialog-btn"
                  onClick={() => handleConflictAction("skip-all")}
                >
                  Skip {conflicts.length === 1 ? "" : "all "}existing
                </button>
              </div>
              <button
                className="dialog-btn dialog-btn-cancel"
                onClick={() => handleConflictAction("cancel")}
              >
                Cancel transfer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
