use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read as IoRead, Write as IoWrite};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
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

// ---------------------
// Transfer control (pause/cancel/speed)
// ---------------------
// 0 = running, 1 = paused, 2 = cancelled

static TRANSFER_STATE: once_cell::sync::Lazy<StdMutex<HashMap<String, Arc<AtomicU8>>>> =
    once_cell::sync::Lazy::new(|| StdMutex::new(HashMap::new()));

// Global speed limit (bytes/sec, 0 = unlimited) - shared across all transfers
static SPEED_LIMIT: AtomicUsize = AtomicUsize::new(0);

fn get_transfer_state(file_id: &str) -> Arc<AtomicU8> {
    let mut map = TRANSFER_STATE.lock().unwrap();
    map.entry(file_id.to_string())
        .or_insert_with(|| Arc::new(AtomicU8::new(0)))
        .clone()
}

fn clear_transfer_state(file_id: &str) {
    if let Ok(mut map) = TRANSFER_STATE.lock() {
        map.remove(file_id);
    }
}

// ---------------------
// Debug log ring buffer
// ---------------------

static DEBUG_LOG_BUFFER: once_cell::sync::Lazy<StdMutex<VecDeque<String>>> =
    once_cell::sync::Lazy::new(|| StdMutex::new(VecDeque::with_capacity(500)));

fn dbg_log(level: &str, msg: &str) {
    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
    let line = format!("[{}] {} {}", timestamp, level, msg);
    if let Ok(mut buf) = DEBUG_LOG_BUFFER.lock() {
        if buf.len() >= 500 {
            buf.pop_front();
        }
        buf.push_back(line);
    }
    match level {
        "ERROR" => log::error!("{}", msg),
        "WARN" => log::warn!("{}", msg),
        _ => log::info!("{}", msg),
    }
}

#[tauri::command]
fn get_debug_logs() -> Vec<String> {
    DEBUG_LOG_BUFFER
        .lock()
        .map(|buf| buf.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
fn frontend_log(msg: String) {
    dbg_log("INFO", &format!("[UI] {}", msg));
}

#[tauri::command]
fn clear_debug_logs() {
    if let Ok(mut buf) = DEBUG_LOG_BUFFER.lock() {
        buf.clear();
    }
}

// ---------------------
// SSH helpers
// ---------------------

const MAX_HANDSHAKE_RETRIES: usize = 3;

fn check_ssh(ip: Ipv4Addr, timeout_ms: u64) -> Option<(String, String)> {
    let addr = SocketAddr::new(IpAddr::V4(ip), 22);
    match TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)) {
        Ok(stream) => {
            let mut buf = [0u8; 256];
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            match (&stream).read(&mut buf) {
                Ok(n) => {
                    let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
                    if banner.contains("SSH") {
                        dbg_log("INFO", &format!("[PROBE] {} - SSH found: {}", ip, banner));
                        return Some((ip.to_string(), banner));
                    }
                    dbg_log("INFO", &format!("[PROBE] {} - port 22 open but not SSH (got: {})", ip, banner.chars().take(40).collect::<String>()));
                }
                Err(e) => {
                    dbg_log("INFO", &format!("[PROBE] {} - port 22 open but read failed: {}", ip, e));
                }
            }
        }
        Err(_) => {} // Connection refused/timeout - expected for most IPs, don't log
    }
    None
}

