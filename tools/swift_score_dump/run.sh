#!/usr/bin/env bash
# Generate the Swift reference scores that tests/sonifier_parity.test.mjs checks against.
#
# Run BY HAND on the Mac, once, whenever the baked gallery or PhoneFold's Sonifier changes.
# Nothing in ButtFold's build, tests or runtime needs Swift; what they need is the committed
# output under tests/fixtures/score/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$HERE/tools/swift_score_dump"
KIT="${PHONEFOLDKIT:-/Users/dellboy/Documents/Vibe_Coding/PhoneFold/PhoneFoldKit}"
OUT="$HERE/tests/fixtures/score"

if [[ ! -d "$KIT" ]]; then
  echo "PhoneFoldKit not found at $KIT. Set PHONEFOLDKIT." >&2
  exit 1
fi

# Build products must not live under ~/Documents: iCloud puts extended attributes on
# everything there, and codesign then refuses the result with "resource fork, Finder
# information, or similar detritus not allowed". A scratch path outside Documents costs
# nothing and removes the whole class of problem.
BUILD="${BUTTFOLD_SWIFT_BUILD:-$HOME/Library/Developer/ButtFold-SwiftBuild}"
mkdir -p "$BUILD" "$OUT"

COMMIT="$(git -C "$(dirname "$KIT")" rev-parse HEAD 2>/dev/null || echo unknown)"
echo "==> PhoneFoldKit at $KIT (commit ${COMMIT:0:12})"

PHONEFOLDKIT="$KIT" PHONEFOLD_COMMIT="$COMMIT" \
  swift run --package-path "$PKG" --scratch-path "$BUILD" -c release swift-score-dump \
  "$HERE/static/baked/gallery.json" \
  "$KIT/../Apps/Shared/Resources/Styles" \
  "$OUT"
