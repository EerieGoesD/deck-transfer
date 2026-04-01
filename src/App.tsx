import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Tab, SavedConnection, Bookmark, TransferStats } from "./types";
import SyncTab from "./components/SyncTab";
import HistoryTab from "./components/HistoryTab";
import UpgradeModal from "./components/UpgradeModal";
import { getCachedProStatus, clearProStatus, revalidateCachedKey } from "./services/premium";

interface FileEntry {
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

interface Settings {
  speedLimit: number; // bytes/sec, 0 = unlimited
  autoClear: boolean;
  connectionMode: "ethernet" | "wifi";
  directEthernet: boolean | null; // null = not yet checked
  minimizeToTray: boolean;
  transferProtocol: "sftp" | "scp";
}

const SPEED_OPTIONS = [
  { label: "Unlimited", value: 0 },
  { label: "1 MB/s", value: 1024 * 1024 },
  { label: "5 MB/s", value: 5 * 1024 * 1024 },
  { label: "10 MB/s", value: 10 * 1024 * 1024 },
  { label: "25 MB/s", value: 25 * 1024 * 1024 },
  { label: "50 MB/s", value: 50 * 1024 * 1024 },
  { label: "100 MB/s", value: 100 * 1024 * 1024 },
];

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

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: { name: string; isDir: boolean } | null; // null = empty space
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ name: string; isDir: boolean } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [promptType, setPromptType] = useState<"folder" | "file" | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const [settings, setSettings] = useState<Settings>({
    speedLimit: 0,
    autoClear: false,
    connectionMode: "ethernet",
    directEthernet: null,
    transferProtocol: "sftp",
    minimizeToTray: true,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [ethernetToggling, setEthernetToggling] = useState(false);
  const ethernetTogglingRef = useRef(false);

  const [activeTab, setActiveTab] = useState<Tab>("transfer");
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [transferStats, setTransferStats] = useState<TransferStats>({ total_bytes: 0, total_files: 0, total_sessions: 0, avg_speed_bps: 0 });

  const [isPro, setIsPro] = useState(false);
  const [proEmail, setProEmail] = useState<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // Load persisted data on mount
  useEffect(() => {
    invoke<boolean>("get_direct_ethernet_status").then((enabled) => {
      setSettings((s) => ({ ...s, directEthernet: enabled }));
    });
    invoke<{ speed_limit: number; auto_clear: boolean; connection_mode: string; transfer_protocol: string; minimize_to_tray?: boolean }>("load_settings")
      .then((s) => {
        setSettings((prev) => ({
          ...prev,
          speedLimit: s.speed_limit,
          autoClear: s.auto_clear,
          connectionMode: s.connection_mode as "ethernet" | "wifi",
          transferProtocol: s.transfer_protocol as "sftp" | "scp",
          minimizeToTray: s.minimize_to_tray !== false,
        }));
      })
      .catch(() => {});
    invoke<SavedConnection[]>("get_connections")
      .then(setSavedConnections)
      .catch(() => {});
    invoke<Bookmark[]>("get_bookmarks")
      .then(setBookmarks)
      .catch(() => {});
    invoke<TransferStats>("get_transfer_stats")
      .then(setTransferStats)
      .catch(() => {});
    // Check cached Pro status and re-validate
    getCachedProStatus().then((cached) => {
      if (cached && cached.valid && cached.licenseKey) {
        setIsPro(true);
        setProEmail(cached.email);
        // Re-validate in background (checks if subscription was cancelled)
        revalidateCachedKey().then((stillValid) => {
          if (!stillValid) {
            setIsPro(false);
            setProEmail(null);
          }
        });
      }
    });
  }, []);

  const uiLog = useCallback((msg: string) => {
    invoke("frontend_log", { msg }).catch(() => {});
  }, []);

  const toggleDirectEthernet = useCallback(async (enable: boolean) => {
    uiLog(`toggleDirectEthernet called: enable=${enable}, ref=${ethernetTogglingRef.current}`);
    if (ethernetTogglingRef.current) {
      uiLog("BLOCKED by ref guard");
      return;
    }
    ethernetTogglingRef.current = true;
    setEthernetToggling(true);
    uiLog(`Calling ${enable ? "enable" : "disable"}_direct_ethernet...`);
    try {
      if (enable) {
        await invoke("enable_direct_ethernet");
      } else {
        await invoke("disable_direct_ethernet");
      }
      uiLog("Backend call completed OK");
    } catch (e) {
      uiLog(`Backend call FAILED: ${e}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      const status = await invoke<boolean>("get_direct_ethernet_status");
      uiLog(`Status re-check: ${status}`);
      setSettings((s) => ({ ...s, directEthernet: status }));
    } catch (_) {}
    ethernetTogglingRef.current = false;
    setEthernetToggling(false);
    uiLog("Toggle complete, ref released");
  }, [uiLog]);

  const openDebugWindow = useCallback(async () => {
    try {
      await invoke("open_debug_window");
    } catch (e) {
      console.error("Failed to open debug window:", e);
    }
  }, []);

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
        prev.map((f) => {
          if (f.id !== file_id) return f;
          const done = progress >= 100 && total_bytes > 0;
          return {
            ...f,
            progress,
            speed: done ? 0 : speed_bps,
            eta: done ? 0 : eta_seconds,
            status: done
              ? "complete"
              : f.status === "pending"
                ? "transferring"
                : f.status,
          };
        })
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

  // Close context menu on any click
  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, target: { name: string; isDir: boolean } | null) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, target });
    },
    []
  );

  const handleCreateFolder = useCallback(async () => {
    setContextMenu(null);
    setPromptType("folder");
    setPromptValue("");
  }, []);

  const handleCreateFile = useCallback(async () => {
    setContextMenu(null);
    setPromptType("file");
    setPromptValue("");
  }, []);

  const submitCreate = useCallback(async () => {
    if (!deck || !promptValue.trim()) return;
    const name = promptValue.trim();
    const fullPath = `${currentDir === "/" ? "" : currentDir}/${name}`;
    try {
      if (promptType === "folder") {
        await invoke("create_remote_dir", { deckIp: deck.ip, deckPassword: password, remotePath: fullPath });
      } else {
        await invoke("create_remote_file", { deckIp: deck.ip, deckPassword: password, remotePath: fullPath });
      }
      loadDir(currentDir);
    } catch (e) {
      console.error("Create failed:", e);
    }
    setPromptType(null);
    setPromptValue("");
  }, [deck, password, currentDir, promptType, promptValue, loadDir]);

  const handleRename = useCallback((name: string, isDir: boolean) => {
    setContextMenu(null);
    setRenameTarget({ name, isDir });
    setRenameValue(name);
  }, []);

  const submitRename = useCallback(async () => {
    if (!deck || !renameTarget || !renameValue.trim()) return;
    const oldPath = `${currentDir === "/" ? "" : currentDir}/${renameTarget.name}`;
    const newPath = `${currentDir === "/" ? "" : currentDir}/${renameValue.trim()}`;
    if (oldPath === newPath) {
      setRenameTarget(null);
      return;
    }
    try {
      await invoke("rename_remote", { deckIp: deck.ip, deckPassword: password, oldPath, newPath });
      loadDir(currentDir);
    } catch (e) {
      console.error("Rename failed:", e);
    }
    setRenameTarget(null);
  }, [deck, password, currentDir, renameTarget, renameValue, loadDir]);

  const handleDelete = useCallback(async (name: string, isDir: boolean) => {
    setContextMenu(null);
    const fullPath = `${currentDir === "/" ? "" : currentDir}/${name}`;
    try {
      await invoke("delete_remote", { deckIp: deck!.ip, deckPassword: password, remotePath: fullPath, isDir });
      loadDir(currentDir);
    } catch (e) {
      console.error("Delete failed:", e);
    }
  }, [deck, password, currentDir, loadDir]);

  const scanForDeck = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setScanProgress({ scanned: 0, total: 0, current_interface: "" });
    try {
      const result = await invoke<DeckInfo>("scan_for_deck", {
        deckPassword: password,
        connectionMode: settings.connectionMode,
      });
      setDeck(result);
      // Save connection for future use
      const conn: SavedConnection = {
        id: result.ip,
        hostname: result.hostname,
        ip: result.ip,
        password,
        connection_mode: settings.connectionMode,
        last_used: new Date().toISOString(),
      };
      invoke("save_connection", { connection: conn }).then(() => {
        invoke<SavedConnection[]>("get_connections").then(setSavedConnections).catch(() => {});
      }).catch(() => {});
    } catch (e) {
      setScanError(String(e));
      setDeck(null);
    } finally {
      setScanning(false);
    }
  }, [password, settings.connectionMode]);

  // Persist settings when they change
  const persistSettings = useCallback((s: Settings) => {
    invoke("save_settings", {
      settings: {
        speed_limit: s.speedLimit,
        auto_clear: s.autoClear,
        connection_mode: s.connectionMode,
        transfer_protocol: s.transferProtocol,
        minimize_to_tray: s.minimizeToTray,
      },
    }).catch(() => {});
  }, []);

  const updateSettings = useCallback((updater: (s: Settings) => Settings) => {
    setSettings((prev) => {
      const next = updater(prev);
      persistSettings(next);
      return next;
    });
  }, [persistSettings]);

  // Bookmark management
  const addBookmark = useCallback(async (path: string) => {
    const label = path.split("/").filter(Boolean).pop() || path;
    const bookmark: Bookmark = {
      id: crypto.randomUUID(),
      path,
      label,
      connection_id: deck?.ip || null,
    };
    try {
      await invoke("save_bookmark", { bookmark });
      const updated = await invoke<Bookmark[]>("get_bookmarks");
      setBookmarks(updated);
    } catch (e) {
      console.error("Failed to save bookmark:", e);
    }
  }, [deck]);

  const removeBookmark = useCallback(async (id: string) => {
    try {
      await invoke("delete_bookmark", { id });
      const updated = await invoke<Bookmark[]>("get_bookmarks");
      setBookmarks(updated);
    } catch (e) {
      console.error("Failed to delete bookmark:", e);
    }
  }, []);

  // Connect to a saved connection
  const connectToSaved = useCallback(async (conn: SavedConnection) => {
    setPassword(conn.password);
    setSettings((s) => ({ ...s, connectionMode: conn.connection_mode as "ethernet" | "wifi" }));
    setDeck({ ip: conn.ip, hostname: conn.hostname, interface_name: "" });
    // Update last_used
    const updated = { ...conn, last_used: new Date().toISOString() };
    invoke("save_connection", { connection: updated }).catch(() => {});
  }, []);

  const deleteSavedConnection = useCallback(async (id: string) => {
    try {
      await invoke("delete_connection", { id });
      const updated = await invoke<SavedConnection[]>("get_connections");
      setSavedConnections(updated);
    } catch (e) {
      console.error("Failed to delete connection:", e);
    }
  }, []);

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
    async (file: FileEntry, deckIp: string, deckPw: string, remoteDir: string, speedLimit: number) => {
      let lastError = "";
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await invoke("transfer_file", {
            fileId: file.id,
            filePath: file.path,
            deckIp,
            deckPassword: deckPw,
            remoteDir,
            speedLimit: speedLimit > 0 ? speedLimit : null,
          });
          return; // success
        } catch (e) {
          lastError = String(e);
          const isRetryable =
            lastError.includes("exchange encryption") ||
            lastError.includes("handshake") ||
            lastError.includes("Connection reset") ||
            lastError.includes("Unable to send channel data") ||
            lastError.includes("channel data");
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

  const pauseFile = useCallback(async (fileId: string) => {
    await invoke("pause_transfer", { fileId });
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status: "paused" as const, speed: 0 } : f))
    );
  }, []);

  const resumeFile = useCallback(async (fileId: string) => {
    await invoke("resume_transfer", { fileId });
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status: "transferring" as const } : f))
    );
  }, []);

  const cancelFile = useCallback(async (fileId: string) => {
    await invoke("cancel_transfer", { fileId });
  }, []);

  const retryFile = useCallback(
    async (fileId: string) => {
      if (!deck) return;
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status: "transferring", progress: 0, speed: 0, eta: 0, error: undefined }
            : f
        )
      );

      try {
        if (settings.transferProtocol === "sftp") {
          const results = await invoke<{ file_id: string; success: boolean; error: string | null }[]>(
            "transfer_batch_sftp",
            {
              files: [{ file_id: file.id, file_path: file.path }],
              deckIp: deck.ip,
              deckPassword: password,
              remoteDir: currentDir,
              speedLimit: settings.speedLimit > 0 ? settings.speedLimit : null,
            }
          );
          const result = results.find((r) => r.file_id === file.id);
          if (result && !result.success) {
            throw new Error(result.error || "Transfer failed");
          }
        } else {
          await transferWithRetry(file, deck.ip, password, currentDir, settings.speedLimit);
        }
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId
              ? { ...f, status: "complete", progress: 100, speed: 0, eta: 0 }
              : f
          )
        );
        loadDir(currentDir);
      } catch (e) {
        setFiles((prev) =>
          prev.map((f) =>
            f.id === fileId ? { ...f, status: "error", error: String(e) } : f
          )
        );
      }
    },
    [deck, files, password, currentDir, settings.speedLimit, settings.transferProtocol, loadDir, transferWithRetry]
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

      const filesToTransfer = pendingToSend.filter((f) => !toSkip.has(f.id));

      if (settings.transferProtocol === "sftp") {
        // SFTP batch: one session, one SFTP channel, all files
        // Files stay "pending" until the backend emits their first progress event
        setFiles((prev) =>
          prev.map((f) =>
            filesToTransfer.some((tf) => tf.id === f.id)
              ? { ...f, progress: 0, speed: 0, eta: 0, error: undefined }
              : f
          )
        );

        try {
          const batchFiles = filesToTransfer.map((f) => ({
            file_id: f.id,
            file_path: f.path,
          }));

          const results = await invoke<{ file_id: string; success: boolean; error: string | null }[]>(
            "transfer_batch_sftp",
            {
              files: batchFiles,
              deckIp: deck.ip,
              deckPassword: password,
              remoteDir: currentDir,
              speedLimit: settings.speedLimit > 0 ? settings.speedLimit : null,
            }
          );

          setFiles((prev) =>
            prev.map((f) => {
              const result = results.find((r) => r.file_id === f.id);
              if (!result) return f;
              if (result.success) {
                return { ...f, status: "complete", progress: 100, speed: 0, eta: 0 };
              }
              return { ...f, status: "error", error: result.error || "Transfer failed" };
            })
          );

          loadDir(currentDir);
        } catch (e) {
          // Session-level failure - mark all as error
          setFiles((prev) =>
            prev.map((f) =>
              filesToTransfer.some((tf) => tf.id === f.id)
                ? { ...f, status: "error", error: String(e) }
                : f
            )
          );
        }
      } else {
        // SCP: per-file transfer (original behavior)
        for (const file of filesToTransfer) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === file.id
                ? { ...f, status: "transferring", progress: 0, speed: 0, eta: 0, error: undefined }
                : f
            )
          );

          try {
            await transferWithRetry(file, deck.ip, password, currentDir, settings.speedLimit);

            setFiles((prev) =>
              prev.map((f) =>
                f.id === file.id
                  ? { ...f, status: "complete", progress: 100, speed: 0, eta: 0 }
                  : f
              )
            );

            loadDir(currentDir);
          } catch (e) {
            setFiles((prev) =>
              prev.map((f) =>
                f.id === file.id ? { ...f, status: "error", error: String(e) } : f
              )
            );
          }
        }
      }

      setTransferring(false);

      // Record history and update stats
      setFiles((currentFiles) => {
        const transferred = currentFiles.filter((f) =>
          filesToTransfer.some((tf) => tf.id === f.id)
        );
        const completed = transferred.filter((f) => f.status === "complete");
        const totalBytes = completed.reduce((sum, f) => sum + f.size, 0);

        // Record history
        const records = transferred.map((f) => ({
          id: crypto.randomUUID(),
          file_name: f.name,
          file_path: f.path,
          file_size: f.size,
          remote_dir: currentDir,
          deck_ip: deck!.ip,
          protocol: settings.transferProtocol,
          status: f.status === "complete" ? "complete" : "error",
          error: f.error || null,
          speed_bps: 0,
          timestamp: new Date().toISOString(),
        }));
        if (records.length > 0) {
          invoke("record_transfers_batch", { records }).catch(() => {});
        }

        // Update stats
        if (completed.length > 0) {
          invoke("update_transfer_stats", {
            bytes: totalBytes,
            files: completed.length,
            speed: 0,
          }).then(() => {
            invoke<TransferStats>("get_transfer_stats").then(setTransferStats).catch(() => {});
          }).catch(() => {});
        }

        return currentFiles;
      });

      // Send desktop notification
      const completed = filesToTransfer.length;
      invoke("send_notification", {
        title: "Transfer Complete",
        body: `${completed} file${completed !== 1 ? "s" : ""} transferred to ${currentDir}`,
      }).catch(() => {});

      // Auto-clear completed files if enabled
      if (settings.autoClear) {
        setFiles((prev) => prev.filter((f) => f.status !== "complete"));
      }
    } catch (e) {
      console.error("Pre-transfer check failed:", e);
      setTransferring(false);
    }
  }, [deck, files, password, currentDir, loadDir, transferWithRetry, settings.speedLimit, settings.autoClear, settings.transferProtocol]);

  const pendingFiles = files.filter((f) => f.status !== "complete");
  const breadcrumbs = currentDir.split("/").filter(Boolean);
  const folders = dirEntries.filter((e) => e.is_dir);
  const remoteFiles = dirEntries.filter((e) => !e.is_dir);

  return (
    <div className="app">
      <div className="header">
        <h1>Deck Transfer</h1>
        <div className="header-right">
          {deck && (
            <div className="speed-limit-control">
              <label htmlFor="speed-limit">Speed:</label>
              <select
                id="speed-limit"
                value={settings.speedLimit}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  updateSettings((s) => ({ ...s, speedLimit: val }));
                  invoke("set_speed_limit", { limit: val }).catch(() => {});
                }}
              >
                {SPEED_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div
            className={`connection-status ${deck ? "connected" : scanning ? "scanning" : "disconnected"}`}
          >
            <span className={`status-dot ${scanning ? "scanning" : ""}`} />
            {deck
              ? `Connected (${settings.connectionMode === "wifi" ? "Wi-Fi" : "Ethernet"})`
              : scanning
              ? "Scanning..."
              : "Not connected"}
          </div>
          <button
            className="settings-btn"
            onClick={() => setShowSettings((s) => !s)}
            title="Settings"
          >
            &#9881;
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <span className="settings-title">Settings</span>
            <button className="settings-close" onClick={() => setShowSettings(false)}>x</button>
          </div>
          <div className="settings-group">
            <label className="settings-label">Connection mode</label>
            <div className="radio-group">
              <label className={`radio-option ${settings.connectionMode === "ethernet" ? "radio-active" : ""}`}>
                <input
                  type="radio"
                  name="connectionMode"
                  value="ethernet"
                  checked={settings.connectionMode === "ethernet"}
                  onChange={() => updateSettings((s) => ({ ...s, connectionMode: "ethernet" }))}
                  disabled={!!deck}
                />
                Ethernet
              </label>
              <label className={`radio-option ${settings.connectionMode === "wifi" ? "radio-active" : ""}`}>
                <input
                  type="radio"
                  name="connectionMode"
                  value="wifi"
                  checked={settings.connectionMode === "wifi"}
                  onChange={() => updateSettings((s) => ({ ...s, connectionMode: "wifi" }))}
                  disabled={!!deck}
                />
                Wi-Fi
              </label>
            </div>
            {!!deck && (
              <button
                className="btn-disconnect"
                onClick={() => {
                  setDeck(null);
                  setFiles([]);
                  setDirEntries([]);
                  setScanError(null);
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          <div className="settings-group">
            <label className="settings-label">Direct Ethernet mode</label>
            <div className="direct-ethernet-row">
              <span className={`direct-ethernet-status ${settings.directEthernet ? "enabled" : "disabled"}`}>
                {settings.directEthernet === null
                  ? "Checking..."
                  : settings.directEthernet
                  ? "Enabled"
                  : "Disabled"}
              </span>
              <button
                className={`btn-toggle ${ethernetToggling ? "btn-toggle-loading" : settings.directEthernet ? "btn-toggle-off" : "btn-toggle-on"}`}
                onClick={() => { uiLog("[SETTINGS BTN] clicked, directEthernet=" + settings.directEthernet); toggleDirectEthernet(!settings.directEthernet); }}
                disabled={settings.directEthernet === null || ethernetToggling}
              >
                {ethernetToggling ? "Configuring..." : settings.directEthernet ? "Disable" : "Enable"}
              </button>
            </div>
            <span className="settings-hint">
              {settings.directEthernet
                ? "Your Ethernet adapter is configured for direct Deck connection. Disable if you have internet issues on Ethernet."
                : "Enable to connect to a Steam Deck via a direct Ethernet cable. Windows will ask for permission once."}
            </span>
          </div>
          <div className="settings-group">
            <label className="settings-label">Transfer speed limit</label>
            <select
              className="settings-select"
              value={settings.speedLimit}
              onChange={(e) => {
                const val = Number(e.target.value);
                updateSettings((s) => ({ ...s, speedLimit: val }));
                invoke("set_speed_limit", { limit: val }).catch(() => {});
              }}
            >
              {SPEED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-group">
            <label className="settings-label">Transfer protocol</label>
            <div className="radio-group">
              <label className={`radio-option ${settings.transferProtocol === "sftp" ? "radio-active" : ""}`}>
                <input
                  type="radio"
                  name="transferProtocol"
                  value="sftp"
                  checked={settings.transferProtocol === "sftp"}
                  onChange={() => updateSettings((s) => ({ ...s, transferProtocol: "sftp" }))}
                  disabled={transferring}
                />
                SFTP
              </label>
              <label className={`radio-option ${settings.transferProtocol === "scp" ? "radio-active" : ""}`}>
                <input
                  type="radio"
                  name="transferProtocol"
                  value="scp"
                  checked={settings.transferProtocol === "scp"}
                  onChange={() => updateSettings((s) => ({ ...s, transferProtocol: "scp" }))}
                  disabled={transferring}
                />
                SCP
              </label>
            </div>
            <span className="settings-hint">
              {settings.transferProtocol === "sftp"
                ? "Recommended for batches of small files. Reuses a single connection for all transfers."
                : "Simple and reliable. Opens a new connection per file - slower for many small files."}
            </span>
          </div>
          <div className="settings-group">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.autoClear}
                onChange={(e) =>
                  updateSettings((s) => ({ ...s, autoClear: e.target.checked }))
                }
              />
              <span>Auto-clear files after successful transfer</span>
            </label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.minimizeToTray}
                onChange={(e) => {
                  updateSettings((s) => ({ ...s, minimizeToTray: e.target.checked }));
                  invoke("set_minimize_to_tray", { enabled: e.target.checked }).catch(() => {});
                }}
              />
              <span>Minimize to tray when closing</span>
            </label>
          </div>
          <div className="settings-group">
            <label className="settings-label">Transfer stats</label>
            <div className="stats-grid">
              <div className="stat-item">
                <span className="stat-value">{formatSize(transferStats.total_bytes)}</span>
                <span className="stat-label">Total transferred</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{transferStats.total_files}</span>
                <span className="stat-label">Files sent</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{transferStats.total_sessions}</span>
                <span className="stat-label">Sessions</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{transferStats.avg_speed_bps > 0 ? formatSpeed(transferStats.avg_speed_bps) : "-"}</span>
                <span className="stat-label">Avg speed</span>
              </div>
            </div>
          </div>
          <div className="settings-group">
            <label className="settings-label">Configuration</label>
            <span className="settings-hint">
              Export your saved Decks, bookmarks, and settings to a file. Use Import to restore them on a new PC or after reinstalling.
            </span>
            <div className="profile-actions">
              <button className="btn-debug" onClick={async () => {
                try {
                  const json = await invoke<string>("export_profile");
                  await invoke("save_profile_to_file", { json });
                } catch (e) {
                  console.error("Export failed:", e);
                }
              }}>
                Export Config
              </button>
              <button className="btn-debug" onClick={() => {
                const input = document.createElement("input");
                input.type = "file";
                input.accept = ".json";
                input.onchange = async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (!file) return;
                  const text = await file.text();
                  try {
                    await invoke("import_profile", { json: text });
                    invoke<SavedConnection[]>("get_connections").then(setSavedConnections).catch(() => {});
                    invoke<Bookmark[]>("get_bookmarks").then(setBookmarks).catch(() => {});
                    invoke<TransferStats>("get_transfer_stats").then(setTransferStats).catch(() => {});
                  } catch (err) {
                    console.error("Import failed:", err);
                  }
                };
                input.click();
              }}>
                Import Config
              </button>
            </div>
          </div>
          <div className="settings-group">
            <label className="settings-label">Deck Transfer Pro</label>
            {isPro ? (
              <div className="pro-status-section">
                <div className="pro-status-active">
                  <span className="pro-badge">PRO</span>
                  <span className="pro-status-text">Active - {proEmail}</span>
                </div>
                <div className="pro-manage-actions">
                  <button className="pro-manage-btn" onClick={async () => {
                    try {
                      const { getStoredLicenseKey } = await import("./services/premium");
                      const key = await getStoredLicenseKey();
                      if (!key) return;
                      const res = await fetch("https://jhuxxolbcrjerztwqyap.supabase.co/functions/v1/deck-transfer-manage-sub", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ key }),
                      });
                      const data = await res.json();
                      if (data.url) {
                        invoke("open_url", { url: data.url }).catch(() => {});
                      }
                    } catch (e) {
                      console.error("Manage subscription error:", e);
                    }
                  }}>
                    Manage Subscription
                  </button>
                  <button className="pro-logout-btn" onClick={async () => {
                    await clearProStatus();
                    setIsPro(false);
                    setProEmail(null);
                  }}>Sign out</button>
                </div>
              </div>
            ) : (
              <button className="pro-upgrade-btn" onClick={() => { setShowSettings(false); setShowUpgradeModal(true); }}>
                Upgrade to Pro
              </button>
            )}
          </div>
          <div className="settings-group">
            <button className="btn-debug" onClick={openDebugWindow}>
              Open Debug Logs
            </button>
          </div>
          </div>
        </div>
      )}

      {deck ? (
        <>
        {/* Tab bar */}
        <div className="tab-bar">
          <button className={`tab-btn ${activeTab === "transfer" ? "tab-active" : ""}`} onClick={() => setActiveTab("transfer")}>Transfer</button>
          <button className={`tab-btn ${activeTab === "sync" ? "tab-active" : ""}`} onClick={() => setActiveTab("sync")}>Sync</button>
          <button className={`tab-btn ${activeTab === "history" ? "tab-active" : ""}`} onClick={() => setActiveTab("history")}>History <span className="pro-badge-sm">PRO</span></button>
          <div className="tab-spacer" />
        </div>

        <div className="main-layout" style={{ display: activeTab === "transfer" ? "flex" : "none" }}>
          {/* Left panel */}
          <div className="panel-left">
            <div className="panel-header">
              <span className="panel-title">Destination</span>
              <span className="panel-subtitle">Files will be sent here</span>
            </div>

            <div className="bookmark-bar-left">
              <span className="bookmark-section-label">Saved Paths</span>
              {bookmarks.length === 0 && (
                <span className="bookmark-hint">Save folders for quick access</span>
              )}
              {bookmarks.map((b) => (
                <button
                  key={b.id}
                  className="bookmark-btn"
                  onClick={() => loadDir(b.path)}
                  title={b.path}
                >
                  {b.label}
                  <span className="bookmark-remove" onClick={(e) => { e.stopPropagation(); removeBookmark(b.id); }}>x</span>
                </button>
              ))}
              <button
                className="bookmark-add-btn"
                onClick={() => addBookmark(currentDir)}
                title={`Save "${currentDir}" for quick access`}
              >
                + Save path
              </button>
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

            <div
              className="dir-list"
              onContextMenu={(e) => handleContextMenu(e, null)}
            >
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
                  {folders.map((entry) =>
                    renameTarget && renameTarget.name === entry.name ? (
                      <div key={entry.name} className="dir-entry dir-entry-folder">
                        <span className="dir-entry-icon">&#128193;</span>
                        <input
                          className="ctx-inline-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitRename();
                            if (e.key === "Escape") setRenameTarget(null);
                          }}
                          onBlur={submitRename}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <button
                        key={entry.name}
                        className="dir-entry dir-entry-folder"
                        onClick={() => navigateTo(entry.name)}
                        onContextMenu={(e) => handleContextMenu(e, { name: entry.name, isDir: true })}
                      >
                        <span className="dir-entry-icon">&#128193;</span>
                        <span className="dir-entry-name">{entry.name}</span>
                      </button>
                    )
                  )}
                  {remoteFiles.map((entry) =>
                    renameTarget && renameTarget.name === entry.name ? (
                      <div key={entry.name} className="dir-entry dir-entry-file">
                        <span className="dir-entry-icon">&#128196;</span>
                        <input
                          className="ctx-inline-input"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") submitRename();
                            if (e.key === "Escape") setRenameTarget(null);
                          }}
                          onBlur={submitRename}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <div
                        key={entry.name}
                        className="dir-entry dir-entry-file"
                        onContextMenu={(e) => handleContextMenu(e, { name: entry.name, isDir: false })}
                      >
                        <span className="dir-entry-icon">&#128196;</span>
                        <span className="dir-entry-name">{entry.name}</span>
                      </div>
                    )
                  )}
                  {folders.length === 0 && remoteFiles.length === 0 && (
                    <div className="dir-empty">Empty folder</div>
                  )}
                </>
              )}
            </div>

            {/* Create new folder/file inline prompt */}
            {promptType && (
              <div className="ctx-create-prompt">
                <span className="ctx-create-label">{promptType === "folder" ? "New folder:" : "New file:"}</span>
                <input
                  className="ctx-inline-input"
                  placeholder={promptType === "folder" ? "Folder name" : "File name"}
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitCreate();
                    if (e.key === "Escape") setPromptType(null);
                  }}
                  onBlur={() => { if (promptValue.trim()) submitCreate(); else setPromptType(null); }}
                  autoFocus
                />
              </div>
            )}

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

              {files.length > 0 && (() => {
                const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
                const transferredBytes = files.reduce((sum, f) => sum + (f.progress / 100) * f.size, 0);
                const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;
                const activeSpeed = files.reduce((sum, f) => sum + (f.status === "transferring" ? f.speed : 0), 0);
                const remainingBytes = totalBytes - transferredBytes;
                const overallEta = activeSpeed > 0 ? Math.round(remainingBytes / activeSpeed) : 0;
                const completedCount = files.filter((f) => f.status === "complete").length;

                return (
                  <div className="overall-progress-bar-area">
                    <div className="overall-progress-header">
                      <span className="overall-progress-text">
                        {completedCount} / {files.length} files - {overallPercent}%
                        {transferring && activeSpeed > 0 && (
                          <span className="overall-eta"> - {formatEta(overallEta)} remaining</span>
                        )}
                      </span>
                      <button
                        className="clear-all-btn"
                        onClick={() => setFiles([])}
                        disabled={transferring}
                      >
                        Clear All
                      </button>
                    </div>
                    <div className="overall-progress-track">
                      <div
                        className={`overall-progress-fill ${overallPercent === 100 ? "complete" : ""}`}
                        style={{ width: `${overallPercent}%` }}
                      />
                    </div>
                  </div>
                );
              })()}

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
                          file.status === "paused" ||
                          file.status === "complete") && (
                          <div className="file-item-progress">
                            <div
                              className={`file-item-progress-bar ${file.status === "complete" ? "complete" : file.status === "paused" ? "paused" : ""}`}
                              style={{ width: `${file.progress}%` }}
                            />
                          </div>
                        )}
                        <div
                          className={`file-item-status ${file.status === "error" ? "status-error" : file.status === "paused" ? "status-paused" : ""}`}
                        >
                          {file.status === "pending" && "Waiting"}
                          {file.status === "transferring" && `${file.progress}%`}
                          {file.status === "paused" && `${file.progress}%`}
                          {file.status === "complete" && "Done"}
                          {file.status === "error" && "Failed"}
                        </div>
                        {file.status === "transferring" && (
                          <button
                            className="pause-btn"
                            onClick={() => pauseFile(file.id)}
                            title="Pause transfer"
                          >
                            ||
                          </button>
                        )}
                        {file.status === "paused" && (
                          <button
                            className="resume-btn"
                            onClick={() => resumeFile(file.id)}
                            title="Resume transfer"
                          >
                            &#9654;
                          </button>
                        )}
                        {(file.status === "transferring" || file.status === "paused") && (
                          <button
                            className="cancel-btn"
                            onClick={() => cancelFile(file.id)}
                            title="Cancel transfer"
                          >
                            x
                          </button>
                        )}
                        {file.status === "error" && !transferring && (
                          <button
                            className="retry-btn"
                            onClick={() => retryFile(file.id)}
                            title="Retry transfer"
                          >
                            &#8635;
                          </button>
                        )}
                        {(file.status === "pending" || file.status === "error" || file.status === "complete") && (
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

        <div style={{ display: activeTab === "sync" ? "flex" : "none", flex: 1, minHeight: 0 }}>
          <SyncTab deckIp={deck.ip} password={password} speedLimit={settings.speedLimit} isPro={isPro} onUpgrade={() => setShowUpgradeModal(true)} bookmarks={bookmarks} />
        </div>
        <div style={{ display: activeTab === "history" ? "flex" : "none", flex: 1, minHeight: 0 }}>
          <HistoryTab
            deckIp={deck?.ip || null}
            password={password}
            isPro={isPro}
            onUpgrade={() => setShowUpgradeModal(true)}
            onResend={isPro ? (resendFiles, _remoteDir) => {
              // Add files to transfer queue and switch to transfer tab
              const newFiles = resendFiles.map((f) => ({
                id: crypto.randomUUID(),
                name: f.path.split(/[/\\]/).pop() || f.path,
                path: f.path,
                size: f.size,
                progress: 0,
                speed: 0,
                eta: 0,
                status: "pending" as const,
              }));
              setFiles((prev) => [...prev, ...newFiles]);
              setActiveTab("transfer");
            } : undefined}
          />
        </div>
        </>
      ) : (
        <div className="setup-guide">
          <div className="setup-columns">
            {/* Left column - connection config */}
            <div className="setup-left">
              <h2>Connect</h2>

              <div className="setup-section">
                <label className="setup-label">Connection</label>
                <div className="connection-toggle">
                  <label className={`toggle-option ${settings.connectionMode === "ethernet" ? "toggle-active" : ""}`}>
                    <input
                      type="radio"
                      name="setupConnectionMode"
                      value="ethernet"
                      checked={settings.connectionMode === "ethernet"}
                      onChange={() => updateSettings((s) => ({ ...s, connectionMode: "ethernet" }))}
                    />
                    Ethernet
                  </label>
                  <label className={`toggle-option ${settings.connectionMode === "wifi" ? "toggle-active" : ""}`}>
                    <input
                      type="radio"
                      name="setupConnectionMode"
                      value="wifi"
                      checked={settings.connectionMode === "wifi"}
                      onChange={() => updateSettings((s) => ({ ...s, connectionMode: "wifi" }))}
                    />
                    Wi-Fi
                  </label>
                </div>
              </div>

              {settings.connectionMode === "ethernet" && (
                <div className="setup-section">
                  <label className="setup-label">Direct Ethernet</label>
                  <div className="direct-ethernet-row">
                    <span className={`direct-ethernet-status ${settings.directEthernet ? "enabled" : "disabled"}`}>
                      {settings.directEthernet === null
                        ? "Checking..."
                        : settings.directEthernet
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                    <button
                      className={`btn-toggle ${ethernetToggling ? "btn-toggle-loading" : settings.directEthernet ? "btn-toggle-off" : "btn-toggle-on"}`}
                      onClick={() => { uiLog("[SETUP BTN] clicked, directEthernet=" + settings.directEthernet); toggleDirectEthernet(!settings.directEthernet); }}
                      disabled={settings.directEthernet === null || ethernetToggling}
                    >
                      {ethernetToggling ? "Configuring..." : settings.directEthernet ? "Disable" : "Enable"}
                    </button>
                  </div>
                  <span className="setup-hint">
                    {settings.directEthernet
                      ? "Configured for direct cable connection. Disable if Ethernet internet stops working."
                      : "Required for direct cable to Deck. Windows will ask for permission once."}
                  </span>
                </div>
              )}

              <div className="setup-section">
                <label className="setup-label" htmlFor="deck-password">Deck password</label>
                <input
                  id="deck-password"
                  className="setup-input"
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

              {savedConnections.length > 0 && (
                <div className="setup-section">
                  <label className="setup-label">Saved Decks</label>
                  <div className="saved-connections">
                    {savedConnections.map((conn) => (
                      <div key={conn.id} className="saved-conn-item">
                        <button
                          className="saved-conn-btn"
                          onClick={() => connectToSaved(conn)}
                        >
                          <span className="saved-conn-name">{conn.hostname || conn.ip}</span>
                          <span className="saved-conn-meta">{conn.ip} - {conn.connection_mode}</span>
                        </button>
                        <button
                          className="saved-conn-delete"
                          onClick={() => deleteSavedConnection(conn.id)}
                          title="Remove"
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <button
                className="scan-btn"
                onClick={scanForDeck}
                disabled={scanning || !password}
              >
                {scanning ? "Scanning..." : "Scan for Steam Deck"}
              </button>
            </div>

            {/* Right column - setup instructions */}
            <div className="setup-right">
              <h2>Steam Deck Setup</h2>
              <div className="setup-steps">
                <div className="step">
                  <span className="step-number">1</span>
                  <span>
                    {settings.connectionMode === "ethernet"
                      ? "Plug an ethernet cable between your PC and Steam Deck"
                      : "Connect your PC and Steam Deck to the same Wi-Fi network"}
                  </span>
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
              </div>

              {!isPro && (
                <div className="setup-pro-cta">
                  <div className="setup-pro-header">
                    <span className="pro-badge">PRO</span>
                    <strong>Deck Transfer Pro</strong>
                    <span className="setup-pro-price">EUR 3.00/month</span>
                  </div>
                  <ul className="setup-pro-features">
                    <li>Transfer history with one-click re-send</li>
                    <li>Scheduled automatic folder syncs</li>
                    <li>Desktop notifications on completion</li>
                  </ul>
                  <button className="pro-upgrade-btn" onClick={() => setShowUpgradeModal(true)}>
                    Upgrade to Pro
                  </button>
                </div>
              )}
            </div>
          </div>
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
        <a href="https://buymeacoffee.com/eeriegoesd" target="_blank" rel="noreferrer" className="footer-coffee">
          Buy Me a Coffee
        </a>
        <span className="footer-sep">|</span>
        <a href="https://github.com/EerieGoesD/deck-transfer/discussions" target="_blank" rel="noreferrer">Feedback</a>
        <span className="footer-sep">|</span>
        <a href="https://github.com/EerieGoesD/deck-transfer/issues" target="_blank" rel="noreferrer">Report Issue</a>
        {!isPro && (
          <>
            <span className="footer-sep">|</span>
            <a href="#" className="footer-pro" onClick={(e) => { e.preventDefault(); setShowUpgradeModal(true); }}>Upgrade to Pro</a>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="ctx-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.target ? (
            <>
              {contextMenu.target.isDir && (
                <button
                  className="ctx-menu-item"
                  onClick={() => { setContextMenu(null); navigateTo(contextMenu.target!.name); }}
                >
                  Open
                </button>
              )}
              <button
                className="ctx-menu-item"
                onClick={() => handleRename(contextMenu.target!.name, contextMenu.target!.isDir)}
              >
                Rename
              </button>
              <button
                className="ctx-menu-item ctx-menu-danger"
                onClick={() => handleDelete(contextMenu.target!.name, contextMenu.target!.isDir)}
              >
                Delete
              </button>
              <div className="ctx-menu-sep" />
            </>
          ) : null}
          <button className="ctx-menu-item" onClick={handleCreateFolder}>
            New Folder
          </button>
          <button className="ctx-menu-item" onClick={handleCreateFile}>
            New File
          </button>
          <div className="ctx-menu-sep" />
          <button className="ctx-menu-item" onClick={() => { setContextMenu(null); loadDir(currentDir); }}>
            Refresh
          </button>
        </div>
      )}

      {/* Upgrade modal */}
      {showUpgradeModal && (
        <UpgradeModal
          onClose={() => setShowUpgradeModal(false)}
          onActivated={(email) => {
            setIsPro(true);
            setProEmail(email);
            setShowUpgradeModal(false);
          }}
        />
      )}

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