/// Each retry uses a different kex strategy: defaults first, then custom, then legacy.
fn try_handshake(ip: &str, password: &str, strategy: usize) -> Result<ssh2::Session, String> {
    let addr: SocketAddr = format!("{}:22", ip)
        .parse()
        .map_err(|e| format!("Invalid address: {}", e))?;

    dbg_log("INFO", &format!("[SSH] Connecting to {}:22 ...", ip));
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
        .map_err(|e| {
            dbg_log("ERROR", &format!("[SSH] TCP connection failed to {}:22 - {}", ip, e));
            format!("Connection failed: {}", e)
        })?;

    // Log both ends of the connection for VPN/routing diagnosis
    if let Ok(local) = tcp.local_addr() {
        dbg_log("INFO", &format!("[SSH] TCP connected: local {} -> remote {}", local, addr));
    } else {
        dbg_log("INFO", &format!("[SSH] TCP connected to {}:22", ip));
    }

    let _ = tcp.set_nodelay(true);
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));

    let mut session = ssh2::Session::new().map_err(|e| format!("SSH error: {}", e))?;
    session.set_tcp_stream(tcp);
    session.set_timeout(30_000);

    match strategy {
        0 => {
            // Strategy 1: libssh2 defaults (no custom preferences)
            dbg_log("INFO", "[SSH] Strategy 1: using libssh2 default algorithms");
        }
        1 => {
            // Strategy 2: explicit broad preferences
            let kex = "ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha256,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512,diffie-hellman-group-exchange-sha256,diffie-hellman-group14-sha1";
            let _ = session.method_pref(ssh2::MethodType::Kex, kex);
            dbg_log("INFO", "[SSH] Strategy 2: ecdh + dh-group14/16/18");
        }
        _ => {
            // Strategy 3: most compatible legacy fallback
            let kex = "diffie-hellman-group14-sha1,diffie-hellman-group14-sha256,diffie-hellman-group1-sha1";
            let _ = session.method_pref(ssh2::MethodType::Kex, kex);
            dbg_log("INFO", "[SSH] Strategy 3: legacy dh-group14/group1 only");
        }
    }

    dbg_log("INFO", "[SSH] Starting handshake...");
    session.handshake().map_err(|e| {
        dbg_log(
            "ERROR",
            &format!("[SSH] Handshake FAILED (strategy {}): {} (code: {})", strategy + 1, e, e.code()),
        );
        format!("SSH handshake failed: {}", e)
    })?;

    // Log negotiated algorithms
    if let Some(kex) = session.methods(ssh2::MethodType::Kex) {
        dbg_log("INFO", &format!("[SSH] Negotiated kex: {}", kex));
    }
    if let Some(hk) = session.methods(ssh2::MethodType::HostKey) {
        dbg_log("INFO", &format!("[SSH] Negotiated host key: {}", hk));
    }
    if let Some(c) = session.methods(ssh2::MethodType::CryptCs) {
        dbg_log("INFO", &format!("[SSH] Negotiated cipher (c->s): {}", c));
    }
    if let Some(c) = session.methods(ssh2::MethodType::CryptSc) {
        dbg_log("INFO", &format!("[SSH] Negotiated cipher (s->c): {}", c));
    }

    dbg_log("INFO", "[SSH] Authenticating as 'deck'...");
    session.userauth_password("deck", password).map_err(|e| {
        dbg_log("ERROR", &format!("[SSH] Authentication failed: {}", e));
        format!("Wrong password: {}", e)
    })?;

    if !session.authenticated() {
        return Err("Authentication failed. Double-check your password.".to_string());
    }

    session.set_keepalive(true, 15);
    dbg_log("INFO", &format!("[SSH] Session established successfully to {}", ip));
    Ok(session)
}

fn create_session(ip: &str, password: &str) -> Result<ssh2::Session, String> {
    let mut last_error = String::new();

    for strategy in 0..3 {
        if strategy > 0 {
            let delay = 500 * strategy as u64;
            dbg_log("INFO", &format!("[SSH] Waiting {}ms before retry...", delay));
            std::thread::sleep(Duration::from_millis(delay));
        }

        match try_handshake(ip, password, strategy) {
            Ok(session) => return Ok(session),
            Err(e) => {
                last_error = e.clone();
                // Only retry on kex failures
                if !e.contains("handshake failed") {
                    return Err(e);
                }
            }
        }
    }

    dbg_log("ERROR", "[SSH] All 3 handshake strategies failed.");
    dbg_log("ERROR", "[SSH] This usually means a VPN or firewall is interfering with the SSH connection.");
    dbg_log("ERROR", "[SSH] Try: (1) Disconnect your VPN, (2) Use Ethernet mode instead of Wi-Fi");
    Err(format!(
        "{}\n\nThis is likely caused by a VPN or firewall interfering with SSH.\nTry disconnecting your VPN, or use Ethernet mode instead.",
        last_error
    ))
}

// ---------------------
// Ethernet direct-connect setup
// ---------------------

const DECK_SUBNET_IP: &str = "10.0.0.1";
const DECK_SUBNET_MASK: &str = "255.255.255.0";

