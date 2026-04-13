#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Combyne AI — Standalone DMG Builder for Apple Silicon
# Builds a fully self-contained .app bundle (includes Node.js, server, UI,
# embedded PostgreSQL) and packages it into a distributable .dmg.
#
# The resulting DMG works on a fresh Mac with ZERO prerequisites.
#
# Prerequisites (build machine only):
#   - Node.js 20+, pnpm, Xcode CLI tools (swiftc)
#
# Usage:
#   ./StandAloneAppleSiliconInstaller/build-standalone-dmg.sh
#
# Output:
#   StandAloneAppleSiliconInstaller/CombyneAI-<version>-standalone-arm64.dmg
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

Y='\033[1;33m'; D='\033[2m'; G='\033[0;32m'; R='\033[0m'

echo ""
echo -e "${Y}   ██████╗ ██████╗ ███╗   ███╗██████╗ ██╗   ██╗███╗   ██╗███████╗${R}"
echo -e "${Y}  ██╔════╝██╔═══██╗████╗ ████║██╔══██╗╚██╗ ██╔╝████╗  ██║██╔════╝${R}"
echo -e "${Y}  ██║     ██║   ██║██╔████╔██║██████╔╝ ╚████╔╝ ██╔██╗ ██║█████╗  ${R}"
echo -e "${Y}  ██║     ██║   ██║██║╚██╔╝██║██╔══██╗  ╚██╔╝  ██║╚██╗██║██╔══╝  ${R}"
echo -e "${Y}  ╚██████╗╚██████╔╝██║ ╚═╝ ██║██████╔╝   ██║   ██║ ╚████║███████╗${R}"
echo -e "${Y}   ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═════╝    ╚═╝   ╚═╝  ╚═══╝╚══════╝${R}"
echo -e "${D}              .ai  Standalone DMG Builder (Apple Silicon)${R}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configurable Node.js version
NODE_VERSION="${NODE_VERSION:-22.12.0}"
NODE_ARCH="darwin-arm64"
NODE_TARBALL="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

# Read version from package.json
VERSION=$(node -e "console.log(require('$REPO_ROOT/server/package.json').version)" 2>/dev/null || echo "0.2.7")
APP_NAME="Combyne AI"
DMG_NAME="CombyneAI-${VERSION}-standalone-arm64"
DMG_OUTPUT="$SCRIPT_DIR/${DMG_NAME}.dmg"
VOLUME_NAME="Combyne AI ${VERSION}"

STAGING="/tmp/combyne-standalone-dmg-$$"
APP_BUNDLE="$STAGING/dmg-contents/${APP_NAME}.app"

cleanup() {
    if [ -d "/Volumes/${VOLUME_NAME}" ]; then
        hdiutil detach "/Volumes/${VOLUME_NAME}" -quiet 2>/dev/null || true
    fi
    rm -rf "$STAGING"
}
trap cleanup EXIT

rm -rf "$STAGING"
mkdir -p "$STAGING/dmg-contents" "$STAGING/node-download"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
mkdir -p "$APP_BUNDLE/Contents/ui-dist"

info() { echo -e "${Y}▸${R} $1"; }
ok()   { echo -e "${G}✓${R} $1"; }
fail() { echo -e "\033[1;31m✗${R} $1"; exit 1; }

# ── Check architecture ──────────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
    echo -e "\033[1;31mWarning: This builds an Apple Silicon (arm64) app.${R}"
    echo -e "\033[1;31mCurrent architecture: $ARCH. The resulting binary may not run here.${R}"
    echo ""
fi

# ── Prerequisites (build machine) ────────────────────────────────────────
info "Checking build prerequisites..."
command -v node &>/dev/null || fail "Node.js 20+ required on build machine"
command -v pnpm &>/dev/null || fail "pnpm required on build machine"
command -v swiftc &>/dev/null || fail "Xcode CLI tools required. Run: xcode-select --install"
command -v hdiutil &>/dev/null || fail "hdiutil not found (macOS required)"
ok "Build tools: Node $(node -v), pnpm $(pnpm -v), Swift available"

