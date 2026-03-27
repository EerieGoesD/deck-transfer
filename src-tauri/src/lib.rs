use serde::{Deserialize, Serialize};
use std::io::{Read as IoRead, Write as IoWrite};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::sync::Mutex;

mod network;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckInfo {
    pub ip: String,
    pub hostname: String,
    pub interface_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanProgress {
    scanned: usize,
    total: usize,
    current_interface: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TransferProgress {
    file_id: String,
    bytes_sent: u64,
    total_bytes: u64,
    speed_bps: u64,
    eta_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteEntry {
    name: String,
    is_dir: bool,
}

fn check_ssh(ip: Ipv4Addr) -> Option<String> {
    let addr = SocketAddr::new(IpAddr::V4(ip), 22);
    if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(100)) {
        let mut buf = [0u8; 256];
        let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
        if let Ok(n) = (&stream).read(&mut buf) {
            let banner = String::from_utf8_lossy(&buf[..n]);
            if banner.contains("SSH") {
                return Some(ip.to_string());
            }
        }
    }
    None
}

fn create_session(ip: &str, password: &str) -> Result<ssh2::Session, String> {
    let tcp = TcpStream::connect_timeout(
        &format!("{}:22", ip)
            .parse()
            .map_err(|e| format!("Invalid address: {}", e))?,
        Duration::from_secs(10),
    )
    .map_err(|e| format!("Connection failed: {}", e))?;

    let mut session = ssh2::Session::new().map_err(|e| format!("SSH error: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;

    session
        .userauth_password("deck", password)
        .map_err(|e| format!("Wrong password: {}", e))?;

    if !session.authenticated() {
        return Err("Authentication failed. Double-check your password.".to_string());
    }

    Ok(session)
}

#[tauri::command]
async fn scan_for_deck(
    app: tauri::AppHandle,
    deck_password: String,
) -> Result<DeckInfo, String> {
    let ethernet_interfaces = network::find_ethernet_interfaces()
        .map_err(|e| format!("Failed to enumerate network interfaces: {}", e))?;

    if ethernet_interfaces.is_empty() {
        return Err(
            "No ethernet interfaces found. Make sure the cable is connected.".to_string(),
        );
    }

    let all_candidates: Vec<_> = ethernet_interfaces
        .iter()
        .map(|iface| (iface, network::get_scan_candidates(&iface.ip)))
        .collect();

    let total: usize = all_candidates.iter().map(|(_, c)| c.len()).sum();
    let scanned = Arc::new(AtomicUsize::new(0));

    for (iface, candidates) in &all_candidates {
        log::info!("Scanning interface: {} ({})", iface.name, iface.ip);

        let iface_name = iface.name.clone();
        let found: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        for chunk in candidates.chunks(50) {
            let mut handles = Vec::new();

            for &ip in chunk {
                let found = Arc::clone(&found);
                handles.push(tokio::task::spawn_blocking(move || {
                    if let Some(addr) = check_ssh(ip) {
                        if let Ok(mut f) = found.try_lock() {
                            if f.is_none() {
                                *f = Some(addr);
                            }
                        }
                    }
                }));
            }

            for h in handles {
                let _ = h.await;
            }

            let done = scanned.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len();
            let _ = app.emit(
                "scan-progress",
                ScanProgress {
                    scanned: done,
                    total,
                    current_interface: iface_name.clone(),
                },
            );

            let lock = found.lock().await;
            if let Some(ref ip) = *lock {
                log::info!("Found SSH device at {}, verifying credentials...", ip);

                // Verify credentials before reporting success
                let ip_clone = ip.clone();
                let pw = deck_password.clone();
                let verify_result =
                    tokio::task::spawn_blocking(move || create_session(&ip_clone, &pw)).await;

                match verify_result {
                    Ok(Ok(_session)) => {
                        return Ok(DeckInfo {
                            ip: ip.clone(),
                            hostname: "Steam Deck".to_string(),
                            interface_name: iface_name,
                        });
                    }
                    Ok(Err(e)) => {
                        return Err(format!(
                            "Found device at {} but login failed: {}",
                            ip, e
                        ));
                    }
                    Err(e) => {
                        return Err(format!("Internal error verifying credentials: {}", e));
                    }
                }
            }
        }
    }

    Err("No Steam Deck found. Make sure SSH is enabled on the Deck and the ethernet cable is connected.".to_string())
}

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<FileInfo>, String> {
    use tauri_plugin_dialog::DialogExt;

    let files = app.dialog().file().blocking_pick_files();

    match files {
        Some(paths) => {
            let mut result = Vec::new();
            for file_path in paths {
                let p = file_path.to_string();
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                result.push(FileInfo { path: p, size });
            }
            Ok(result)
        }
        None => Ok(vec![]),
    }
}

#[tauri::command]
async fn list_remote_dir(
    deck_ip: String,
    deck_password: String,
    remote_path: String,
) -> Result<Vec<RemoteEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session
            .sftp()
            .map_err(|e| format!("SFTP session failed: {}", e))?;

        let entries = sftp
            .readdir(Path::new(&remote_path))
            .map_err(|e| format!("Cannot read directory '{}': {}", remote_path, e))?;

        let mut result: Vec<RemoteEntry> = entries
            .into_iter()
            .filter_map(|(path, stat)| {
                let name = path.file_name()?.to_string_lossy().to_string();
                if name.starts_with('.') {
                    return None;
                }
                Some(RemoteEntry {
                    name,
                    is_dir: stat.is_dir(),
                })
            })
            .collect();

        result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(result)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn create_remote_dir(
    deck_ip: String,
    deck_password: String,
    remote_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("mkdir -p '{}'", remote_path))
            .map_err(|e| format!("mkdir failed: {}", e))?;
        channel.wait_close().ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteFileCheck {
    file_name: String,
    exists: bool,
    remote_size: u64,
}

#[tauri::command]
async fn check_remote_files(
    deck_ip: String,
    deck_password: String,
    remote_dir: String,
    file_names: Vec<String>,
) -> Result<Vec<RemoteFileCheck>, String> {
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session
            .sftp()
            .map_err(|e| format!("SFTP session failed: {}", e))?;

        let mut results = Vec::new();
        for name in file_names {
            let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
            match sftp.stat(Path::new(&remote_path)) {
                Ok(stat) => {
                    results.push(RemoteFileCheck {
                        file_name: name,
                        exists: true,
                        remote_size: stat.size.unwrap_or(0),
                    });
                }
                Err(_) => {
                    results.push(RemoteFileCheck {
                        file_name: name,
                        exists: false,
                        remote_size: 0,
                    });
                }
            }
        }
        Ok(results)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn transfer_file(
    app: tauri::AppHandle,
    file_id: String,
    file_path: String,
    deck_ip: String,
    deck_password: String,
    remote_dir: String,
) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    let metadata =
        std::fs::metadata(&file_path).map_err(|e| format!("Cannot read file: {}", e))?;
    let total_bytes = metadata.len();
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), file_name);

    let fid = file_id.clone();
    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;

        // Ensure remote directory exists
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("mkdir -p '{}'", remote_dir))
            .map_err(|e| format!("Failed to create remote directory: {}", e))?;
        channel.wait_close().ok();

        // SCP the file
        let mut remote_file = session
            .scp_send(Path::new(&remote_path), 0o644, total_bytes, None)
            .map_err(|e| format!("SCP failed to start: {}", e))?;

        let mut local_file = std::fs::File::open(&file_path)
            .map_err(|e| format!("Cannot open file: {}", e))?;

        // Transfer in chunks, emitting progress
        let mut buf = vec![0u8; 256 * 1024]; // 256KB chunks
        let mut bytes_sent: u64 = 0;
        let start = Instant::now();

        loop {
            let n = local_file
                .read(&mut buf)
                .map_err(|e| format!("Read error: {}", e))?;
            if n == 0 {
                break;
            }

            remote_file
                .write_all(&buf[..n])
                .map_err(|e| format!("Write error: {}", e))?;

            bytes_sent += n as u64;

            let elapsed = start.elapsed().as_secs_f64();
            let speed_bps = if elapsed > 0.0 {
                (bytes_sent as f64 / elapsed) as u64
            } else {
                0
            };
            let remaining = total_bytes.saturating_sub(bytes_sent);
            let eta_seconds = if speed_bps > 0 {
                remaining / speed_bps
            } else {
                0
            };

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    file_id: fid.clone(),
                    bytes_sent,
                    total_bytes,
                    speed_bps,
                    eta_seconds,
                },
            );
        }

        remote_file
            .send_eof()
            .map_err(|e| format!("EOF error: {}", e))?;
        remote_file
            .wait_eof()
            .map_err(|e| format!("Wait EOF error: {}", e))?;
        remote_file
            .close()
            .map_err(|e| format!("Close error: {}", e))?;
        remote_file
            .wait_close()
            .map_err(|e| format!("Wait close error: {}", e))?;

        log::info!("Transferred {} to {}", file_name, remote_path);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_for_deck,
            pick_files,
            list_remote_dir,
            create_remote_dir,
            check_remote_files,
            transfer_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