/// Run a netsh command with given args, elevating via UAC if needed.
fn run_netsh_elevated(args: &[&str]) -> Result<(), String> {
    dbg_log("INFO", &format!("[NET] Running: netsh {}", args.join(" ")));

    // Try directly first
    let direct = std::process::Command::new("netsh")
        .args(args)
        .creation_flags(0x08000000)
        .output();

    match &direct {
        Ok(output) if output.status.success() => {
            dbg_log("INFO", "[NET] Command succeeded (direct)");
            return Ok(());
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let msg = if !stderr.is_empty() { &stderr } else { &stdout };
            dbg_log("INFO", &format!("[NET] Direct failed: {}", msg.trim()));
        }
        Err(e) => {
            dbg_log("INFO", &format!("[NET] Direct exec failed: {}", e));
        }
    }

    dbg_log("INFO", "[NET] Requesting elevation via UAC...");

    // Build argument string for PowerShell elevation
    // Wrap each arg in quotes for safety
    let netsh_arglist = args
        .iter()
        .map(|a| {
            if a.contains(' ') {
                format!("\\\"{}\\\"", a)
            } else {
                a.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let ps_script = format!(
        "$p = Start-Process netsh -ArgumentList '{}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode",
        netsh_arglist
    );
    let result = std::process::Command::new("powershell")
        .args(["-WindowStyle", "Hidden", "-Command", &ps_script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

    if result.status.success() {
        std::thread::sleep(Duration::from_millis(1000));
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&result.stderr);
        Err(format!("UAC denied or command failed: {}", stderr.trim()))
    }
}

/// Check if 10.0.0.1 is currently on any ethernet interface.
fn is_direct_ethernet_enabled() -> bool {
    if let Ok(ifaces) = <network_interface::NetworkInterface as network_interface::NetworkInterfaceConfig>::show() {
        for iface in &ifaces {
            for addr in &iface.addr {
                if let network_interface::Addr::V4(v4) = addr {
                    if v4.ip == Ipv4Addr::new(10, 0, 0, 1) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Find the first ethernet interface name (works even with no IP assigned).
fn find_ethernet_iface_name() -> Option<String> {
    network::find_ethernet_interface_name()
}

// ---------------------
// Tauri commands
// ---------------------

#[tauri::command]
async fn scan_for_deck(
    app: tauri::AppHandle,
    deck_password: String,
    connection_mode: Option<String>,
) -> Result<DeckInfo, String> {
    let mode = connection_mode.as_deref().unwrap_or("ethernet");
    dbg_log("INFO", &format!("[SCAN] Starting scan in {} mode", mode));

    let interfaces = if mode == "wifi" {
        network::find_wifi_interfaces()
    } else {
        network::find_ethernet_interfaces()
    }
    .map_err(|e| format!("Failed to enumerate network interfaces: {}", e))?;

    if interfaces.is_empty() {
        let msg = if mode == "wifi" {
            "No Wi-Fi interfaces found. Make sure Wi-Fi is enabled and connected to the same network as your Steam Deck."
        } else {
            "No ethernet interfaces found. Make sure the cable is connected."
        };
        dbg_log("ERROR", &format!("[SCAN] {}", msg));
        return Err(msg.to_string());
    }

    for iface in &interfaces {
        dbg_log(
            "INFO",
            &format!("[SCAN] Found interface: {} ({})", iface.name, iface.ip),
        );
    }

    // Detect VPN adapters and warn
    if let Ok(all_ifaces) = <network_interface::NetworkInterface as network_interface::NetworkInterfaceConfig>::show() {
        let vpn_names: Vec<String> = all_ifaces
            .iter()
            .filter(|i| {
                let n = i.name.to_lowercase();
                n.contains("tap") || n.contains("tun")
                    || n.contains("wg") || n.contains("wireguard")
                    || n.contains("nordlynx") || n.contains("proton")
                    || n.contains("mullvad") || n.contains("vpn")
                    || n.contains("cloudflare")
                    || n.contains("warp")
            })
            .map(|i| {
                let ips: Vec<String> = i.addr.iter().filter_map(|a| {
                    if let network_interface::Addr::V4(v4) = a {
                        Some(v4.ip.to_string())
                    } else { None }
                }).collect();
                format!("{} ({})", i.name, ips.join(", "))
            })
            .collect();

        if !vpn_names.is_empty() {
            dbg_log("WARN", &format!("[SCAN] VPN adapters detected: {}", vpn_names.join("; ")));
            dbg_log("WARN", "[SCAN] VPN may interfere with SSH connections over Wi-Fi");
        } else {
            dbg_log("INFO", "[SCAN] No VPN adapters detected");
        }

        // Dump ALL network interfaces for debugging
        dbg_log("INFO", "[SCAN] All network interfaces:");
        for i in &all_ifaces {
            let ips: Vec<String> = i.addr.iter().filter_map(|a| {
                if let network_interface::Addr::V4(v4) = a {
                    Some(format!("{}/{}", v4.ip, v4.netmask.map(|m| m.to_string()).unwrap_or("?".into())))
                } else { None }
            }).collect();
            if !ips.is_empty() {
                dbg_log("INFO", &format!("[SCAN]   {} - {}", i.name, ips.join(", ")));
            }
        }
    }

    let all_candidates: Vec<_> = interfaces
        .iter()
        .map(|iface| {
            let candidates = network::get_scan_candidates(&iface.ip);
            // Log the IP ranges being scanned
            let first = candidates.first().map(|ip| ip.to_string()).unwrap_or_default();
            let last = candidates.last().map(|ip| ip.to_string()).unwrap_or_default();
            dbg_log("INFO", &format!(
                "[SCAN] Interface '{}' ({}): {} candidates ({}...{})",
                iface.name, iface.ip, candidates.len(), first, last
            ));
            (iface, candidates)
        })
        .collect();

    let total: usize = all_candidates.iter().map(|(_, c)| c.len()).sum();
    dbg_log(
        "INFO",
        &format!("[SCAN] Total addresses to scan: {}", total),
    );
    let scanned = Arc::new(AtomicUsize::new(0));

    // Phase 1: Find ALL SSH devices on the network
    let ssh_timeout_ms: u64 = if mode == "wifi" { 400 } else { 200 };
    dbg_log("INFO", &format!("[SCAN] SSH probe timeout: {}ms ({})", ssh_timeout_ms, mode));

    let mut ssh_devices: Vec<(String, String, String)> = Vec::new(); // (ip, banner, iface_name)

    for (iface, candidates) in &all_candidates {
        dbg_log(
            "INFO",
            &format!("[SCAN] Scanning interface: {} ({})", iface.name, iface.ip),
        );

        let iface_name = iface.name.clone();
        let found_devices: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));

        for chunk in candidates.chunks(50) {
            let mut handles = Vec::new();

            for &ip in chunk {
                let found_devices = Arc::clone(&found_devices);
                let timeout = ssh_timeout_ms;
                handles.push(tokio::task::spawn_blocking(move || {
                    if let Some(result) = check_ssh(ip, timeout) {
                        if let Ok(mut devices) = found_devices.try_lock() {
                            devices.push(result);
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
        }

        let devices = found_devices.lock().await;
        for (ip, banner) in devices.iter() {
            ssh_devices.push((ip.clone(), banner.clone(), iface_name.clone()));
        }
    }

    if ssh_devices.is_empty() {
        dbg_log("ERROR", "[SCAN] No SSH devices found on the network");
        return Err("No Steam Deck found. Make sure SSH is enabled on the Deck and the cable is connected (or both devices are on the same Wi-Fi).".to_string());
    }

    dbg_log(
        "INFO",
        &format!("[SCAN] Found {} SSH device(s), trying each:", ssh_devices.len()),
    );
    for (ip, banner, _) in &ssh_devices {
        dbg_log("INFO", &format!("[SCAN]   - {} ({})", ip, banner));
    }

    // Phase 2: Try to authenticate with each SSH device
    let mut last_error = String::new();
    for (ip, banner, iface_name) in &ssh_devices {
        dbg_log(
            "INFO",
            &format!("[SCAN] Trying {} ({})...", ip, banner),
        );

        let ip_clone = ip.clone();
        let pw = deck_password.clone();
        let verify_result =
            tokio::task::spawn_blocking(move || create_session(&ip_clone, &pw)).await;

        match verify_result {
            Ok(Ok(_session)) => {
                dbg_log("INFO", &format!("[SCAN] Successfully connected to {}", ip));
                return Ok(DeckInfo {
                    ip: ip.clone(),
                    hostname: "Steam Deck".to_string(),
                    interface_name: iface_name.clone(),
                });
            }
            Ok(Err(e)) => {
                dbg_log(
                    "WARN",
                    &format!("[SCAN] {} failed: {}, trying next...", ip, e),
                );
                last_error = format!("{} ({}): {}", ip, banner, e);
            }
            Err(e) => {
                dbg_log(
                    "WARN",
                    &format!("[SCAN] {} internal error: {}, trying next...", ip, e),
                );
                last_error = format!("{}: internal error: {}", ip, e);
            }
        }
    }

    dbg_log("ERROR", &format!("[SCAN] None of the {} SSH devices accepted our credentials", ssh_devices.len()));
    Err(format!(
        "Found {} SSH device(s) but none is the Deck.\nLast error: {}\n\nMake sure SSH is enabled on the Deck and you're on the same network.",
        ssh_devices.len(), last_error
    ))
}

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<FileInfo>, String> {
    use tauri_plugin_dialog::DialogExt;
    dbg_log("INFO", "[FILES] Opening file picker dialog");

    let files = app.dialog().file().blocking_pick_files();

    match files {
        Some(paths) => {
            let mut result = Vec::new();
            for file_path in paths {
                let p = file_path.to_string();
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                dbg_log("INFO", &format!("[FILES] Selected: {} ({} bytes)", p, size));
                result.push(FileInfo { path: p, size });
            }
            dbg_log("INFO", &format!("[FILES] {} file(s) selected", result.len()));
            Ok(result)
        }
        None => {
            dbg_log("INFO", "[FILES] File picker cancelled");
            Ok(vec![])
        }
    }
}

#[tauri::command]
async fn list_remote_dir(
    deck_ip: String,
    deck_password: String,
    remote_path: String,
) -> Result<Vec<RemoteEntry>, String> {
    dbg_log("INFO", &format!("[SFTP] Listing directory: {} on {}", remote_path, deck_ip));
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;
        let sftp = session
            .sftp()
            .map_err(|e| {
                dbg_log("ERROR", &format!("[SFTP] Session failed: {}", e));
                format!("SFTP session failed: {}", e)
            })?;

        let entries = sftp
            .readdir(Path::new(&remote_path))
            .map_err(|e| {
                dbg_log("ERROR", &format!("[SFTP] Cannot read '{}': {}", remote_path, e));
                format!("Cannot read directory '{}': {}", remote_path, e)
            })?;

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
        let dirs = result.iter().filter(|e| e.is_dir).count();
        let files = result.len() - dirs;
        dbg_log("INFO", &format!("[SFTP] Listed {}: {} folders, {} files", remote_path, dirs, files));
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
    dbg_log("INFO", &format!("[SFTP] Creating remote dir: {} on {}", remote_path, deck_ip));
    tokio::task::spawn_blocking(move || {
        let session = create_session(&deck_ip, &deck_password)?;
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("mkdir -p '{}'", remote_path))
            .map_err(|e| format!("mkdir failed: {}", e))?;
        channel.wait_close().ok();
        dbg_log("INFO", &format!("[SFTP] Created remote dir: {}", remote_path));
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
    dbg_log("INFO", &format!("[CONFLICT] Checking {} file(s) in {} on {}", file_names.len(), remote_dir, deck_ip));
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
                    let size = stat.size.unwrap_or(0);
                    dbg_log("INFO", &format!("[CONFLICT] {} exists ({} bytes)", name, size));
                    results.push(RemoteFileCheck {
                        file_name: name,
                        exists: true,
                        remote_size: size,
                    });
                }
                Err(_) => {
                    dbg_log("INFO", &format!("[CONFLICT] {} does not exist", name));
                    results.push(RemoteFileCheck {
                        file_name: name,
                        exists: false,
                        remote_size: 0,
                    });
                }
            }
        }
        let conflicts = results.iter().filter(|r| r.exists).count();
        dbg_log("INFO", &format!("[CONFLICT] Check done: {} conflict(s)", conflicts));
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
    speed_limit: Option<u64>,
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

    dbg_log(
        "INFO",
        &format!(
            "[TRANSFER] Starting: {} ({} bytes) -> {}",
            file_name, total_bytes, remote_path
        ),
    );

    tokio::task::spawn_blocking(move || {
        dbg_log("INFO", &format!("[TRANSFER] Connecting to {} for file transfer...", deck_ip));
        let session = create_session(&deck_ip, &deck_password)?;

        // Ensure remote directory exists
        dbg_log("INFO", &format!("[TRANSFER] Ensuring remote dir: {}", remote_dir));
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("Channel error: {}", e))?;
        channel
            .exec(&format!("mkdir -p '{}'", remote_dir))
            .map_err(|e| format!("Failed to create remote directory: {}", e))?;
        channel.wait_close().ok();

        // SCP the file
        dbg_log("INFO", &format!("[TRANSFER] Opening SCP channel: {} -> {}", file_name, remote_path));
        let mut remote_file = session
            .scp_send(Path::new(&remote_path), 0o644, total_bytes, None)
            .map_err(|e| {
                dbg_log("ERROR", &format!("[TRANSFER] SCP open failed: {}", e));
                format!("SCP failed to start: {}", e)
            })?;

        let mut local_file = std::fs::File::open(&file_path)
            .map_err(|e| format!("Cannot open file: {}", e))?;

        // Set global speed limit from parameter
        if let Some(limit) = speed_limit {
            SPEED_LIMIT.store(limit as usize, Ordering::Relaxed);
        }

        // Use smaller chunks when speed-limited for smoother pacing
        let current_limit = SPEED_LIMIT.load(Ordering::Relaxed);
        let chunk_size = if current_limit > 0 {
            (current_limit / 4).clamp(64 * 1024, 1024 * 1024)
        } else {
            1024 * 1024
        };
        dbg_log("INFO", &format!(
            "[TRANSFER] Chunk size: {} bytes, speed limit: {}",
            chunk_size,
            match speed_limit {
                Some(l) if l > 0 => format!("{:.1} MB/s ({} B/s)", l as f64 / (1024.0 * 1024.0), l),
                _ => "unlimited".to_string(),
            }
        ));

        let mut buf = vec![0u8; chunk_size];
        let mut bytes_sent: u64 = 0;
        let start = Instant::now();
        let state = get_transfer_state(&fid);
        state.store(0, Ordering::Relaxed);

        loop {
            // Check for cancel/pause between chunks
            loop {
                let s = state.load(Ordering::Relaxed);
                if s == 2 {
                    dbg_log("INFO", &format!("[TRANSFER] Cancelled by user at {} bytes", bytes_sent));
                    clear_transfer_state(&fid);
                    return Err("Transfer cancelled".to_string());
                }
                if s == 1 {
                    // Paused - wait and recheck
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                break; // running
            }

            let n = local_file
                .read(&mut buf)
                .map_err(|e| format!("Read error: {}", e))?;
            if n == 0 {
                break;
            }

            remote_file
                .write_all(&buf[..n])
                .map_err(|e| {
                    dbg_log("ERROR", &format!("[TRANSFER] Write failed at {} bytes: {}", bytes_sent, e));
                    format!("Write error: {}", e)
                })?;

            bytes_sent += n as u64;

            // Throttle: read live speed limit and sleep to match
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
            } else {
                0
            };
            let remaining = total_bytes.saturating_sub(bytes_sent);
            let eta_seconds = if actual_speed > 0 {
                remaining / actual_speed
            } else {
                0
            };

            let _ = app_handle.emit(
                "transfer-progress",
                TransferProgress {
                    file_id: fid.clone(),
                    bytes_sent,
                    total_bytes,
                    speed_bps: actual_speed,
                    eta_seconds,
                },
            );
        }

        clear_transfer_state(&fid);

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

        let elapsed = start.elapsed().as_secs_f64();
        let avg_speed = if elapsed > 0.0 { bytes_sent as f64 / elapsed } else { 0.0 };
        dbg_log(
            "INFO",
            &format!(
                "[TRANSFER] Complete: {} -> {} ({} bytes in {:.1}s, avg {}/s)",
                file_name, remote_path, bytes_sent, elapsed,
                if avg_speed > 1024.0 * 1024.0 {
                    format!("{:.1} MB", avg_speed / (1024.0 * 1024.0))
                } else if avg_speed > 1024.0 {
                    format!("{:.0} KB", avg_speed / 1024.0)
                } else {
                    format!("{:.0} B", avg_speed)
                }
            ),
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
fn set_speed_limit(limit: u64) {
    SPEED_LIMIT.store(limit as usize, Ordering::Relaxed);
    dbg_log("INFO", &format!("[TRANSFER] Speed limit changed to: {}",
        if limit == 0 { "unlimited".to_string() } else { format!("{:.1} MB/s", limit as f64 / (1024.0 * 1024.0)) }
    ));
}

#[tauri::command]
fn pause_transfer(file_id: String) {
    let state = get_transfer_state(&file_id);
    state.store(1, Ordering::Relaxed);
    dbg_log("INFO", &format!("[TRANSFER] Paused: {}", file_id));
}

#[tauri::command]
fn resume_transfer(file_id: String) {
    let state = get_transfer_state(&file_id);
    state.store(0, Ordering::Relaxed);
    dbg_log("INFO", &format!("[TRANSFER] Resumed: {}", file_id));
}

#[tauri::command]
fn cancel_transfer(file_id: String) {
    let state = get_transfer_state(&file_id);
    state.store(2, Ordering::Relaxed);
    dbg_log("INFO", &format!("[TRANSFER] Cancelled: {}", file_id));
}

#[tauri::command]
async fn get_direct_ethernet_status() -> bool {
    let status = tokio::task::spawn_blocking(is_direct_ethernet_enabled)
        .await
        .unwrap_or(false);
    dbg_log("INFO", &format!("[NET] Direct Ethernet status check: {}", if status { "ENABLED" } else { "DISABLED" }));
    status
}

#[tauri::command]
async fn enable_direct_ethernet() -> Result<(), String> {
    let iface = tokio::task::spawn_blocking(find_ethernet_iface_name)
        .await
        .map_err(|e| format!("Task error: {}", e))?
        .ok_or("No ethernet interface found. Make sure the cable is connected.")?;

    dbg_log(
        "INFO",
        &format!("[NET] Enabling direct Ethernet on '{}'", iface),
    );

    // If already enabled, nothing to do
    if tokio::task::spawn_blocking(is_direct_ethernet_enabled).await.unwrap_or(false) {
        dbg_log("INFO", "[NET] Direct Ethernet already enabled, skipping");
        return Ok(());
    }

    let iface_clone = iface.clone();
    tokio::task::spawn_blocking(move || {
        run_netsh_elevated(&[
            "interface", "ip", "add", "address",
            &iface_clone, DECK_SUBNET_IP, DECK_SUBNET_MASK,
        ])
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Wait for route to stabilize
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Verify it actually worked
    let enabled = tokio::task::spawn_blocking(is_direct_ethernet_enabled)
        .await
        .unwrap_or(false);

    if enabled {
        dbg_log("INFO", "[NET] Direct Ethernet enabled successfully");
        Ok(())
    } else {
        dbg_log("ERROR", "[NET] IP was not applied - UAC may have been denied");
        Err("Failed to configure Ethernet. The permission prompt may have been denied.".to_string())
    }
}

#[tauri::command]
async fn disable_direct_ethernet() -> Result<(), String> {
    let iface = tokio::task::spawn_blocking(find_ethernet_iface_name)
        .await
        .map_err(|e| format!("Task error: {}", e))?
        .ok_or("No ethernet interface found.")?;

    dbg_log(
        "INFO",
        &format!("[NET] Disabling direct Ethernet on '{}'", iface),
    );

    tokio::task::spawn_blocking(move || {
        run_netsh_elevated(&[
            "interface", "ip", "delete", "address",
            &iface, DECK_SUBNET_IP,
        ])
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    dbg_log("INFO", "[NET] Direct Ethernet disabled");
    Ok(())
}

#[tauri::command]
async fn open_debug_window(app: tauri::AppHandle) -> Result<(), String> {
    // Focus existing window if already open
    if let Some(window) = app.get_webview_window("debug") {
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, "debug", tauri::WebviewUrl::App("debug.html".into()))
        .title("Debug Logs - Deck Transfer")
        .inner_size(850.0, 500.0)
        .min_inner_size(500.0, 300.0)
        .build()
        .map_err(|e| format!("Failed to open debug window: {}", e))?;

    dbg_log("INFO", "[DEBUG] Debug window opened");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_for_deck,
            pick_files,
            list_remote_dir,
            create_remote_dir,
            check_remote_files,
            transfer_file,
            get_debug_logs,
            clear_debug_logs,
            frontend_log,
            set_speed_limit,
            pause_transfer,
            resume_transfer,
            cancel_transfer,
            get_direct_ethernet_status,
            enable_direct_ethernet,
            disable_direct_ethernet,
            open_debug_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