# ── Step 1: Download Node.js arm64 binary ────────────────────────────────
info "Downloading Node.js v${NODE_VERSION} arm64 binary..."
CACHED_NODE="$SCRIPT_DIR/.cache/node-v${NODE_VERSION}-${NODE_ARCH}"
if [ -f "$CACHED_NODE/bin/node" ]; then
    ok "Using cached Node.js binary"
else
    mkdir -p "$SCRIPT_DIR/.cache"
    curl -fSL --progress-bar "$NODE_URL" -o "$STAGING/node-download/${NODE_TARBALL}"
    tar -xzf "$STAGING/node-download/${NODE_TARBALL}" -C "$STAGING/node-download/"
    mv "$STAGING/node-download/node-v${NODE_VERSION}-${NODE_ARCH}" "$CACHED_NODE"
    ok "Node.js v${NODE_VERSION} downloaded"
fi

# Verify the binary
BUNDLED_NODE="$CACHED_NODE/bin/node"
"$BUNDLED_NODE" --version &>/dev/null || fail "Downloaded Node.js binary failed to execute"
ok "Node.js binary verified: $("$BUNDLED_NODE" --version)"

# ── Step 2: Build project ────────────────────────────────────────────────
info "Building project..."
cd "$REPO_ROOT"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
ok "Project built"

# ── Step 3: Bundle server with esbuild ───────────────────────────────────
info "Bundling server with esbuild..."
cd "$REPO_ROOT/server"
node esbuild.server.mjs 2>&1 | tail -1

# Install server bundle runtime dependencies
cd dist
# Auto-detect external dependencies from the bundle
node -e "
const fs=require('fs');const b=fs.readFileSync('server-bundle.js','utf8');const s=new Set();
const r=/from ['\"]([^'\"./][^'\"]*)['\"]|require\(['\"]([^'\"./][^'\"]*)['\"]?\)/g;let m;
// Node.js built-in modules to exclude (they get falsely detected from banner shims)
const builtins=new Set(['module','url','path','fs','os','util','crypto','stream','events','buffer','http','https','net','tls','child_process','cluster','dgram','dns','readline','repl','string_decoder','tty','v8','vm','zlib','assert','querystring','worker_threads','perf_hooks','async_hooks']);
while(m=r.exec(b)){const p=(m[1]||m[2]).split('/').slice(0,(m[1]||m[2]).startsWith('@')?2:1).join('/');if(!p.startsWith('node:')&&!builtins.has(p))s.add(p);}
const pkg={name:'combyne-standalone',type:'module',private:true,dependencies:{}};for(const i of s)pkg.dependencies[i]='*';
// Add dynamically resolved packages that the regex scanner misses
// (referenced as string literals, dynamic import(), or pino transport targets)
pkg.dependencies['embedded-postgres']='*';
pkg.dependencies['@embedded-postgres/darwin-arm64']='*';
pkg.dependencies['pino-pretty']='*';    // pino transport target: 'pino-pretty'
pkg.dependencies['open']='*';           // dynamic import('open') in server startup
pkg.dependencies['picocolors']='*';     // used by adapters for terminal colors
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));
"
npm install --omit=dev 2>&1 | tail -3
cd ..

# Ensure embedded-postgres symlinks are hydrated
if [ -d "dist/node_modules/@embedded-postgres/darwin-arm64/scripts" ]; then
    cd dist/node_modules/@embedded-postgres/darwin-arm64
    node scripts/hydrate-symlinks.js 2>/dev/null || true
    cd "$REPO_ROOT/server"
fi

# Verify embedded-postgres native binary exists
test -f "dist/node_modules/@embedded-postgres/darwin-arm64/native/bin/postgres" || fail "embedded-postgres native binary missing"

# Copy migrations
cp -r "$REPO_ROOT/packages/db/src/migrations" dist/migrations 2>/dev/null || true
ok "Server bundled with all dependencies"

# ── Step 4: Compile Swift app (arm64) ────────────────────────────────────
info "Compiling native Swift app (arm64)..."
swiftc -O -target arm64-apple-macos13 \
    -o "$APP_BUNDLE/Contents/MacOS/CombyneAI" \
    -framework Cocoa -framework WebKit -framework IOKit \
    "$SCRIPT_DIR/swift-app/CombyneAI.swift" 2>&1 | grep -v warning || true
