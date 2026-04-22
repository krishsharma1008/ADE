# Combyne AI — macOS App Installer (Apple Silicon)

A native macOS app for Combyne AI with a built-in WebView. No browser needed — everything runs inside a single app window.

## Quick Install

```bash
./installers/macos/install.sh
```

This single command builds everything, installs the app to `/Applications`, and launches it.

## Build DMG

```bash
./installers/macos/build-dmg.sh
```

Creates `installers/macos/CombyneAI-<version>-arm64.dmg` — a distributable disk image with:
- `Combyne AI.app` ready to drag
- Applications folder shortcut
- Branded background with honeycomb pattern
- Compressed and verified

## What You Get

- **Native macOS app** — Swift + WKWebView, not Electron
- **Gold C icon** in Dock and Launchpad (honeycomb pattern, black background)
- **Built-in UI** — the Combyne dashboard loads inside the app window
- **Embedded PostgreSQL** — no database setup required
- **Auto-start server** — click the app, everything starts automatically
- **Cmd+Q to quit** — server stops cleanly when you close the app
- **Full clipboard support** — Cmd+V paste works in all fields
- **Claude CLI integration** — inherits your `claude login` session

## Prerequisites

| Requirement | Install |
|-------------|---------|
| macOS 13+ (Ventura or later) | — |
| Apple Silicon (M1/M2/M3/M4) | — |
| Node.js 20+ | `brew install node` |
| Xcode CLI tools | `xcode-select --install` |
| Combyne repo built | `pnpm install && pnpm build` |

## How It Works

The installer does 6 things:

1. **Builds the project** — `pnpm install && pnpm build`
2. **Bundles the server** — esbuild compiles the server into a single `server-bundle.js` (no tsx dependency)
3. **Generates the app icon** — Python script creates a 1024x1024 icon with honeycomb pattern
4. **Compiles the Swift app** — native binary with WKWebView (~110KB)
5. **Installs to /Applications** — copies `Combyne AI.app` and registers with Launchpad
6. **Launches the app** — server starts, UI loads in the native window

## Architecture

```
Combyne AI.app
├── Contents/
│   ├── Info.plist              (app metadata, bundle ID: ai.combyne.app)
│   ├── MacOS/
│   │   └── CombyneAI          (Swift binary — WKWebView + server launcher)
│   └── Resources/
│       └── AppIcon.icns        (gold C on black with honeycomb pattern)
```

The Swift app:
- Finds the Combyne repo on disk
- Finds Node.js
- Starts the esbuild-bundled server (`server/dist/server-bundle.js`)
- Polls the health endpoint until ready
- Loads `http://127.0.0.1:3100` in the native WebView
- Kills the server on app quit

Data is stored at `~/.combyne-ai/` with embedded PostgreSQL.

## Files in This Branch

```
installers/
├── README.md                           # Installer overview
└── macos/
    ├── install.sh                      # One-command installer script
    ├── build-dmg.sh                    # DMG packager for distribution
    ├── generate-icon.py                # App icon generator (Python)
    ├── dmg-background.py               # DMG background image generator
    └── swift-app/
        ├── CombyneAI.swift             # Native Swift app source
        └── CombyneAI                   # Compiled binary (arm64)

server/
└── esbuild.server.mjs                 # Server bundler config

APP_INSTALL.md                          # This file
```

## Uninstall

```bash
rm -rf "/Applications/Combyne AI.app" ~/.combyne-ai ~/Library/Logs/CombyneAI
```

## Troubleshooting

### App shows "Server stopped unexpectedly"
The embedded PostgreSQL data may be corrupted. Fix:
```bash
rm -rf ~/.combyne-ai/instances/default/db
```
Then relaunch the app (it will reinitialize the database).

### Claude adapter test fails
Ensure Claude CLI is logged in:
```bash
claude login
```

### App doesn't appear in Launchpad
```bash
defaults write com.apple.dock ResetLaunchPad -bool true && killall Dock
```

## Round 3 tuning (optional)

Round 3 adds a context-budget composer and transcript summarizer. Defaults work out of the box; these env vars only matter if you want to tune per-adapter behaviour.

- `COMBYNE_SUMMARIZER_ENABLED` — `1` or `true` to turn on the Anthropic summarizer queue. Off by default while we finish the Round 3 rollout; requires `ANTHROPIC_API_KEY` (or `COMBYNE_SUMMARIZER_ANTHROPIC_API_KEY`).
- `COMBYNE_CLAUDE_CONTEXT_BUDGET_TOKENS`, `COMBYNE_CODEX_CONTEXT_BUDGET_TOKENS`, `COMBYNE_CURSOR_CONTEXT_BUDGET_TOKENS`, `COMBYNE_GEMINI_CONTEXT_BUDGET_TOKENS`, `COMBYNE_OPENCODE_CONTEXT_BUDGET_TOKENS`, `COMBYNE_PI_CONTEXT_BUDGET_TOKENS` — override per-adapter input-token budgets; per-agent `adapterConfig.contextBudgetTokens` still wins.
- Per-routine `autoCloseAfterMs` (set via the Routines UI) auto-closes stale routine-origin issues so they don't pile up in the inbox.

## Brand

- **Background**: Deep black `#0B0B0F`
- **Primary**: Amber gold `#F5A623` / `#EAB308`
- **Tagline**: "The Hive That Gets Things Done"
- **Favicon**: Gold C on black (all sizes + .ico + .svg)
