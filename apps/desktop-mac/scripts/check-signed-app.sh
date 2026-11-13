#!/usr/bin/env bash
# Check a SIGNED Klorn.app's provisioning as it will ship (desktop-release.yml).
#
#   --with-profile <checker>  the Developer ID build with Time Sensitive: the
#       profile sealed in the bundle must authorize the entitlements in the
#       signature, and list the leaf certificate it was signed with
#       (<checker> = compiled scripts/check-provision-profile.swift).
#   --without-profile         every other build: no embedded profile and no
#       Time Sensitive claim, which without a profile would stop the launch.
#
# Prints the signed entitlements (public: they are in the signature), never
# the profile. Decoded copies live in a private temp dir removed on exit.
#
# Usage: scripts/check-signed-app.sh <Klorn.app> --with-profile <checker>
#        scripts/check-signed-app.sh <Klorn.app> --without-profile
set -euo pipefail

APP="${1:?usage: check-signed-app.sh <app> --with-profile <checker> | --without-profile}"
MODE="${2:?usage: check-signed-app.sh <app> --with-profile <checker> | --without-profile}"
PROFILE="$APP/Contents/embedded.provisionprofile"
TS_KEY="com.apple.developer.usernotifications.time-sensitive"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
codesign -d --entitlements - --xml "$APP" > "$WORK/entitlements.plist" 2>/dev/null \
  || { echo "✗ $APP has no readable signature"; exit 1; }
echo "signed entitlements:"
plutil -p "$WORK/entitlements.plist" 2>/dev/null || echo "  (none)"

case "$MODE" in
  --with-profile)
    CHECK="${3:?--with-profile needs the compiled check-provision-profile}"
    [ -f "$PROFILE" ] || { echo "✗ $PROFILE is missing: the Time Sensitive claim would stop the launch"; exit 1; }
    security cms -D -i "$PROFILE" -o "$WORK/profile.plist" 2>/dev/null \
      || { echo "✗ $PROFILE is not a provisioning profile"; exit 1; }
    codesign -d --extract-certificates="$WORK/cert" "$APP" 2>/dev/null || true
    [ -s "$WORK/cert0" ] || { echo "✗ $APP carries no signing certificate (ad-hoc?)"; exit 1; }
    "$CHECK" "$WORK/profile.plist" "$WORK/entitlements.plist" "$APP/Contents/Info.plist" "$WORK/cert0"
    ;;
  --without-profile)
    [ ! -e "$PROFILE" ] || { echo "✗ $PROFILE is embedded in a build that should carry none"; exit 1; }
    if grep -qF "$TS_KEY" "$WORK/entitlements.plist"; then
      echo "✗ the signature claims $TS_KEY without a provisioning profile: the app would not launch"
      exit 1
    fi
    echo "✓ no provisioning profile and no Time Sensitive claim (banners post at the default level)"
    ;;
  *)
    echo "✗ unknown mode: $MODE"; exit 2
    ;;
esac
