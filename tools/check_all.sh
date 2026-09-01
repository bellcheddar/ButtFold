#!/usr/bin/env bash
# Every machine-verifiable gate ButtFold has, in one command. Run before every commit and
# at every phase boundary; deploy.sh runs it too, before it touches the droplet.
#
# Ordered cheapest first, so a broken artefact fails in a fifth of a second rather than
# after a browser has been launched.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE="${BUTTFOLD_NODE:-$HOME/emsdk/node/24.19.0_64bit/bin/node}"
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
run "python tests"      python3 -m pytest tests/ -q
if [[ -x "$NODE" ]]; then
  run "javascript tests"  "$NODE" --test tests/module_parity.test.mjs tests/geometry_parity.test.mjs
else
  printf '\n=== javascript tests ===\n  SKIPPED: no node at %s (set BUTTFOLD_NODE)\n' "$NODE"
  failed=1
fi

# The browser gate needs the app running. It is the one check that exercises the page a
# visitor actually gets, so it is not optional, but it says clearly why it could not run.
if curl -sf -o /dev/null "${BUTTFOLD_URL:-http://127.0.0.1:8007/}healthz" 2>/dev/null \
   || curl -sf -o /dev/null "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"; then
  run "stage renders"   "$NODE" tests/stage_screenshot.mjs "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
else
  printf '\n=== stage renders ===\n  SKIPPED: nothing serving at %s\n' "${BUTTFOLD_URL:-http://127.0.0.1:8007/}"
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
