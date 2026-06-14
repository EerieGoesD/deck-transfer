# Deck Transfer

A desktop app for transferring files from your PC to a Steam Deck over Ethernet or Wi-Fi.

## Features
- Transfer files via direct Ethernet cable or Wi-Fi
- Drag-and-drop or browse to queue files
- Browse and navigate the Deck's file system
- Pause, resume, and cancel individual transfers
- Auto-detects Steam Deck on the network
- One-click Direct Ethernet adapter setup (no manual static IPs)
- Conflict detection for existing files (replace, skip, or cancel)
- Debug window for troubleshooting connection issues

## Requirements

### PC
- Windows 10/11

### Steam Deck
1. Enable Developer Mode: Settings > System > Enable Developer Mode
2. Switch to Desktop Mode, open Konsole, and run:
```
passwd
sudo systemctl enable sshd
sudo systemctl start sshd
```

## Download

[Microsoft Store](https://apps.microsoft.com/detail/9NRZ0CVFG1H8?hl=en-us&gl=PT&ocid=pdpshare)

## Feedback

- Made by [EERIE](https://eeriegoesd.com)
- [Buy Me a Coffee](https://buymeacoffee.com/eeriegoesd)
- [Report Issue](https://github.com/EerieGoesD/deck-transfer/issues/new?template=bug-report.md)
- [Feedback](https://github.com/EerieGoesD/deck-transfer/discussions)
