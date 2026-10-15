// macOS-only pieces:
//   - finding the Deck from a Mac: which ports are Wi-Fi or wired, and IPv6
//     link-local discovery so a direct cable works with no IP setup at all
//     (the Windows "Direct Ethernet" setup changes system network settings,
//     which the App Sandbox does not allow);
//   - keeping access to files and folders picked in an earlier launch, which a
//     sandboxed app can only do through security-scoped bookmarks.

use std::collections::HashSet;
use std::io::Read;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6, TcpStream};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::dbg_log;
use crate::network::EthernetInterface;

// ---------------------
// Network links
// ---------------------

/// A network port on this Mac that has an IPv6 link-local address, so the
/// scan can ask everything on that link to answer.
pub struct MacLink {
    pub name: String,
    pub index: u32,
}

/// BSD names of the Wi-Fi ports and the wired (Ethernet, USB and Thunderbolt
/// adapter) ports, as System Settings knows them.
fn port_kinds() -> (HashSet<String>, HashSet<String>) {
    use system_configuration::network_configuration::{get_interfaces, SCNetworkInterfaceType};
    let mut wifi = HashSet::new();
    let mut wired = HashSet::new();
    for iface in get_interfaces().iter() {
        let Some(name) = iface.bsd_name().map(|n| n.to_string()) else { continue };
        match iface.interface_type() {
            Some(SCNetworkInterfaceType::IEEE80211) => {
                wifi.insert(name);
            }
            Some(SCNetworkInterfaceType::Ethernet) => {
                wired.insert(name);
            }
            _ => {}
        }
    }
    (wifi, wired)
}

fn is_link_local_v6(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// The ports to scan for the chosen mode: their IPv4 addresses for the subnet
/// sweep, and the links for IPv6 discovery.
pub fn find_interfaces(wifi_mode: bool) -> (Vec<EthernetInterface>, Vec<MacLink>) {
    use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};

    let (wifi, wired) = port_kinds();
    let known = !wifi.is_empty() || !wired.is_empty();
    dbg_log(
        "INFO",
        &format!(
            "[SCAN] Mac ports - Wi-Fi: {:?}, wired: {:?}",
            wifi.iter().collect::<Vec<_>>(),
            wired.iter().collect::<Vec<_>>()
        ),
    );

    let mut v4 = Vec::new();
    let mut links: Vec<MacLink> = Vec::new();
    for iface in NetworkInterface::show().unwrap_or_default() {
        let name = iface.name.clone();
        let wanted = if known {
            if wifi_mode { wifi.contains(&name) } else { wired.contains(&name) }
        } else {
            // System Settings gave no answer: try every hardware port.
            name.starts_with("en")
        };
        if !wanted {
            continue;
        }
        for addr in &iface.addr {
            match addr {
                Addr::V4(a) => {
                    if a.ip.is_loopback() || a.ip.is_unspecified() {
                        continue;
                    }
                    if v4.iter().any(|e: &EthernetInterface| e.name == name && e.ip == a.ip) {
                        continue;
                    }
                    v4.push(EthernetInterface {
                        name: name.clone(),
                        ip: a.ip,
                        netmask: a.netmask.unwrap_or(Ipv4Addr::new(255, 255, 255, 0)),
                    });
                }
                Addr::V6(a) => {
                    if !is_link_local_v6(&a.ip) || links.iter().any(|l| l.name == name) {
                        continue;
                    }
                    let index = interface_index(&name);
                    if index != 0 {
                        links.push(MacLink { name: name.clone(), index });
                    }
                }
            }
        }
    }
    (v4, links)
}

fn interface_index(name: &str) -> u32 {
    let Ok(c) = std::ffi::CString::new(name) else { return 0 };
    unsafe { libc::if_nametoindex(c.as_ptr()) }
}

/// This Mac's own IPv6 addresses, so it does not count itself as a device.
pub fn own_v6_addresses() -> HashSet<Ipv6Addr> {
    use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig};
    let mut own = HashSet::new();
    for iface in NetworkInterface::show().unwrap_or_default() {
        for addr in &iface.addr {
            if let Addr::V6(a) = addr {
                own.insert(a.ip);
            }
        }
    }
    own
}

/// Ask every device on the link to answer a ping (IPv6 all-nodes multicast)
/// and return who answered. Works with no IP setup on either side, which is
/// what a direct cable between a Mac and a Deck has.
pub fn ipv6_neighbors(link: &MacLink, own: &HashSet<Ipv6Addr>) -> Vec<Ipv6Addr> {
    use socket2::{Domain, Protocol, SockAddr, Socket, Type};
    use std::mem::MaybeUninit;

    let sock = match Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::ICMPV6)) {
        Ok(s) => s,
        Err(e) => {
            dbg_log("WARN", &format!("[SCAN] {}: IPv6 ping unavailable: {}", link.name, e));
            return Vec::new();
        }
    };
    let _ = sock.set_multicast_if_v6(link.index);
    let _ = sock.set_multicast_hops_v6(1);
    let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));

    // Echo request: type 128, code 0, checksum (filled in by the system), id, sequence, payload.
    let packet: [u8; 12] = [128, 0, 0, 0, 0x44, 0x54, 0, 1, b'd', b'e', b'c', b'k'];
    let all_nodes = SocketAddrV6::new(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 1), 0, 0, link.index);
    let target = SockAddr::from(all_nodes);
    for _ in 0..2 {
        if let Err(e) = sock.send_to(&packet, &target) {
            dbg_log("INFO", &format!("[SCAN] {}: IPv6 ping not sent: {}", link.name, e));
            return Vec::new();
        }
    }

    let mut found: Vec<Ipv6Addr> = Vec::new();
    let mut buf = [MaybeUninit::<u8>::uninit(); 1500];
    let deadline = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < deadline {
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            // Echo reply is type 129.
            if n == 0 || unsafe { buf[0].assume_init() } != 129 {
                continue;
            }
            if let Some(v6) = from.as_socket_ipv6() {
                let ip = *v6.ip();
                if !own.contains(&ip) && !found.contains(&ip) {
                    found.push(ip);
                }
            }
        }
    }
    found
}

