// Copying from the Deck to this computer: one file, or a whole folder with its
// subfolders, into a local folder the user picked. Progress, pause, cancel and
// the speed limit work the same way as for sending.

use serde::Serialize;
use std::io::{Read as IoRead, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::{clear_transfer_state, create_session, dbg_log, get_transfer_state, TransferProgress, SPEED_LIMIT};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadResult {
    /// Where the file or folder was saved.
    pub local_path: String,
    pub files: u64,
    pub failed: u64,
    pub errors: Vec<String>,
}

/// Windows forbids some characters the Deck allows in names (a ROM called
/// "Zelda: Ocarina of Time.z64" is common), so those become "_" there.
#[cfg(windows)]
fn local_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32 { '_' } else { c })
        .collect();
    // Nor may a name end in a dot or a space.
    let t = s.trim_end_matches(|c| c == '.' || c == ' ');
    if t.is_empty() { "_".to_string() } else { t.to_string() }
}

#[cfg(not(windows))]
fn local_name(name: &str) -> String {
    name.to_string()
}

/// A free name in `dir`, the way Finder does it: "name.ext", then "name 2.ext",
/// "name 3.ext"... so a download never overwrites anything already there.
fn unique_local_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let mut n = 2;
    loop {
        let candidate = dir.join(format!("{} {}{}", stem, n, ext));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Every file under a Deck folder: (path relative to it, size). Hidden entries
/// are skipped, as in the folder list. Symlinks are followed, so ROMs linked
/// across internal storage and the SD card come down as real files.
fn list_remote_tree(sftp: &ssh2::Sftp, dir: &str, rel: &str, depth: usize, out: &mut Vec<(String, u64)>) {
    if depth > 20 {
        return;
    }
    let entries = match sftp.readdir(Path::new(dir)) {
        Ok(e) => e,
        Err(e) => {
            dbg_log("WARN", &format!("[DOWNLOAD] Cannot read {}: {}", dir, e));
            return;
        }
    };
    for (path, stat) in entries {
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let full = format!("{}/{}", dir.trim_end_matches('/'), name);
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        let stat = if stat.file_type().is_symlink() {
            match sftp.stat(Path::new(&full)) {
                Ok(s) => s,
                Err(_) => continue, // broken link
            }
        } else {
            stat
        };
        if stat.is_dir() {
            list_remote_tree(sftp, &full, &child_rel, depth + 1, out);
        } else {
            out.push((child_rel, stat.size.unwrap_or(0)));
        }
    }
}

struct Progress<'a> {
    app: &'a AppHandle,
    file_id: &'a str,
    total: u64,
    done: u64,
    start: Instant,
}

impl Progress<'_> {
    fn emit(&self) {
        let elapsed = self.start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 { (self.done as f64 / elapsed) as u64 } else { 0 };
        let eta = if speed > 0 { self.total.saturating_sub(self.done) / speed } else { 0 };
        let _ = self.app.emit(
            "transfer-progress",
            TransferProgress {
                file_id: self.file_id.to_string(),
                bytes_sent: self.done,
                total_bytes: self.total,
                speed_bps: speed,
                eta_seconds: eta,
            },
        );
    }
}

