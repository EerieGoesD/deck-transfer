use network_interface::{NetworkInterface, NetworkInterfaceConfig};
use std::net::Ipv4Addr;

pub struct EthernetInterface {
    pub name: String,
    pub ip: Ipv4Addr,
    pub netmask: Ipv4Addr,
}

/// Find active ethernet interfaces (not WiFi, not loopback, not virtual).
pub fn find_ethernet_interfaces() -> Result<Vec<EthernetInterface>, String> {
    let interfaces = NetworkInterface::show()
        .map_err(|e| format!("Cannot list interfaces: {}", e))?;

    let mut result = Vec::new();

    for iface in interfaces {
        let name_lower = iface.name.to_lowercase();

        // Skip loopback, WiFi, virtual adapters
        if name_lower.contains("loopback")
            || name_lower.contains("lo")
            || name_lower.contains("wi-fi")
            || name_lower.contains("wifi")
            || name_lower.contains("wlan")
            || name_lower.contains("wireless")
            || name_lower.contains("vethernet")
            || name_lower.contains("docker")
            || name_lower.contains("vmware")
            || name_lower.contains("virtualbox")
            || name_lower.contains("hyper-v")
            || name_lower.contains("vbox")
        {
            continue;
        }

        // Look for "ethernet" in name or generic adapter names
        let is_ethernet = name_lower.contains("ethernet")
            || name_lower.contains("eth")
            || name_lower.contains("enp")
            || name_lower.contains("eno")
            || name_lower.contains("ens")
            || name_lower.contains("realtek")
            || name_lower.contains("intel");

        if !is_ethernet {
            continue;
        }

        for addr in &iface.addr {
            if let network_interface::Addr::V4(v4) = addr {
                let ip = v4.ip;
                // Skip loopback, unassigned, and VirtualBox host-only (192.168.56.x)
                if ip.is_loopback()
                    || ip.is_unspecified()
                    || (ip.octets()[0] == 192
                        && ip.octets()[1] == 168
                        && ip.octets()[2] == 56)
                {
                    continue;
                }

                let netmask = v4.netmask.unwrap_or(Ipv4Addr::new(255, 255, 255, 0));

                result.push(EthernetInterface {
                    name: iface.name.clone(),
                    ip,
                    netmask,
                });
            }
        }
    }

    Ok(result)
}

/// Generate IP candidates to scan on the same subnet.
/// For direct ethernet connections, we scan the whole /24 subnet
/// plus link-local range.
pub fn get_scan_candidates(local_ip: &Ipv4Addr) -> Vec<Ipv4Addr> {
    let mut candidates = Vec::new();
    let octets = local_ip.octets();

    // Scan the local /24 subnet (skip .0 and .255, and our own IP)
    for i in 1..255u8 {
        let candidate = Ipv4Addr::new(octets[0], octets[1], octets[2], i);
        if &candidate != local_ip {
            candidates.push(candidate);
        }
    }

    // If we're not already on link-local, also scan 169.254.x.x range
    // (common for direct ethernet without DHCP)
    if octets[0] != 169 || octets[1] != 254 {
        for i in 1..255u8 {
            candidates.push(Ipv4Addr::new(169, 254, octets[2], i));
        }
    }

    candidates
}
