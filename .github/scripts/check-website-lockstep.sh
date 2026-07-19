#!/usr/bin/env bash
# The EN (website/index.html) and KO (website/ko/index.html) landings are full
# parallel copies with no shared template — every structural edit must land in
# both files. This compares the structure-bearing skeleton of each page (element
# ids, /media/ video sources and posters, CSS class definitions) and fails on
# drift. Copy (translated text) is free to differ; structure is not.
set -euo pipefail

EN=website/index.html
KO=website/ko/index.html

skeleton() {
  {
    grep -o 'id="[^"]*"' "$1" || true
    grep -o 'src="/media/[^"]*"' "$1" || true
    grep -o 'poster="/media/[^"]*"' "$1" || true
    grep -oE '^[[:space:]]*\.[a-z][a-zA-Z0-9., :()-]*\{' "$1" | sed 's/[[:space:]]//g' || true
  } | sort
}

if ! diff <(skeleton "$EN") <(skeleton "$KO") > /tmp/lockstep.diff; then
  echo "::error::website EN/KO structural drift — edit both landings in lockstep (< only in EN, > only in KO):"
  cat /tmp/lockstep.diff
  exit 1
fi

echo "EN/KO structural skeleton matches ($(skeleton "$EN" | wc -l | tr -d ' ') anchors)."
