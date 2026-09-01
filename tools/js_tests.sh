#!/usr/bin/env bash
# Run the JavaScript suites under a node that can actually run them.
#
# Two different requirements, and PATH satisfies neither reliably on this Mac:
#
#  * The unit suites need a node that honours `static/js/package.json`, which is any node
#    from 14 on.
#  * The browser gates drive headless Chrome over the DevTools protocol and use a GLOBAL
#    `WebSocket`, which arrived in node 22. Under an older node they fail with a bare
#    `ReferenceError: WebSocket is not defined` that reads like a broken test.
#
# The only node on this machine's PATH is the one inside CCP4, which is v16, so the gates
# silently could not run at all. This picks the newest usable node rather than trusting
# whatever a shell profile put first, and says which one it chose.
set -euo pipefail
cd "$(dirname "$0")/.."

pick_node() {
  local want=$1 best="" best_major=0 candidate major
  for candidate in $(command -v -a node 2>/dev/null || true) \
      "$HOME/Library/Application Support/Perplexity/runtimes/node/bin/node" \
      /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$candidate" ] || continue
    major=$("$candidate" --version 2>/dev/null | sed 's/^v//;s/\..*//') || continue
    [ -n "$major" ] || continue
    if [ "$major" -ge "$want" ] && [ "$major" -gt "$best_major" ]; then
      best=$candidate; best_major=$major
    fi
  done
  printf '%s' "$best"
}

UNIT_NODE=$(pick_node 14)
GATE_NODE=$(pick_node 22)
[ -n "$UNIT_NODE" ] || { echo "no node at all: install one (brew install node)"; exit 1; }
echo "unit suites   $UNIT_NODE ($("$UNIT_NODE" --version))"
echo "browser gates ${GATE_NODE:-none found}" \
     "${GATE_NODE:+($("${GATE_NODE:-echo}" --version))}"
echo

failed=0
for suite in tests/*.test.mjs; do
  if "$UNIT_NODE" --test "$suite" >/tmp/buttfold-js-$$.log 2>&1; then
    printf 'PASS  %s\n' "$(basename "$suite")"
  else
    printf 'FAIL  %s\n' "$(basename "$suite")"; tail -30 /tmp/buttfold-js-$$.log; failed=1
  fi
done
rm -f /tmp/buttfold-js-$$.log

if [ -z "$GATE_NODE" ]; then
  echo
  echo "SKIPPED the browser gates: they need node 22 for a global WebSocket."
  echo "  brew install node, then re-run."
  exit $failed
fi

# The gates want a URL, so they are not run from here by default: they are run against a
# server, local or live, by whoever knows which one they mean.
echo
echo "browser gates: $GATE_NODE tests/<gate>.mjs <url>"
exit $failed
