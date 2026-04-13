#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Combyne AI — macOS Installer
# Builds the native Swift app, bundles the server, and installs to /Applications
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

Y='\033[1;33m'; D='\033[2m'; R='\033[0m'

echo ""
echo -e "${Y}   ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗███╗   ██╗███████╗${R}"
echo -e "${Y}  ██╔════╝██╔═══██╗████╗ ████║██╔══██╗╚██╗ ██╔╝████╗  ██║██╔════╝${R}"
echo -e "${Y}  ██║     ██║   ██║██╔████╔██║██████╔╝ ╚████╔╝ ██╔██╗ ██║█████╗  ${R}"
echo -e "${Y}  ██║     ██║   ██║██║╚██╔╝██║██╔══██╗  ╚██╔╝  ██║╚██╗██║██╔══╝  ${R}"
echo -e "${Y}  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██████╔╝   ██║   ██║ ╚████║███████╗${R}"
echo -e "${Y}   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═════╝    ╚═╝   ╚═╝  ╚═══╝╚══════╝${R}"
echo -e "${D}                       .ai  macOS Installer${R}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD="/tmp/combyne-install-$$"
rm -rf "$BUILD"
mkdir -p "$BUILD/app/Contents/MacOS" "$BUILD/app/Contents/Resources" "$BUILD/icon"

info() { echo -e "${Y}▸${R} $1"; }
ok()   { echo -e "${Y}✓${R} $1"; }

# ── Prerequisites ────────────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v node &>/dev/null || { echo "Node.js 20+ required. Install: brew install node"; exit 1; }
command -v swiftc &>/dev/null || { echo "Xcode CLI tools required. Run: xcode-select --install"; exit 1; }
ok "Node $(node -v), Swift $(swiftc --version 2>&1 | head -1 | grep -o 'Swift.*')"

# ── Build project ────────────────────────────────────────────────────────────
info "Building project..."
cd "$REPO_ROOT"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
ok "Project built"

# ── Bundle server ────────────────────────────────────────────────────────────
info "Bundling server..."
cd "$REPO_ROOT/server"
node esbuild.server.mjs 2>&1 | tail -1

# Install server bundle dependencies
if [ ! -d dist/node_modules/postgres ]; then
    cd dist
    node -e "
    const fs=require('fs');const b=fs.readFileSync('server-bundle.js','utf8');const s=new Set();
    const r=/from ['\"]([^'\"./][^'\"]*)['\"]|require\(['\"]([^'\"./][^'\"]*)['\"]?\)/g;let m;
    while(m=r.exec(b)){const p=(m[1]||m[2]).split('/').slice(0,(m[1]||m[2]).startsWith('@')?2:1).join('/');if(!p.startsWith('node:'))s.add(p);}
    const pkg={name:'s',type:'module',private:true,dependencies:{}};for(const i of s)pkg.dependencies[i]='*';
    fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
    " && npm install --omit=dev 2>&1 | tail -1
    cd ..
fi

# Copy migrations
cp -r "$REPO_ROOT/packages/db/src/migrations" dist/migrations 2>/dev/null || true
ok "Server bundled"

# ── Generate icon ────────────────────────────────────────────────────────────
info "Generating app icon..."
python3 "$SCRIPT_DIR/generate-icon.py" "$BUILD/icon" 2>&1 | tail -1
cp "$BUILD/icon/AppIcon.icns" "$BUILD/app/Contents/Resources/"
ok "Icon ready"

# ── Compile Swift app ────────────────────────────────────────────────────────
info "Compiling native app..."
set +eo pipefail
swiftc -O -o "$BUILD/app/Contents/MacOS/CombyneAI" \
  -framework Cocoa -framework WebKit \
  "$SCRIPT_DIR/swift-app/CombyneAI.swift" > /dev/null 2>&1
set -eo pipefail

if [ -f "$BUILD/app/Contents/MacOS/CombyneAI" ]; then
  chmod +x "$BUILD/app/Contents/MacOS/CombyneAI"
  ok "Native app compiled"
elif [ -f "/Applications/Combyne AI.app/Contents/MacOS/CombyneAI" ]; then
  info "Swift compilation failed (SDK mismatch) — reusing existing binary"
  cp "/Applications/Combyne AI.app/Contents/MacOS/CombyneAI" "$BUILD/app/Contents/MacOS/CombyneAI"
elif [ -f "/tmp/CombyneAI-backup" ]; then
  info "Swift compilation failed — using backup binary"
  cp "/tmp/CombyneAI-backup" "$BUILD/app/Contents/MacOS/CombyneAI"
  chmod +x "$BUILD/app/Contents/MacOS/CombyneAI"
  ok "Using pre-built binary"
else
  echo "ERROR: Swift compilation failed and no existing binary found."
  echo "Fix: xcode-select --install  or  sudo xcode-select --reset"
  exit 1
fi

# ── Info.plist ───────────────────────────────────────────────────────────────
cat > "$BUILD/app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Combyne AI</string>
    <key>CFBundleDisplayName</key><string>Combyne AI</string>
    <key>CFBundleIdentifier</key><string>ai.combyne.app</string>
    <key>CFBundleVersion</key><string>0.2.7</string>
    <key>CFBundleShortVersionString</key><string>0.2.7</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>CombyneAI</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>LSUIElement</key><false/>
    <key>NSHighResolutionCapable</key><true/>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
    <key>NSAppSleepDisabled</key><true/>
    <key>NSAppTransportSecurity</key>
    <dict><key>NSAllowsLocalNetworking</key><true/><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict>
</plist>
PLIST

# ── Install ──────────────────────────────────────────────────────────────────
info "Installing to /Applications..."
# Backup existing binary before removal (in case Swift recompilation fails on next install)
[ -f "/Applications/Combyne AI.app/Contents/MacOS/CombyneAI" ] && \
  cp "/Applications/Combyne AI.app/Contents/MacOS/CombyneAI" /tmp/CombyneAI-backup 2>/dev/null || true
rm -rf "/Applications/Combyne AI.app"
cp -R "$BUILD/app" "/Applications/Combyne AI.app"
xattr -cr "/Applications/Combyne AI.app" 2>/dev/null || true

# Create data directory
mkdir -p ~/.combyne-ai/instances/default/logs ~/.combyne-ai/instances/default/data
mkdir -p ~/Library/Logs/CombyneAI

# Create config
CONFIG=~/.combyne-ai/instances/default/config.json
[ ! -f "$CONFIG" ] && echo '{"server":{"host":"127.0.0.1","port":3100,"deploymentMode":"local_trusted","exposure":"private"},"database":{"mode":"embedded-postgres","embeddedPostgresPort":54329},"logging":{"level":"info"},"storage":{"mode":"local"},"secrets":{"mode":"env"},"auth":{"baseUrlMode":"auto"}}' > "$CONFIG"

# Register with Launchpad
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Combyne AI.app" 2>/dev/null
defaults write com.apple.dock ResetLaunchPad -bool true
killall Dock 2>/dev/null
sleep 2

ok "Installed to /Applications/Combyne AI.app"

# ── Cleanup ──────────────────────────────────────────────────────────────────
rm -rf "$BUILD"

# ── Launch ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${Y}═══════════════════════════════════════════════════════${R}"
echo -e "${Y}  Combyne AI installed! Launching...${R}"
echo -e "${Y}═══════════════════════════════════════════════════════${R}"
echo ""

defaults delete ai.combyne.app 2>/dev/null || true
open "/Applications/Combyne AI.app"
