#!/bin/sh
# Rebuild the landing captures (website/media/app-2026-10/) from the desktop
# app's demo fixtures.
#
#   scripts/landing-captures/make.sh [variant ...]
#
# Variants: light, ko-light (default: both). The marketing site is light-only
# (#1518), so there are no dark variants. Each one is a
# `KlornMac --render-previews` run with its own language and appearance, then
# make.mjs crops it into the variant's file names. A ko render uses the Korean
# fixture set (PreviewRenderNavKo.swift). Renders in Asia/Seoul so the
# fixture's own copy ("four meetings from 17:00") matches the clock the
# screenshots show. Both variants write the phone (-m-) crops, so /ko/ gets a
# Korean phone capture (mail-m-ko-light-840.webp).
#
# Env: WORK (render scratch dir, default $TMPDIR/klorn-landing-captures),
#      OUT (default website/media/app-2026-10), SHARP (path to sharp).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/klorn-landing-captures}"
OUT="${OUT:-$REPO/website/media/app-2026-10}"
SHARP="${SHARP:-$(ls -d "$REPO"/node_modules/.pnpm/sharp@*/node_modules/sharp | tail -1)}"

[ "$#" -gt 0 ] || set -- light ko-light

for variant in "$@"; do
  case "$variant" in
    light) lang=en; look=light ;;
    ko-light) lang=ko; look=light ;;
    *) echo "unknown variant: $variant (light|ko-light)" >&2; exit 2 ;;
  esac
  renders="$WORK/renders-$variant"
  rm -rf "$renders"
  mkdir -p "$renders"
  echo "== $variant (lang=$lang, appearance=$look) =="
  (cd "$REPO/apps/desktop-mac" && TZ=Asia/Seoul swift run KlornMac --render-previews "$renders" \
    -klorn.appLanguage "$lang" -klorn.appearance "$look")
  SHARP="$SHARP" node "$HERE/make.mjs" "$renders" "$OUT" "$variant"
done
