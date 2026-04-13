#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Combyne AI — DMG Builder for Apple Silicon
# Builds the native .app bundle and packages it into a distributable .dmg
#
# Usage:
#   ./installers/macos/build-dmg.sh
#
# Output:
#   installers/macos/CombyneAI-<version>-arm64.dmg
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
echo -e "${D}                       .ai  DMG Builder${R}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Read version from package.json
VERSION=$(node -e "console.log(require('$REPO_ROOT/server/package.json').version)" 2>/dev/null || echo "0.2.7")
APP_NAME="Combyne AI"
DMG_NAME="CombyneAI-${VERSION}-arm64"
DMG_OUTPUT="$SCRIPT_DIR/${DMG_NAME}.dmg"
VOLUME_NAME="Combyne AI ${VERSION}"

STAGING="/tmp/combyne-dmg-$$"
APP_BUNDLE="$STAGING/dmg-contents/${APP_NAME}.app"

cleanup() {
    # Detach any mounted volume
    if [ -d "/Volumes/${VOLUME_NAME}" ]; then
        hdiutil detach "/Volumes/${VOLUME_NAME}" -quiet 2>/dev/null || true
    fi
    rm -rf "$STAGING"
}
trap cleanup EXIT

rm -rf "$STAGING"
mkdir -p "$STAGING/dmg-contents" "$STAGING/icon" "$STAGING/bg"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

info() { echo -e "${Y}▸${R} $1"; }
ok()   { echo -e "${G}✓${R} $1"; }
fail() { echo -e "\033[1;31m✗${R} $1"; exit 1; }

# ── Check architecture ──────────────────────────────────────────────────────
ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
    echo -e "\033[1;31mWarning: This builds an Apple Silicon (arm64) app.${R}"
    echo -e "\033[1;31mCurrent architecture: $ARCH. The resulting binary may not run here.${R}"
    echo ""
fi

# ── Prerequisites ────────────────────────────────────────────────────────────
info "Checking prerequisites..."
command -v node &>/dev/null || fail "Node.js 20+ required. Install: brew install node"
command -v swiftc &>/dev/null || fail "Xcode CLI tools required. Run: xcode-select --install"
command -v python3 &>/dev/null || fail "Python 3 required"
command -v hdiutil &>/dev/null || fail "hdiutil not found (macOS required)"
ok "Node $(node -v), Swift available, hdiutil available"

# ── Build project ────────────────────────────────────────────────────────────
info "Building project..."
cd "$REPO_ROOT"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
ok "Project built"

# ── Bundle server ────────────────────────────────────────────────────────────
info "Bundling server with esbuild..."
cd "$REPO_ROOT/server"
node esbuild.server.mjs 2>&1 | tail -1

# Install server bundle runtime dependencies
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

# ── Generate app icon ────────────────────────────────────────────────────────
info "Generating app icon..."
python3 "$SCRIPT_DIR/generate-icon.py" "$STAGING/icon" 2>&1 | tail -1
cp "$STAGING/icon/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/"
ok "Icon generated"

# ── Compile Swift app (arm64 optimized) ──────────────────────────────────────
info "Compiling native Swift app (arm64)..."
swiftc -O -target arm64-apple-macos13 \
    -o "$APP_BUNDLE/Contents/MacOS/CombyneAI" \
    -framework Cocoa -framework WebKit \
    "$SCRIPT_DIR/swift-app/CombyneAI.swift" 2>&1 | grep -v warning || true
chmod +x "$APP_BUNDLE/Contents/MacOS/CombyneAI"
ok "Swift app compiled ($(du -h "$APP_BUNDLE/Contents/MacOS/CombyneAI" | cut -f1 | xargs))"

# ── Info.plist ───────────────────────────────────────────────────────────────
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
ok "Info.plist written (v${VERSION})"

# ── Set app icon on the .app bundle itself ───────────────────────────────────
# This makes the icon show in Finder before the app is ever launched
if [ -f "$STAGING/icon/AppIcon_1024.png" ]; then
    sips -i "$STAGING/icon/AppIcon_1024.png" &>/dev/null || true
fi

# ── Create PkgInfo ───────────────────────────────────────────────────────────
echo -n "APPL????" > "$APP_BUNDLE/Contents/PkgInfo"