chmod +x "$APP_BUNDLE/Contents/MacOS/CombyneAI"
ok "Swift app compiled ($(du -h "$APP_BUNDLE/Contents/MacOS/CombyneAI" | cut -f1 | xargs))"

# ── Step 5: Assemble app bundle ──────────────────────────────────────────
info "Assembling standalone app bundle..."

# Node.js binary
cp "$BUNDLED_NODE" "$APP_BUNDLE/Contents/Resources/node"
chmod +x "$APP_BUNDLE/Contents/Resources/node"

# Server bundle
cp "$REPO_ROOT/server/dist/server-bundle.js" "$APP_BUNDLE/Contents/Resources/"
cp "$REPO_ROOT/server/dist/server-bundle.js.map" "$APP_BUNDLE/Contents/Resources/" 2>/dev/null || true

# Node modules (use ditto to preserve symlinks)
ditto "$REPO_ROOT/server/dist/node_modules" "$APP_BUNDLE/Contents/Resources/node_modules"

# Migrations
cp -R "$REPO_ROOT/server/dist/migrations" "$APP_BUNDLE/Contents/Resources/migrations"

# Skills
if [ -d "$REPO_ROOT/skills" ]; then
    cp -R "$REPO_ROOT/skills" "$APP_BUNDLE/Contents/Resources/skills"
fi

# UI dist (placed at Contents/ui-dist/ — server resolves ../ui-dist from __dirname)
cp -R "$REPO_ROOT/ui/dist/"* "$APP_BUNDLE/Contents/ui-dist/"

# Package.json for ESM module resolution
echo '{"name":"combyne-standalone","type":"module","private":true}' > "$APP_BUNDLE/Contents/Resources/package.json"

# App icon — use pre-generated if available, else generate
if [ -f "$SCRIPT_DIR/assets/AppIcon.icns" ]; then
    cp "$SCRIPT_DIR/assets/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/"
elif command -v python3 &>/dev/null; then
    info "Generating app icon..."
    python3 "$SCRIPT_DIR/generate-icon.py" "$STAGING/icon" 2>&1 | tail -1
    cp "$STAGING/icon/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/"
else
    echo -e "\033[1;33mWarning: No pre-generated icon and python3 not available. App will use default icon.${R}"
fi

ok "App bundle assembled"

# ── Step 6: Info.plist ───────────────────────────────────────────────────
cat > "$APP_BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Combyne AI</string>
    <key>CFBundleDisplayName</key><string>Combyne AI</string>
    <key>CFBundleIdentifier</key><string>ai.combyne.app</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
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
    <key>NSHumanReadableCopyright</key><string>© 2026 Combyne AI. MIT License.</string>
</dict>
</plist>
PLIST

echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"
ok "Info.plist written (v${VERSION})"

# ── Step 7: Strip quarantine attributes ──────────────────────────────────
xattr -cr "$APP_BUNDLE" 2>/dev/null || true

# ── Step 8: Create Applications symlink ──────────────────────────────────
ln -s /Applications "$STAGING/dmg-contents/Applications"

# ── Step 9: DMG background ──────────────────────────────────────────────
mkdir -p "$STAGING/dmg-contents/.background"
if [ -f "$SCRIPT_DIR/assets/dmg-background.png" ]; then
    cp "$SCRIPT_DIR/assets/dmg-background.png" "$STAGING/dmg-contents/.background/background.png"
elif command -v python3 &>/dev/null; then
    python3 "$SCRIPT_DIR/dmg-background.py" "$STAGING/bg" 2>&1 | tail -1
    cp "$STAGING/bg/dmg-background.png" "$STAGING/dmg-contents/.background/background.png"
fi

# ── Step 10: Build the DMG ───────────────────────────────────────────────
info "Creating DMG image..."

rm -f "$DMG_OUTPUT"
rm -f "$STAGING/temp.dmg"

