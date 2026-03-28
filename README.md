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

Get the latest release from the [Releases page](https://github.com/EerieGoesD/deck-transfer/releases).

## Feedback

- Made by [EERIE](https://eeriegoesd.com)
- [Buy Me a Coffee](https://buymeacoffee.com/eeriegoesd)
- [Report Issue](https://github.com/EerieGoesD/deck-transfer/issues)
- [Feedback](https://github.com/EerieGoesD/deck-transfer/discussions)
