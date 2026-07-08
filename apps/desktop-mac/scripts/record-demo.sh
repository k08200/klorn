#!/usr/bin/env bash
#
# Record a short screen clip of the Klorn top bar for a demo.
#
# WHY a separate script: the repo's main demo pipeline (scripts/demo-video/) drives
# the WEB app with Playwright and CANNOT see a native macOS window. This records the
# real desktop app via macOS screen capture instead.
#
# Requirements (one-time, on YOUR Mac — an agent/CI cannot grant these):
#   - Screen Recording permission for your Terminal
#     (System Settings › Privacy & Security › Screen Recording). Without it the
#     capture is a black frame.
#   - Automation/Accessibility permission for Terminal so the scripted ⌥⌘K works
#     (System Settings › Privacy & Security › Accessibility).
#   - ffmpeg with avfoundation:  brew install ffmpeg
#   - Be signed in to Klorn in the app already, so real data shows in the panel.
#
# Usage:
#   apps/desktop-mac/scripts/record-demo.sh [DURATION_SECONDS]
#
#   # find your screen's avfoundation index first (usually 1), then override if needed:
#   ffmpeg -f avfoundation -list_devices true -i ""
#   SCREEN_INDEX=2 apps/desktop-mac/scripts/record-demo.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

DURATION="${1:-14}"
SCREEN_INDEX="${SCREEN_INDEX:-1}"
API="${KLORN_API_URL:-https://klorn-api.onrender.com}"
OUT_DIR="out"
OUT="$OUT_DIR/klorn-desktop-demo.mp4"
mkdir -p "$OUT_DIR"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg"; exit 1; }

# 1. Build + launch (accessory app: it lives in the top bar, no window to focus).
echo "› building…"
swift build -c release >/dev/null
echo "› launching (API=$API)…"
KLORN_API_URL="$API" .build/release/KlornMac >/tmp/klorn-demo.log 2>&1 &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT
sleep 3   # let the bar draw + the firewall load

# 2. Start the screen recording (fixed duration) in the background.
echo "› recording ${DURATION}s → apps/desktop-mac/$OUT"
ffmpeg -y -f avfoundation -capture_cursor 1 -framerate 30 -i "${SCREEN_INDEX}:none" \
  -t "$DURATION" -pix_fmt yuv420p "$OUT" >/tmp/klorn-demo-ffmpeg.log 2>&1 &
REC_PID=$!

# 3. Drive the bar while it records: expand → hold → collapse → hold.
sleep 1
osascript -e 'tell application "System Events" to keystroke "k" using {command down, option down}'  # expand
sleep 6
osascript -e 'tell application "System Events" to keystroke "k" using {command down, option down}'  # collapse
sleep 2

wait "$REC_PID"
echo "✓ done → apps/desktop-mac/$OUT"
echo "  next: crop to the top bar, then reuse scripts/demo-video/{make-assets.py,build-finals.py}"
echo "  for captions/encode, and publish per scripts/demo-video/README.md."
