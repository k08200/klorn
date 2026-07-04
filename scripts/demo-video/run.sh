#!/bin/bash
# One-command demo/promo video regeneration.
#
#   DEMO_EMAIL=<demo account> DEMO_PW=<password> bash scripts/demo-video/run.sh
#
# Prereqs (once): `npm i playwright` anywhere on PATH-resolvable node_modules
# (or global), Playwright chromium installed, ffmpeg, python3 + Pillow.
# The demo account must be a password-login Klorn account with Google connected
# and the seed emails present (see README.md in this directory).
set -euo pipefail
cd "$(dirname "$0")"

: "${DEMO_EMAIL:?Set DEMO_EMAIL}"
: "${DEMO_PW:?Set DEMO_PW}"

mkdir -p videos
rm -f videos/*.webm videos/fail.png

echo "── recording (Playwright) ──"
node record-demo.mjs | tee scenes.txt
grep -q "SCENE end" scenes.txt || { echo "recording did not reach the end scene"; exit 1; }

echo "── assets (PIL) ──"
python3 make-assets.py

echo "── finals (ffmpeg) ──"
python3 build-finals.py

echo "outputs in scripts/demo-video/out/"
