#!/usr/bin/env bash
# Tests for check-provision-profile.swift against FABRICATED profiles (never
# the real one): the release must fail on every mismatch that would ship an
# app that cannot launch, and pass the profile it was built for.
#
# Usage: scripts/test-check-provision-profile.sh   (exit 0 = all pass)
set -euo pipefail
cd "$(dirname "$0")/.."   # → apps/desktop-mac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CHECK="$WORK/check-provision-profile"
xcrun swiftc -O scripts/check-provision-profile.swift -o "$CHECK" 2>/dev/null \
  || swiftc -O scripts/check-provision-profile.swift -o "$CHECK"

PB=/usr/libexec/PlistBuddy
ENTS=Klorn.developerid.entitlements
head -c 512 /dev/urandom > "$WORK/cert.der"
head -c 512 /dev/urandom > "$WORK/other-cert.der"

# The profile as Apple issues it for ai.klorn.desktop (decoded), fabricated.
good_profile() {
  local out="$1"
  rm -f "$out"
  $PB -c "Add :Name string 'Klorn Desktop Developer ID'" \
      -c "Add :TeamIdentifier array" -c "Add :TeamIdentifier:0 string P89M32649C" \
      -c "Add :ProvisionsAllDevices bool true" \
      -c "Add :Entitlements dict" \
      -c "Add :Entitlements:com.apple.application-identifier string P89M32649C.ai.klorn.desktop" \
      -c "Add :Entitlements:com.apple.developer.team-identifier string P89M32649C" \
      -c "Add :Entitlements:com.apple.developer.usernotifications.time-sensitive bool true" \
      -c "Add :Entitlements:keychain-access-groups array" \
      -c "Add :Entitlements:keychain-access-groups:0 string P89M32649C.*" \
      -c "Add :DeveloperCertificates array" \
      "$out" >/dev/null
  $PB -c "Import :DeveloperCertificates:0 $WORK/cert.der" "$out" >/dev/null
  plutil -insert ExpirationDate -date 2044-01-30T00:00:00Z "$out"
}
info_plist() {
  rm -f "$2"
  $PB -c "Add :CFBundleIdentifier string $1" "$2" >/dev/null
}
good_profile "$WORK/good.plist"
info_plist ai.klorn.desktop "$WORK/Info.plist"

PASS=0; FAILED=0
# expect <exit-code> <reason> <name> <args...>: the exit code, and for a
# failure the reason it must give (so a case cannot pass by failing early on
# something else).
expect() {
  local want="$1" reason="$2" name="$3"; shift 3
  local got=0
  "$CHECK" "$@" >"$WORK/out" 2>&1 || got=$?
  if [ "$got" = "$want" ] && grep -qF -- "$reason" "$WORK/out"; then
    PASS=$((PASS + 1)); echo "  ✓ $name"
  else
    FAILED=$((FAILED + 1)); echo "  ✗ $name (exit $got, want $want with \"$reason\")"; sed 's/^/      /' "$WORK/out"
  fi
}
# variant <name> <PlistBuddy command>: the good profile with one change.
variant() {
  local out="$WORK/$1.plist"
  good_profile "$out"
  $PB -c "$2" "$out" >/dev/null
  echo "$out"
}
TS=com.apple.developer.usernotifications.time-sensitive

echo "check-provision-profile:"
expect 0 "✓ profile authorizes P89M32649C.ai.klorn.desktop (team P89M32649C)" \
  "the profile built for ai.klorn.desktop authorizes the Developer ID entitlements" \
  "$WORK/good.plist" "$ENTS" "$WORK/Info.plist"
expect 0 "✓ signing certificate is listed in the profile" \
  "…and lists the certificate the app is signed with" \
  "$WORK/good.plist" "$ENTS" "$WORK/Info.plist" "$WORK/cert.der"
expect 1 "certificate the profile does not list" \
  "a certificate the profile does not list (renewed cert, old profile) fails" \
  "$WORK/good.plist" "$ENTS" "$WORK/Info.plist" "$WORK/other-cert.der"
expect 1 "com.apple.application-identifier is claimed with a value the profile does not grant" \
  "another App ID in the profile fails" \
  "$(variant appid 'Set :Entitlements:com.apple.application-identifier P89M32649C.ai.klorn.other')" "$ENTS" "$WORK/Info.plist"
expect 1 "com.apple.developer.team-identifier is claimed with a value the profile does not grant" \
  "another team in the profile's entitlements fails" \
  "$(variant teament 'Set :Entitlements:com.apple.developer.team-identifier AAAAAAAAAA')" "$ENTS" "$WORK/Info.plist"
expect 1 "TeamIdentifier does not include P89M32649C" \
  "a profile issued to another team fails" \
  "$(variant team 'Set :TeamIdentifier:0 AAAAAAAAAA')" "$ENTS" "$WORK/Info.plist"
expect 1 "$TS is claimed but not in the profile" \
  "a profile without the Time Sensitive capability fails" \
  "$(variant nots "Delete :Entitlements:$TS")" "$ENTS" "$WORK/Info.plist"
expect 1 "$TS is claimed with a value the profile does not grant" \
  "a profile that grants Time Sensitive as false fails" \
  "$(variant tsfalse "Set :Entitlements:$TS false")" "$ENTS" "$WORK/Info.plist"
expect 1 "not a Developer ID profile" \
  "a development profile (no ProvisionsAllDevices) fails" \
  "$(variant dev 'Delete :ProvisionsAllDevices')" "$ENTS" "$WORK/Info.plist"
good_profile "$WORK/expired.plist"
plutil -replace ExpirationDate -date 2024-01-01T00:00:00Z "$WORK/expired.plist"
expect 1 "the profile has expired" "an expired profile fails" \
  "$WORK/expired.plist" "$ENTS" "$WORK/Info.plist"
