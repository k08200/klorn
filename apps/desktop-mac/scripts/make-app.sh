#!/usr/bin/env bash
# Package the SwiftPM build into a real Klorn.app bundle.
#
# A bundle is required for two things the unbundled `swift run` can't do:
#   • OS notifications (UNUserNotificationCenter needs a bundle identifier)
#   • a double-clickable app with a Dock icon
#
# The prod API URL is baked into Info.plist (KlornAPIURL) so the app points at
# prod on a plain double-click; a KLORN_API_URL env var still overrides it.
#
# Usage:  scripts/make-app.sh [debug|release] [api-url]
set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/desktop-mac

CONFIG="${1:-release}"
API_URL="${2:-https://klorn-api.onrender.com}"
APP="Klorn.app"

echo "▸ Building KlornMac ($CONFIG)…"
swift build -c "$CONFIG"
BIN=".build/$CONFIG/KlornMac"
[ -f "$BIN" ] || { echo "✗ build did not produce $BIN"; exit 1; }

echo "▸ Assembling $APP (API: $API_URL)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/KlornMac"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Klorn</string>
  <key>CFBundleDisplayName</key><string>Klorn</string>
  <key>CFBundleIdentifier</key><string>ai.klorn.desktop</string>
  <key>CFBundleExecutable</key><string>KlornMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>KlornAPIURL</key><string>${API_URL}</string>
</dict>
</plist>
PLIST

# Dock/Finder icon: build AppIcon.icns from the source PNG (the matte K).
ICON_SRC="Resources/AppIcon.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  echo "▸ Generating AppIcon.icns…"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET" "$APP/Contents/Resources"
  for sz in 16 32 128 256 512; do
    sips -s format png -z "$sz" "$sz" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1
    sips -s format png -z "$((sz * 2))" "$((sz * 2))" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
else
  echo "▸ Resources/AppIcon.png missing — bundle ships without an icon"
fi

# Ad-hoc sign so macOS will surface the notification-permission prompt.
if codesign --force --deep --sign - "$APP" >/dev/null 2>&1; then
  echo "▸ ad-hoc signed"
else
  echo "▸ codesign unavailable — notifications may not prompt"
fi

echo "✓ Built $(pwd)/$APP"
echo "  Run it:  open $APP   (or double-click in Finder)"