# ── Generate DMG background ─────────────────────────────────────────────────
info "Generating DMG background..."
python3 "$SCRIPT_DIR/dmg-background.py" "$STAGING/bg" 2>&1 | tail -1
ok "DMG background ready"

# ── Create Applications symlink ──────────────────────────────────────────────
ln -s /Applications "$STAGING/dmg-contents/Applications"

# ── Copy background into hidden folder ───────────────────────────────────────
mkdir -p "$STAGING/dmg-contents/.background"
cp "$STAGING/bg/dmg-background.png" "$STAGING/dmg-contents/.background/background.png"

# ── Build the DMG ────────────────────────────────────────────────────────────
info "Creating DMG image..."

# Remove old DMG if exists
rm -f "$DMG_OUTPUT"
rm -f "$STAGING/temp.dmg"

# Calculate required size (app size + 20MB buffer)
APP_SIZE_KB=$(du -sk "$STAGING/dmg-contents" | cut -f1)
DMG_SIZE_MB=$(( (APP_SIZE_KB / 1024) + 20 ))

# Create a temporary read-write DMG
hdiutil create \
    -srcfolder "$STAGING/dmg-contents" \
    -volname "$VOLUME_NAME" \
    -fs HFS+ \
    -fsargs "-c c=64,a=16,e=16" \
    -format UDRW \
    -size "${DMG_SIZE_MB}m" \
    "$STAGING/temp.dmg" 2>&1 | tail -1

ok "Read-write DMG created"

# ── Customize DMG window appearance ──────────────────────────────────────────
info "Customizing DMG appearance..."

# Mount the DMG
MOUNT_DIR=$(hdiutil attach "$STAGING/temp.dmg" -readwrite -noverify -noautoopen 2>/dev/null | grep "/Volumes/" | tail -1 | sed 's/.*\/Volumes/\/Volumes/')

if [ -z "$MOUNT_DIR" ]; then
    fail "Failed to mount DMG for customization"
fi

# Use AppleScript to set the DMG window appearance
osascript <<APPLESCRIPT
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
        -- Position the app icon on the left, Applications on the right
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

# Give Finder time to write .DS_Store
sync
sleep 2

# Set the volume icon
if [ -f "$STAGING/icon/AppIcon.icns" ]; then
    cp "$STAGING/icon/AppIcon.icns" "$MOUNT_DIR/.VolumeIcon.icns"
    SetFile -c icnC "$MOUNT_DIR/.VolumeIcon.icns" 2>/dev/null || true
    SetFile -a C "$MOUNT_DIR" 2>/dev/null || true
fi

# Unmount
hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || hdiutil detach "$MOUNT_DIR" 2>/dev/null || true
sleep 1

ok "DMG appearance customized"

# ── Compress into final DMG ──────────────────────────────────────────────────
info "Compressing final DMG..."
hdiutil convert "$STAGING/temp.dmg" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -o "$DMG_OUTPUT" 2>&1 | tail -1

ok "DMG compressed"

# ── Verify ───────────────────────────────────────────────────────────────────
info "Verifying DMG..."
hdiutil verify "$DMG_OUTPUT" 2>&1 | tail -1
ok "DMG verified"

# ── Summary ──────────────────────────────────────────────────────────────────
DMG_SIZE=$(du -h "$DMG_OUTPUT" | cut -f1 | xargs)
DMG_FULL_PATH=$(cd "$(dirname "$DMG_OUTPUT")" && pwd)/$(basename "$DMG_OUTPUT")

echo ""
echo -e "${Y}═══════════════════════════════════════════════════════════════${R}"
echo -e "${G}  DMG built successfully!${R}"
echo -e "${Y}═══════════════════════════════════════════════════════════════${R}"
echo ""
echo -e "  ${D}File:${R}    ${DMG_FULL_PATH}"
echo -e "  ${D}Size:${R}    ${DMG_SIZE}"
echo -e "  ${D}Version:${R} ${VERSION}"
echo -e "  ${D}Arch:${R}    arm64 (Apple Silicon)"
echo ""
echo -e "  ${D}To install: Open the DMG and drag Combyne AI to Applications${R}"
echo ""