# Calculate required size (app size + 50MB buffer for larger standalone bundle)
APP_SIZE_KB=$(du -sk "$STAGING/dmg-contents" | cut -f1)
DMG_SIZE_MB=$(( (APP_SIZE_KB / 1024) + 50 ))

hdiutil create \
    -srcfolder "$STAGING/dmg-contents" \
    -volname "$VOLUME_NAME" \
    -fs HFS+ \
    -fsargs "-c c=64,a=16,e=16" \
    -format UDRW \
    -size "${DMG_SIZE_MB}m" \
    "$STAGING/temp.dmg" 2>&1 | tail -1

ok "Read-write DMG created"

# ── Step 11: Customize DMG appearance ────────────────────────────────────
info "Customizing DMG appearance..."

MOUNT_DIR=$(hdiutil attach "$STAGING/temp.dmg" -readwrite -noverify -noautoopen 2>/dev/null | grep "/Volumes/" | tail -1 | sed 's/.*\/Volumes/\/Volumes/')

if [ -n "$MOUNT_DIR" ]; then
    osascript <<APPLESCRIPT 2>/dev/null || true
tell application "Finder"
    tell disk "$VOLUME_NAME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set bounds of container window to {200, 200, 800, 620}
        set theViewOptions to icon view options of container window
        set arrangement of theViewOptions to not arranged
        set icon size of theViewOptions to 100
        set background picture of theViewOptions to file ".background:background.png"
        set position of item "Combyne AI.app" of container window to {150, 200}
        set position of item "Applications" of container window to {450, 200}
        close
        open
        update without registering applications
        delay 1
        close
    end tell
end tell
APPLESCRIPT

    # Set volume icon
    if [ -f "$APP_BUNDLE/Contents/Resources/AppIcon.icns" ]; then
        cp "$APP_BUNDLE/Contents/Resources/AppIcon.icns" "$MOUNT_DIR/.VolumeIcon.icns"
        SetFile -c icnC "$MOUNT_DIR/.VolumeIcon.icns" 2>/dev/null || true
        SetFile -a C "$MOUNT_DIR" 2>/dev/null || true
    fi

    sync
    sleep 2
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || hdiutil detach "$MOUNT_DIR" 2>/dev/null || true
    sleep 1
    ok "DMG appearance customized"
else
    echo -e "\033[1;33mWarning: Could not mount DMG for customization. Skipping appearance setup.${R}"
fi

# ── Step 12: Compress final DMG ──────────────────────────────────────────
info "Compressing final DMG..."
hdiutil convert "$STAGING/temp.dmg" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -o "$DMG_OUTPUT" 2>&1 | tail -1
ok "DMG compressed"

# ── Step 13: Verify ──────────────────────────────────────────────────────
info "Verifying DMG..."
hdiutil verify "$DMG_OUTPUT" 2>&1 | tail -1
ok "DMG verified"

# ── Summary ──────────────────────────────────────────────────────────────
DMG_SIZE=$(du -h "$DMG_OUTPUT" | cut -f1 | xargs)
DMG_FULL_PATH=$(cd "$(dirname "$DMG_OUTPUT")" && pwd)/$(basename "$DMG_OUTPUT")
APP_UNCOMPRESSED=$(du -sh "$APP_BUNDLE" | cut -f1 | xargs)

echo ""
echo -e "${Y}═══════════════════════════════════════════════════════════════${R}"
echo -e "${G}  Standalone DMG built successfully!${R}"
echo -e "${Y}═══════════════════════════════════════════════════════════════${R}"
echo ""
echo -e "  ${D}File:${R}        ${DMG_FULL_PATH}"
echo -e "  ${D}DMG Size:${R}    ${DMG_SIZE}"
echo -e "  ${D}App Size:${R}    ${APP_UNCOMPRESSED} (uncompressed)"
echo -e "  ${D}Version:${R}     ${VERSION}"
echo -e "  ${D}Arch:${R}        arm64 (Apple Silicon)"
echo -e "  ${D}Node.js:${R}     v${NODE_VERSION}"
echo -e "  ${D}Standalone:${R}  Yes (no prerequisites needed on target machine)"
echo ""
echo -e "  ${D}To install: Open the DMG and drag Combyne AI to Applications${R}"
echo ""
