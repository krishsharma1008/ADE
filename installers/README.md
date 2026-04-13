# Combyne AI — macOS Installer

Native macOS app with built-in WebView. No browser needed.

## Install (direct)

```bash
./installers/macos/install.sh
```

Builds and installs the app to `/Applications`, then launches it.

## Build DMG

```bash
./installers/macos/build-dmg.sh
```

Creates a distributable `.dmg` file in `installers/macos/` with drag-to-Applications support. Output: `CombyneAI-<version>-arm64.dmg`

## What it does

- Starts the Combyne server automatically
- Displays the UI in a native macOS window
- Shows the gold C icon in your Dock
- Cmd+Q to quit — server stops automatically

## Prerequisites

- macOS 13+ (Ventura or later)
- Apple Silicon (M1/M2/M3/M4)
- Node.js 20+ (`brew install node`)
- Xcode CLI tools (`xcode-select --install`)

## Files

```
installers/macos/
├── install.sh              # Direct installer (builds + installs + launches)
├── build-dmg.sh            # DMG packager (builds distributable .dmg)
├── generate-icon.py        # App icon generator (gold C, honeycomb)
├── dmg-background.py       # DMG window background generator
└── swift-app/
    ├── CombyneAI.swift     # Native Swift app source
    └── CombyneAI           # Pre-compiled arm64 binary
```

## Uninstall

```bash
rm -rf "/Applications/Combyne AI.app" ~/.combyne-ai ~/Library/Logs/CombyneAI
```
