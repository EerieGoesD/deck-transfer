export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

export function formatSpeed(bps: number): string {
  if (bps < 1024) return bps + " B/s";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(0) + " KB/s";
  if (bps < 1024 * 1024 * 1024)
    return (bps / (1024 * 1024)).toFixed(1) + " MB/s";
  return (bps / (1024 * 1024 * 1024)).toFixed(2) + " GB/s";
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
