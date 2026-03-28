# Deck Transfer

A desktop app for transferring files from your PC to a Steam Deck over Ethernet or Wi-Fi.

## Features
- Transfer files via direct Ethernet cable or Wi-Fi
- Drag-and-drop or browse to queue files
- Browse and navigate the Deck's file system
- Pause, resume, and cancel individual transfers
- Adjustable speed limiter (changes take effect mid-transfer)
- Auto-detects Steam Deck on the network
- One-click Direct Ethernet adapter setup (no manual static IPs)
- Conflict detection for existing files (replace, skip, or cancel)
- Debug window for troubleshooting connection issues
- Auto-clear completed files option

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

- **Portable EXE** - no install needed, just run
- **Installer** - NSIS setup wizard
- **MSIX** - Microsoft Store format

## Development

```
npm install
npm run tauri dev
```

## Build

```
npm run tauri build
```

## License

MIT
