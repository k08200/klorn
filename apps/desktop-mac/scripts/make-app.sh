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
# Usage:  scripts/make-app.sh [debug|release] [api-url] [version]
#
# KLORN_ARCHS="arm64 x86_64" builds a universal binary. Unset (the default)
# builds for the host arch only, which keeps local iteration fast — the release
# workflow sets it so shipped builds run on Intel Macs too.
set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/desktop-mac

CONFIG="${1:-release}"
API_URL="${2:-https://klorn-api.onrender.com}"
# Bundle version: 3rd arg (the release workflow passes the tag) → latest
# desktop-v* tag → "dev". The in-app update check compares this against the
# newest release tag, so a hardcoded value would nag about updates forever
# (or never); "dev" makes the check answer "unknown" on local builds.
VERSION="${3:-$(git describe --tags --match 'desktop-v*' --abbrev=0 2>/dev/null | sed 's/^desktop-v//')}"
VERSION="${VERSION:-dev}"
APP="Klorn.app"

ARCHS="${KLORN_ARCHS:-}"
BUILD_ARGS=(-c "$CONFIG")
for arch in $ARCHS; do BUILD_ARGS+=(--arch "$arch"); done

echo "▸ Building KlornMac ($CONFIG${ARCHS:+, archs:$ARCHS})…"
swift build "${BUILD_ARGS[@]}"

if [ -n "$ARCHS" ]; then
  # Passing --arch switches SwiftPM to the Xcode-style layout: the product lands
  # in .build/apple/Products/<Config>/ with the config CAPITALISED, and the usual
  # .build/<config>/ path is never created. Reading the old path here silently
  # bundled nothing at all.
  CONFIG_DIR="$(tr '[:lower:]' '[:upper:]' <<< "${CONFIG:0:1}")${CONFIG:1}"
  BIN=".build/apple/Products/$CONFIG_DIR/KlornMac"
else
  BIN=".build/$CONFIG/KlornMac"
fi
[ -f "$BIN" ] || { echo "✗ build did not produce $BIN"; exit 1; }

# Assert every requested arch is really in there. A cross-compile that quietly
# drops a slice would ship a build that cannot launch on that hardware, and the
# only symptom is a user telling you the app does nothing.
for arch in $ARCHS; do
  lipo -archs "$BIN" | tr ' ' '\n' | grep -qx "$arch" \
    || { echo "✗ $BIN is missing the $arch slice (has: $(lipo -archs "$BIN"))"; exit 1; }
done
[ -z "$ARCHS" ] || echo "▸ universal: $(lipo -archs "$BIN")"

echo "▸ Assembling $APP (API: $API_URL)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/KlornMac"

# SwiftPM's processed resources (Package.swift: resources:[.process("Resources")])
# land in KlornMac_KlornMac.bundle NEXT TO the binary — they are not inside it.
# Bundle.module looks for that bundle in the app's Contents/Resources at runtime
# and calls fatalError when it is missing, so shipping without it is an app that
# launches and dies the moment the status menu asks L10n for a string (every
# packaged build 80024–80028 did exactly this; crash: EXC_BREAKPOINT in
# "NSBundle.module" one-time init). Refuse to build rather than ship that again.
RES_BUNDLE="$(dirname "$BIN")/KlornMac_KlornMac.bundle"
[ -d "$RES_BUNDLE" ] || { echo "✗ $RES_BUNDLE missing — Bundle.module would fatalError at runtime"; exit 1; }
mkdir -p "$APP/Contents/Resources"
cp -R "$RES_BUNDLE" "$APP/Contents/Resources/"
# The bundle's internal layout differs by build style — flat lprojs from a
# plain `swift build`, a full Contents/Resources tree from the --arch
# (Xcode-style) build. Foundation's Bundle API reads both; accept both here.
SHIPPED="$APP/Contents/Resources/KlornMac_KlornMac.bundle"
for code in en ko; do
  [ -d "$SHIPPED/$code.lproj" ] || [ -d "$SHIPPED/Contents/Resources/$code.lproj" ] \
    || { echo "✗ resource bundle is missing $code.lproj — localization would be dead"; exit 1; }
done
echo "▸ resource bundle: $(du -sh "$APP/Contents/Resources/KlornMac_KlornMac.bundle" | cut -f1) ($(ls "$APP/Contents/Resources/KlornMac_KlornMac.bundle" | tr '\n' ' '))"

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
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>KlornAPIURL</key><string>${API_URL}</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key>
  <array><string>en</string><string>ko</string><string>ja</string><string>zh</string><string>es</string><string>fr</string><string>de</string></array>
  <!-- Step C6: EventKit asks only when the user turns on "Upload device calendars".
       macOS 14+ reads the FullAccess key; the plain one serves older readers.
       Localised by Contents/Resources/<lang>.lproj/InfoPlist.strings (below). -->
  <key>NSCalendarsFullAccessUsageDescription</key><string>Klorn uploads only the calendars you turn on in Settings, so your briefing and assistant can see them.</string>
  <key>NSCalendarsUsageDescription</key><string>Klorn uploads only the calendars you turn on in Settings, so your briefing and assistant can see them.</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>ai.klorn.desktop.oauth</string>
      <key>CFBundleURLSchemes</key><array><string>klorn</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

# The calendar permission prompt's text, per language. These belong to the MAIN
# bundle (the OS reads them from Contents/Resources/<lang>.lproj), not to the
# SwiftPM resource bundle, so they live outside the target and are copied here.
for lproj in Resources/InfoPlist/*.lproj; do
  mkdir -p "$APP/Contents/Resources/$(basename "$lproj")"
  cp "$lproj/InfoPlist.strings" "$APP/Contents/Resources/$(basename "$lproj")/"
done
[ -f "$APP/Contents/Resources/ko.lproj/InfoPlist.strings" ] \
  || { echo "✗ InfoPlist.strings missing — the calendar prompt would not be localised"; exit 1; }

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
if codesign --force --deep --sign - --entitlements Klorn.entitlements "$APP" >/dev/null 2>&1; then
  echo "▸ ad-hoc signed"
else
  echo "▸ codesign unavailable — notifications may not prompt"
fi

echo "✓ Built $(pwd)/$APP"
echo "  Run it:  open $APP   (or double-click in Finder)"