/// Is an SSH server listening at this link-local address? Returns its banner.
pub fn check_ssh_v6(ip: Ipv6Addr, link: &MacLink, timeout_ms: u64) -> Option<String> {
    let addr = SocketAddr::V6(SocketAddrV6::new(ip, 22, 0, link.index));
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut buf = [0u8; 256];
    let n = (&stream).read(&mut buf).ok()?;
    let banner = String::from_utf8_lossy(&buf[..n]).trim().to_string();
    if banner.contains("SSH") {
        dbg_log("INFO", &format!("[PROBE] {}%{} - SSH found: {}", ip, link.name, banner));
        Some(banner)
    } else {
        None
    }
}

// ---------------------
// File access across launches
// ---------------------

const ACCESS_FILE: &str = "file-access.json";
// Matches the transfer history's length, so a re-send from history still has
// access to its files.
const MAX_REMEMBERED: usize = 500;

#[derive(Default, Serialize, Deserialize)]
struct AccessStore {
    /// (path, security-scoped bookmark in base64), oldest first.
    entries: Vec<(String, String)>,
}

// Access reopened from a bookmark stays open for the life of the app.
#[allow(dead_code)] // held only to keep the access open
struct HeldUrl(objc2::rc::Retained<objc2_foundation::NSURL>);
// NSURL is immutable, and Apple documents it as safe to share across threads.
unsafe impl Send for HeldUrl {}
unsafe impl Sync for HeldUrl {}
static HELD: Mutex<Vec<HeldUrl>> = Mutex::new(Vec::new());

fn store_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(ACCESS_FILE))
}

fn load(app: &AppHandle) -> AccessStore {
    store_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, store: &AccessStore) {
    if let (Some(p), Ok(json)) = (store_path(app), serde_json::to_vec(store)) {
        let _ = std::fs::write(p, json);
    }
}

fn bookmark(path: &str) -> Option<Vec<u8>> {
    use objc2_foundation::{NSString, NSURLBookmarkCreationOptions, NSURL};
    NSURL::fileURLWithPath(&NSString::from_str(path))
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .ok()
        .map(|d| d.to_vec())
}

fn resume(bytes: &[u8]) -> bool {
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSURLBookmarkResolutionOptions, NSURL};
    let data = NSData::with_bytes(bytes);
    let mut stale = Bool::NO;
    let Ok(url) = (unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &data,
            NSURLBookmarkResolutionOptions::WithSecurityScope,
            None,
            &mut stale,
        )
    }) else {
        return false;
    };
    if !unsafe { url.startAccessingSecurityScopedResource() } {
        return false;
    }
    if let Ok(mut held) = HELD.lock() {
        held.push(HeldUrl(url));
    }
    true
}

/// Save a bookmark for each picked or dropped path, so a later launch can
/// reach it again (scheduled syncs, re-sending from history).
pub fn remember(app: &AppHandle, paths: &[String]) {
    use base64::Engine;
    if paths.is_empty() {
        return;
    }
    let mut store = load(app);
    for p in paths {
        // Fails while access to the same folder is already open from an
        // earlier bookmark; that bookmark is kept and still covers it.
        let Some(bytes) = bookmark(p) else { continue };
        store.entries.retain(|(q, _)| q != p);
        store
            .entries
            .push((p.clone(), base64::engine::general_purpose::STANDARD.encode(bytes)));
    }
    if store.entries.len() > MAX_REMEMBERED {
        let extra = store.entries.len() - MAX_REMEMBERED;
        store.entries.drain(..extra);
    }
    save(app, &store);
}

/// Reopen access to any of these paths this launch cannot reach yet, from the
/// bookmark saved for the path itself or for a folder that holds it.
pub fn ensure_access(app: &AppHandle, paths: &[&str]) {
    use base64::Engine;
    let mut store: Option<AccessStore> = None;
    for p in paths {
        if std::fs::metadata(p).is_ok() {
            continue;
        }
        let store = store.get_or_insert_with(|| load(app));
        let best = store
            .entries
            .iter()
            .filter(|(q, _)| Path::new(p).starts_with(q))
            .max_by_key(|(q, _)| q.len());
        if let Some((q, b64)) = best {
            let ok = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map(|bytes| resume(&bytes))
                .unwrap_or(false);
            dbg_log(
                if ok { "INFO" } else { "WARN" },
                &format!("[ACCESS] Reopen {}: {}", q, if ok { "ok" } else { "failed" }),
            );
        }
    }
}
