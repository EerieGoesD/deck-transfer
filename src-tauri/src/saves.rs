// Save File Finder: list every file under the Deck's emulator save folders
// (EmuDeck keeps them in Emulation/saves, as links into each emulator's own
// folder), so the user can see where a game's saves and save states live.

use serde::Serialize;
use std::collections::HashSet;
use std::io::Read as IoRead;

use crate::{create_session, dbg_log};

#[derive(Debug, Clone, Serialize)]
pub struct SaveEntry {
    /// Which of the scanned folders it was found under (0 = first).
    pub root_index: usize,
    pub path: String,
    pub relative_path: String,
    pub size: u64,
    /// Last modified, seconds since 1970.
    pub modified: i64,
}

// Screenshots and thumbnails sit beside save states; they are not saves.
fn is_image(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".bmp", ".webp"].iter().any(|e| p.ends_with(e))
}

#[tauri::command]
pub async fn scan_save_files(
    app: tauri::AppHandle,
    deck_ip: String,
    deck_password: String,
    roots: Vec<String>,
) -> Result<Vec<SaveEntry>, String> {
    crate::licensing::require_access(&app).await?;
    dbg_log("INFO", &format!("[SAVES] Scanning {:?}", roots));
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;

        fn q(s: &str) -> String {
            format!("'{}'", s.replace('\'', "'\\''"))
        }
        // -L follows EmuDeck's links into each emulator's folder. %D:%i (device and
        // inode of the real file) lets a file reached through two links count once.
        let mut cmd = String::new();
        for root in &roots {
            cmd.push_str(&format!(
                "find -L {} -type f -printf '%D:%i\\t%s\\t%T@\\t%p\\n' 2>/dev/null; echo '---SEP---'; ",
                q(root.trim_end_matches('/'))
            ));
        }

        let mut channel = session.channel_session().map_err(|e| format!("Channel error: {}", e))?;
        channel.exec(&cmd).map_err(|e| format!("Scan exec failed: {}", e))?;
        let mut out = String::new();
        IoRead::read_to_string(&mut channel, &mut out).map_err(|e| format!("Read failed: {}", e))?;
        channel.wait_close().ok();

        let mut seen: HashSet<String> = HashSet::new();
        let mut entries: Vec<SaveEntry> = Vec::new();
        for (root_index, section) in out.split("---SEP---\n").enumerate() {
            let Some(root) = roots.get(root_index) else { break };
            let root = root.trim_end_matches('/');
            for line in section.lines() {
                let cols: Vec<&str> = line.splitn(4, '\t').collect();
                if cols.len() < 4 {
                    continue;
                }
                let path = cols[3].to_string();
                if is_image(&path) || !seen.insert(cols[0].to_string()) {
                    continue;
                }
                let relative_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .trim_start_matches('/')
                    .to_string();
                entries.push(SaveEntry {
                    root_index,
                    relative_path,
                    size: cols[1].parse().unwrap_or(0),
                    modified: cols[2].parse::<f64>().map(|t| t as i64).unwrap_or(0),
                    path,
                });
            }
        }
        dbg_log("INFO", &format!("[SAVES] Found {} file(s)", entries.len()));
        Ok(entries)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
