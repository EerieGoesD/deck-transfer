use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::{create_session, dbg_log, get_transfer_state, clear_transfer_state, TransferProgress, SPEED_LIMIT};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncFileEntry {
    pub name: String,
    pub local_path: String,
    pub remote_path: String,
    pub local_size: u64,
    pub remote_size: u64,
    pub action: String, // "upload" | "skip"
    pub reason: String, // "new" | "size_changed" | "unchanged"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPlan {
    pub local_dir: String,
    pub remote_dir: String,
    pub files: Vec<SyncFileEntry>,
    pub total_upload_bytes: u64,
    pub total_upload_count: u64,
    pub total_unchanged: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success_count: u64,
    pub error_count: u64,
    pub bytes_transferred: u64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncProgressEvent {
    file_name: String,
    file_index: usize,
    total_files: usize,
    bytes_sent: u64,
    total_bytes: u64,
    speed_bps: u64,
    status: String, // "transferring" | "complete" | "error"
}

fn list_local_files_recursive(dir: &Path, base: &Path) -> Result<HashMap<String, u64>, String> {
    let mut files = HashMap::new();
    if !dir.exists() {
        return Err(format!("Local directory does not exist: {}", dir.display()));
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read directory {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Read error: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            let relative = path
                .strip_prefix(base)
                .map_err(|e| format!("Path error: {}", e))?
                .to_string_lossy()
                .replace('\\', "/");
            let size = std::fs::metadata(&path)
                .map(|m| m.len())
                .unwrap_or(0);
            files.insert(relative, size);
        } else if path.is_dir() {
            let sub = list_local_files_recursive(&path, base)?;
            files.extend(sub);
        }
    }
    Ok(files)
}

fn list_remote_files_recursive(
    sftp: &ssh2::Sftp,
    dir: &str,
    base: &str,
    depth: usize,
) -> Result<HashMap<String, u64>, String> {
    // Prevent infinite recursion from symlinks
    if depth > 20 {
        return Ok(HashMap::new());
    }
    let mut files = HashMap::new();
    let entries = match sftp.readdir(Path::new(dir)) {
        Ok(e) => e,
        Err(e) => {
            dbg_log("WARN", &format!("[SYNC] Cannot read remote dir {}: {}", dir, e));
            return Ok(files); // Skip unreadable dirs
        }
    };
    for (path, stat) in entries {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name == "." || name == ".." || name.starts_with('.') {
            continue; // Skip hidden files/dirs
        }
        let full = format!("{}/{}", dir.trim_end_matches('/'), name);
        if stat.is_dir() {
            let sub = list_remote_files_recursive(sftp, &full, base, depth + 1)?;
            files.extend(sub);
        } else {
            let relative = full
                .strip_prefix(base)
                .unwrap_or(&full)
                .trim_start_matches('/')
                .to_string();
            let size = stat.size.unwrap_or(0);
            files.insert(relative, size);
        }
    }
    Ok(files)
}

#[tauri::command]
pub async fn compare_folders(
    deck_ip: String,
    deck_password: String,
    local_dir: String,
    remote_dir: String,
) -> Result<SyncPlan, String> {
    let local_dir_clone = local_dir.clone();
    let remote_dir_clone = remote_dir.clone();

    tokio::task::spawn_blocking(move || {
        dbg_log("INFO", &format!(
            "[SYNC] Comparing: local={} remote={} on {}",
            local_dir_clone, remote_dir_clone, deck_ip
        ));

        // List local files
        let local_path = Path::new(&local_dir_clone);
        let local_files = list_local_files_recursive(local_path, local_path)?;
        dbg_log("INFO", &format!("[SYNC] Found {} local files", local_files.len()));

        // Connect and list remote files
        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session.sftp().map_err(|e| format!("SFTP error: {}", e))?;

        // Ensure remote dir exists
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("mkdir -p '{}'", remote_dir_clone))
            .map_err(|e| format!("mkdir failed: {}", e))?;
        channel.wait_close().ok();

        let remote_files = list_remote_files_recursive(
            &sftp,
            &remote_dir_clone,
            &format!("{}/", remote_dir_clone.trim_end_matches('/')),
            0,
        )
        .unwrap_or_default();
        dbg_log("INFO", &format!("[SYNC] Found {} remote files", remote_files.len()));

        let mut entries = Vec::new();
        let mut total_upload_bytes: u64 = 0;
        let mut total_upload_count: u64 = 0;
        let mut total_unchanged: u64 = 0;

        for (relative, local_size) in &local_files {
            let remote_size = remote_files.get(relative).copied().unwrap_or(0);
            let remote_exists = remote_files.contains_key(relative);

            let (action, reason) = if !remote_exists {
                ("upload", "new")
            } else if *local_size != remote_size {
                ("upload", "size_changed")
            } else {
                ("skip", "unchanged")
            };

            if action == "upload" {
                total_upload_bytes += local_size;
                total_upload_count += 1;
            } else {
                total_unchanged += 1;
            }

            entries.push(SyncFileEntry {
                name: relative.clone(),
                local_path: local_path.join(relative).to_string_lossy().to_string(),
                remote_path: format!(
                    "{}/{}",
                    remote_dir_clone.trim_end_matches('/'),
                    relative
                ),
                local_size: *local_size,
                remote_size,
                action: action.to_string(),
                reason: reason.to_string(),
            });
        }

        // Sort: uploads first, then by name
        entries.sort_by(|a, b| {
            if a.action == b.action {
                a.name.cmp(&b.name)
            } else if a.action == "upload" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        });

        dbg_log("INFO", &format!(
            "[SYNC] Plan: {} to upload, {} unchanged",
            total_upload_count, total_unchanged
        ));

        Ok(SyncPlan {
            local_dir: local_dir_clone,
            remote_dir: remote_dir_clone,
            files: entries,
            total_upload_bytes,
            total_upload_count,
            total_unchanged,
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn execute_sync(
    app: AppHandle,
    deck_ip: String,
    deck_password: String,
    plan: SyncPlan,
    speed_limit: Option<u64>,
) -> Result<SyncResult, String> {
    if let Some(limit) = speed_limit {
        SPEED_LIMIT.store(limit as usize, Ordering::Relaxed);
    }

    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        let uploads: Vec<&SyncFileEntry> = plan.files.iter().filter(|f| f.action == "upload").collect();
        if uploads.is_empty() {
            return Ok(SyncResult {
                success_count: 0,
                error_count: 0,
                bytes_transferred: 0,
                errors: vec![],
            });
        }

        dbg_log("INFO", &format!(
            "[SYNC] Executing sync: {} files to upload via SFTP",
            uploads.len()
        ));

        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session.sftp().map_err(|e| format!("SFTP error: {}", e))?;

        let mut success_count: u64 = 0;
        let mut error_count: u64 = 0;
        let mut bytes_transferred: u64 = 0;
        let mut errors: Vec<String> = Vec::new();

        for (i, entry) in uploads.iter().enumerate() {
            // Emit progress: starting file
            let _ = app_handle.emit("sync-progress", SyncProgressEvent {
                file_name: entry.name.clone(),
                file_index: i,
                total_files: uploads.len(),
                bytes_sent: 0,
                total_bytes: entry.local_size,
                speed_bps: 0,
                status: "transferring".to_string(),
            });

            // Ensure remote subdirectories exist
            if let Some(parent) = Path::new(&entry.remote_path).parent() {
                let parent_str = parent.to_string_lossy().replace('\\', "/");
                let mut channel = match session.channel_session() {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push(format!("{}: mkdir channel error: {}", entry.name, e));
                        error_count += 1;
                        continue;
                    }
                };
                channel.exec(&format!("mkdir -p '{}'", parent_str)).ok();
                channel.wait_close().ok();
            }

            // Open remote file
            let mut remote_file = match sftp.create(Path::new(&entry.remote_path)) {
                Ok(f) => f,
                Err(e) => {
                    let msg = format!("{}: create remote file error: {}", entry.name, e);
                    dbg_log("ERROR", &format!("[SYNC] {}", msg));
                    errors.push(msg);
                    error_count += 1;
                    let _ = app_handle.emit("sync-progress", SyncProgressEvent {
                        file_name: entry.name.clone(),
                        file_index: i,
                        total_files: uploads.len(),
                        bytes_sent: 0,
                        total_bytes: entry.local_size,
                        speed_bps: 0,
                        status: "error".to_string(),
                    });
                    continue;
                }
            };

            let mut local_file = match std::fs::File::open(&entry.local_path) {
                Ok(f) => f,
                Err(e) => {
                    let msg = format!("{}: open local file error: {}", entry.name, e);
                    errors.push(msg);
                    error_count += 1;
                    continue;
                }
            };

            let chunk_size = {
                let limit = SPEED_LIMIT.load(Ordering::Relaxed);
                if limit > 0 {
                    (limit / 4).clamp(64 * 1024, 1024 * 1024)
                } else {
                    1024 * 1024
                }
            };

            let mut buf = vec![0u8; chunk_size];
            let mut bytes_sent: u64 = 0;
            let start = Instant::now();
            let file_id = format!("sync-{}", i);
            let state = get_transfer_state(&file_id);
            state.store(0, Ordering::Relaxed);

            let mut write_error: Option<String> = None;
            let mut cancelled = false;

            loop {
                let s = state.load(Ordering::Relaxed);
                if s == 2 {
                    cancelled = true;
                    break;
                }
                if s == 1 {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }

                let n = match local_file.read(&mut buf) {
                    Ok(n) => n,
                    Err(e) => {
                        write_error = Some(format!("Read error: {}", e));
                        break;
                    }
                };
                if n == 0 { break; }

                if let Err(e) = remote_file.write_all(&buf[..n]) {
                    write_error = Some(format!("Write error: {}", e));
                    break;
                }

                bytes_sent += n as u64;

                // Throttle
                let live_limit = SPEED_LIMIT.load(Ordering::Relaxed) as u64;
                if live_limit > 0 {
                    let target_elapsed = bytes_sent as f64 / live_limit as f64;
                    let actual = start.elapsed().as_secs_f64();
                    let sleep_secs = target_elapsed - actual;
                    if sleep_secs > 0.001 {
                        std::thread::sleep(Duration::from_secs_f64(sleep_secs));
                    }
                }

                let actual_elapsed = start.elapsed().as_secs_f64();
                let actual_speed = if actual_elapsed > 0.0 {
                    (bytes_sent as f64 / actual_elapsed) as u64
                } else { 0 };

                // Emit progress every ~256KB
                if bytes_sent % (256 * 1024) < n as u64 || bytes_sent == entry.local_size {
                    let _ = app_handle.emit("sync-progress", SyncProgressEvent {
                        file_name: entry.name.clone(),
                        file_index: i,
                        total_files: uploads.len(),
                        bytes_sent,
                        total_bytes: entry.local_size,
                        speed_bps: actual_speed,
                        status: "transferring".to_string(),
                    });
                }
            }

            clear_transfer_state(&file_id);

            if cancelled {
                errors.push(format!("{}: cancelled", entry.name));
                error_count += 1;
            } else if let Some(err) = write_error {
                errors.push(format!("{}: {}", entry.name, err));
                error_count += 1;
                let _ = app_handle.emit("sync-progress", SyncProgressEvent {
                    file_name: entry.name.clone(),
                    file_index: i,
                    total_files: uploads.len(),
                    bytes_sent,
                    total_bytes: entry.local_size,
                    speed_bps: 0,
                    status: "error".to_string(),
                });
            } else {
                remote_file.flush().ok();
                drop(remote_file);
                success_count += 1;
                bytes_transferred += bytes_sent;
                let _ = app_handle.emit("sync-progress", SyncProgressEvent {
                    file_name: entry.name.clone(),
                    file_index: i,
                    total_files: uploads.len(),
                    bytes_sent: entry.local_size,
                    total_bytes: entry.local_size,
                    speed_bps: 0,
                    status: "complete".to_string(),
                });
            }
        }

        dbg_log("INFO", &format!(
            "[SYNC] Complete: {}/{} succeeded, {} bytes transferred",
            success_count, uploads.len(), bytes_transferred
        ));

        Ok(SyncResult {
            success_count,
            error_count,
            bytes_transferred,
            errors,
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