/// Copy one Deck file to `local`. Waits while paused; stops on cancel and removes
/// the partial file.
fn copy_one(sftp: &ssh2::Sftp, remote: &str, local: &Path, progress: &mut Progress) -> Result<(), String> {
    let mut src = sftp.open(Path::new(remote)).map_err(|e| format!("Cannot open {}: {}", remote, e))?;
    let mut dst = std::fs::File::create(local).map_err(|e| format!("Cannot create {}: {}", local.display(), e))?;
    let state = get_transfer_state(progress.file_id);
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        loop {
            match state.load(Ordering::Relaxed) {
                2 => {
                    drop(dst);
                    let _ = std::fs::remove_file(local);
                    return Err("Transfer cancelled".to_string());
                }
                1 => std::thread::sleep(Duration::from_millis(100)),
                _ => break,
            }
        }
        let limit = SPEED_LIMIT.load(Ordering::Relaxed);
        let want = if limit > 0 { (limit / 4).clamp(64 * 1024, 1024 * 1024) } else { buf.len() };
        let n = src.read(&mut buf[..want]).map_err(|e| format!("Read error: {}", e))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).map_err(|e| format!("Write error: {}", e))?;
        progress.done += n as u64;

        // Throttle to the live speed limit, like sending.
        let live = SPEED_LIMIT.load(Ordering::Relaxed) as u64;
        if live > 0 {
            let ahead = progress.done as f64 / live as f64 - progress.start.elapsed().as_secs_f64();
            if ahead > 0.001 {
                std::thread::sleep(Duration::from_secs_f64(ahead));
            }
        }
        progress.emit();
    }
    dst.flush().map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn download_remote(
    app: AppHandle,
    file_id: String,
    deck_ip: String,
    deck_password: String,
    remote_path: String,
    is_dir: bool,
    local_dir: String,
) -> Result<DownloadResult, String> {
    crate::licensing::require_access(&app).await?;
    #[cfg(target_os = "macos")]
    crate::mac::ensure_access(&app, &[local_dir.as_str()]);
    dbg_log("INFO", &format!("[DOWNLOAD] {} -> {}", remote_path, local_dir));

    tokio::task::spawn_blocking(move || -> Result<DownloadResult, String> {
        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session.sftp().map_err(|e| format!("SFTP session failed: {}", e))?;
        let name = Path::new(&remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "Deck".to_string());
        let dest_dir = Path::new(&local_dir);
        if !dest_dir.is_dir() {
            return Err(format!("Folder not found: {}", local_dir));
        }

        let state = get_transfer_state(&file_id);
        state.store(0, Ordering::Relaxed);

        let result = if !is_dir {
            let size = sftp.stat(Path::new(&remote_path)).ok().and_then(|s| s.size).unwrap_or(0);
            let local = unique_local_path(dest_dir, &local_name(&name));
            let mut progress = Progress { app: &app, file_id: &file_id, total: size, done: 0, start: Instant::now() };
            progress.emit();
            copy_one(&sftp, &remote_path, &local, &mut progress).map(|_| DownloadResult {
                local_path: local.to_string_lossy().to_string(),
                files: 1,
                failed: 0,
                errors: vec![],
            })
        } else {
            let mut tree = Vec::new();
            list_remote_tree(&sftp, &remote_path, "", 0, &mut tree);
            let total: u64 = tree.iter().map(|(_, s)| *s).sum();
            let root = unique_local_path(dest_dir, &local_name(&name));
            std::fs::create_dir_all(&root).map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;
            let mut progress = Progress { app: &app, file_id: &file_id, total, done: 0, start: Instant::now() };
            progress.emit();

            let mut files = 0u64;
            let mut errors: Vec<String> = Vec::new();
            let mut outcome: Result<(), String> = Ok(());
            for (rel, size) in &tree {
                let mut local = root.clone();
                for part in rel.split('/') {
                    local.push(local_name(part));
                }
                if let Some(parent) = local.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let remote = format!("{}/{}", remote_path.trim_end_matches('/'), rel);
                let before = progress.done;
                match copy_one(&sftp, &remote, &local, &mut progress) {
                    Ok(()) => files += 1,
                    Err(e) if e == "Transfer cancelled" => {
                        outcome = Err(e);
                        break;
                    }
                    Err(e) => {
                        dbg_log("ERROR", &format!("[DOWNLOAD] {}", e));
                        errors.push(e);
                        // Count the failed file as handled so the bar still reaches the end.
                        progress.done = before + size;
                    }
                }
            }
            outcome.map(|_| DownloadResult {
                local_path: root.to_string_lossy().to_string(),
                files,
                failed: errors.len() as u64,
                errors,
            })
        };

        clear_transfer_state(&file_id);
        match &result {
            Ok(r) => dbg_log(
                "INFO",
                &format!("[DOWNLOAD] Done: {} file(s), {} failed -> {}", r.files, r.failed, r.local_path),
            ),
            Err(e) => dbg_log("ERROR", &format!("[DOWNLOAD] {}", e)),
        }
        result
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
