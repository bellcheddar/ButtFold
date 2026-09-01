#!/usr/bin/env bash
# Every machine-verifiable gate ButtFold has, in one command. Run before every commit and
# at every phase boundary; deploy.sh runs it too, before it touches the droplet.
#
# Ordered cheapest first, so a broken artefact fails in a fifth of a second rather than
# after a browser has been launched.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE="${BUTTFOLD_NODE:-$HOME/emsdk/node/24.19.0_64bit/bin/node}"
# ButtFold's own venv: the web layer's tests need Flask and the worker's need numpy, and
# the two production requirement files are deliberately disjoint, so no system interpreter
# has both.
PY="${BUTTFOLD_PYTHON:-./.venv/bin/python}"
[[ -x "$PY" ]] || PY=python3
failed=0
run () {
  local name="$1"; shift
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    printf '  ok\n'
  else
    printf '  FAILED: %s\n' "$name"
    failed=1
  fi
}

run "wiring audit"      python3 tools/audit_wiring.py
run "python tests"      "$PY" -m pytest tests/ -q
if [[ -x "$NODE" ]]; then
  run "javascript tests"  "$NODE" --test tests/module_parity.test.mjs \
      tests/geometry_parity.test.mjs tests/sonifier_parity.test.mjs \
      tests/live_parity.test.mjs tests/stage_camera.test.mjs
else
  printf '\n=== javascript tests ===\n  SKIPPED: no node at %s (set BUTTFOLD_NODE)\n' "$NODE"
  failed=1
fi

# The browser gate needs the app running. It is the one check that exercises the page a
# visitor actually gets, so it is not optional, but it says clearly why it could not run.
if curl -sf -o /dev/null "${BUTTFOLD_URL:-http://127.0.0.1:8007/}healthz" 2>/dev/null \
   || curl -sf -o /dev/null "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"; then
  run "stage renders"   "$NODE" tests/stage_screenshot.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  # The parity test proves the score is right and says nothing about whether it reaches an
  # AudioContext. A sonifier wired to nothing produces silence and passes every unit test.
  # The camera's model is unit-tested; this is the wiring, which is the half that was
  # broken and which no unit test could have caught.
  run "drag, zoom and reframe reach the camera" \
      "$NODE" tests/stage_drag.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  run "sound reaches the audio device" \
      "$NODE" tests/audio_smoke.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  run "a browser folds trp-cage live" \
      "$NODE" tests/live_fold.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  # Needs the queue worker as well as the app, so it is skipped rather than failed when
  # only the web process is up: a red gate for a component that was never started teaches
  # nothing.
  if pgrep -f "buttfold.worker" > /dev/null; then
    run "the droplet queue returns a fold" \
        "$NODE" tests/queue_smoke.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  else
    printf '\n=== the droplet queue returns a fold ===\n'
    printf '  SKIPPED: no worker running. Start it with:\n'
    printf '    ./.venv/bin/python -m buttfold.worker\n'
  fi
else
  printf '\n=== stage renders / sound ===\n  SKIPPED: nothing serving at %s\n' "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
  printf '  start it with: python3 app.py\n'
  failed=1
fi

printf '\n'
if [[ $failed -eq 0 ]]; then
  printf 'ALL GATES PASS\n'
else
  printf 'SOME GATES FAILED\n'
fi
exit $failed