info_plist com.example.other "$WORK/OtherInfo.plist"
expect 1 "is not P89M32649C.com.example.other" "a bundle whose identifier is not the App ID's fails" \
  "$WORK/good.plist" "$ENTS" "$WORK/OtherInfo.plist"
expect 1 "the signature claims no com.apple.developer.team-identifier" \
  "a signature without the profile keys (Klorn.entitlements) fails" \
  "$WORK/good.plist" Klorn.entitlements "$WORK/Info.plist"
cp "$ENTS" "$WORK/nots.entitlements"
$PB -c "Delete :$TS" "$WORK/nots.entitlements" >/dev/null
expect 1 "the signature does not claim $TS" "a signature that does not claim Time Sensitive fails" \
  "$WORK/good.plist" "$WORK/nots.entitlements" "$WORK/Info.plist"
cp "$ENTS" "$WORK/extra.entitlements"
$PB -c "Add :com.apple.developer.aps-environment string production" "$WORK/extra.entitlements" >/dev/null
expect 1 "com.apple.developer.aps-environment is claimed but not in the profile" \
  "a restricted entitlement the profile does not grant fails" \
  "$WORK/good.plist" "$WORK/extra.entitlements" "$WORK/Info.plist"
printf 'not a plist' > "$WORK/garbage.plist"
expect 1 "profile is not a property-list dictionary" "an undecodable profile fails" \
  "$WORK/garbage.plist" "$ENTS" "$WORK/Info.plist"
expect 2 "usage:" "wrong arguments are a usage error" "$WORK/good.plist"

# The output names the App ID and team only: never the certificate bytes.
"$CHECK" "$WORK/good.plist" "$ENTS" "$WORK/Info.plist" "$WORK/cert.der" >"$WORK/out" 2>&1
if grep -qF "$(base64 < "$WORK/cert.der" | head -c 40)" "$WORK/out"; then
  FAILED=$((FAILED + 1)); echo "  ✗ the output never contains profile data"
else
  PASS=$((PASS + 1)); echo "  ✓ the output never contains profile data"
fi

# check-signed-app.sh on ad-hoc-signed dummy bundles (no identity needed; a
# real Developer ID signature is only available in the release job).
# expect_app <exit-code> <reason> <name> <args...>
expect_app() {
  local want="$1" reason="$2" name="$3"; shift 3
  local got=0
  scripts/check-signed-app.sh "$@" >"$WORK/out" 2>&1 || got=$?
  if [ "$got" = "$want" ] && grep -qF -- "$reason" "$WORK/out"; then
    PASS=$((PASS + 1)); echo "  ✓ $name"
  else
    FAILED=$((FAILED + 1)); echo "  ✗ $name (exit $got, want $want with \"$reason\")"; sed 's/^/      /' "$WORK/out"
  fi
}
# dummy_app <name> <entitlements> [profile-to-embed]
dummy_app() {
  local app="$WORK/$1.app"
  mkdir -p "$app/Contents/MacOS"
  cp /usr/bin/true "$app/Contents/MacOS/KlornMac"
  cp "$WORK/Info.plist" "$app/Contents/Info.plist"
  $PB -c "Add :CFBundleExecutable string KlornMac" "$app/Contents/Info.plist" >/dev/null
  [ -z "${3:-}" ] || cp "$3" "$app/Contents/embedded.provisionprofile"
  codesign --force --sign - --entitlements "$2" "$app" >/dev/null 2>&1
  echo "$app"
}
# A CMS-wrapped copy of the good profile, signed with a throwaway self-signed
# key: `security cms -D` decodes it as it does Apple's.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/self.pem" \
  -days 1 -subj "/CN=klorn-test-not-apple" >/dev/null 2>&1
openssl smime -sign -nodetach -binary -in "$WORK/good.plist" -signer "$WORK/self.pem" \
  -inkey "$WORK/key.pem" -outform DER -out "$WORK/good.provisionprofile"

security cms -D -i "$WORK/good.provisionprofile" -o "$WORK/decoded.plist" 2>/dev/null
expect 0 "✓ profile authorizes" "a CMS-wrapped profile decodes with security cms -D and passes (the embed step)" \
  "$WORK/decoded.plist" "$ENTS" "$WORK/Info.plist"

echo "check-signed-app:"
expect_app 0 "✓ no provisioning profile and no Time Sensitive claim" \
  "a build signed with Klorn.entitlements and no profile passes --without-profile" \
  "$(dummy_app plain Klorn.entitlements)" --without-profile
CLAIMS="$(dummy_app claims "$ENTS")"
expect_app 1 "without a provisioning profile: the app would not launch" \
  "a Time Sensitive claim without a profile fails --without-profile" "$CLAIMS" --without-profile
expect_app 1 "embedded.provisionprofile is missing" \
  "a Time Sensitive claim without a profile fails --with-profile" "$CLAIMS" --with-profile "$CHECK"
EMBEDDED="$(dummy_app embedded "$ENTS" "$WORK/good.provisionprofile")"
expect_app 1 "carries no signing certificate" \
  "the embedded profile decodes; an ad-hoc signature has no certificate to bind, so it fails" \
  "$EMBEDDED" --with-profile "$CHECK"
expect_app 1 "is embedded in a build that should carry none" \
  "a profile in a build meant to carry none fails --without-profile" "$EMBEDDED" --without-profile
expect_app 1 "is not a provisioning profile" "an embedded file that is not a profile fails" \
  "$(dummy_app garbage "$ENTS" "$WORK/garbage.plist")" --with-profile "$CHECK"

echo "$PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
