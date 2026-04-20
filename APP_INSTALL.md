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

### Agent tries to run `bd init`, `linear`, or some other tool that isn't installed
ADE itself does not install or depend on Beads (`bd`), Linear CLI, GitHub CLI, or any similar per-user tooling. If an agent shells out to `bd init` (or similar) and the command isn't on your `PATH`, the call is coming from one of two places on **your** machine:

1. **An MCP server you registered** with the Claude/Codex CLI (e.g. the `beads` MCP). List what the agent sees:
   ```bash
   # Claude Code MCP registrations
   cat ~/.claude.json 2>/dev/null | jq '.mcpServers // {}'
   claude mcp list

   # Codex MCP registrations
   cat ~/.codex/config.json 2>/dev/null | jq '.mcpServers // {}'
   ```
   Remove one you don't want: `claude mcp remove beads` (or delete the entry from the JSON).
2. **Instructions that tell the agent to use the tool** — check your per-agent `instructionsFilePath` (configurable in the Agent settings UI), any `CLAUDE.md` / `AGENTS.md` in the project workspace, and any company skills listed on the company's **Skills** page.

ADE ships zero references to `bd`, `beads`, or a local-issue-tracker CLI — `rg "bd init|beads" packages server skills docs` returns nothing. If you want agents to stay fully local without external tool calls, remove the corresponding MCP + skill.

### Pulling updates (for pilots)
```bash
git pull origin main
pnpm install
pnpm --filter @combyne/db migrate   # applies any new migrations (e.g. 0033, 0034)
```
Then restart the server (`pnpm dev`) or the macOS app.

## Brand

- **Background**: Deep black `#0B0B0F`
- **Primary**: Amber gold `#F5A623` / `#EAB308`
- **Tagline**: "The Hive That Gets Things Done"
- **Favicon**: Gold C on black (all sizes + .ico + .svg)
