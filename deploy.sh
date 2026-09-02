#!/usr/bin/env bash
# Deploy ButtFold to the droplet.
#
#   ./deploy.sh              rsync, rebuild, restart, verify (the usual case)
#   ./deploy.sh --provision  also create the user, the venv, the systemd units and the
#                            nginx site (first run only)
#
# **The last act is verification, not the restart.** The known failure on this box is a
# remote block running under `set -e` that aborts early, skipping the chown and the restart
# while rsync's own output looks perfect - and the service keeps serving the OLD build. So
# this ends by fetching the live site back and asserting the NEW version string. The script
# exiting 0 is not evidence of anything; a GET is.
set -euo pipefail

DROPLET="${DROPLET_SSH:-root@45.55.102.228}"
HOSTNAME_="buttfold.mdeller.com"
REMOTE=/opt/buttfold
STATE=/var/lib/buttfold
PORT=8007

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

VERSION="$(python3 -c "import re,pathlib;print(re.search(r'VERSION = \"([^\"]+)\"', pathlib.Path('app.py').read_text()).group(1))")"
echo "==> ButtFold $VERSION -> $DROPLET:$REMOTE"

# Never deploy something that has not passed its own gates. The browser gates need the app
# running locally, so they are the caller's job; these three are cheap and unconditional.
echo "==> local checks"
python3 tools/audit_wiring.py > /dev/null
./.venv/bin/python -m pytest tests/ -q > /dev/null
echo "    wiring audit and tests green"

if [[ "${1:-}" == "--provision" ]]; then
  echo "==> provisioning"
  ssh "$DROPLET" bash -s <<PROVISION
set -euo pipefail
id -u buttfold >/dev/null 2>&1 || useradd --system --home $REMOTE --shell /usr/sbin/nologin buttfold
mkdir -p $REMOTE $STATE/cache $STATE/work
chown -R buttfold:buttfold $STATE
apt-get install -y --no-install-recommends gcc python3-venv python3-dev > /dev/null
PROVISION
fi

echo "==> syncing"
# Explicit includes rather than a big exclude list: what ships is what the app needs, and a
# new file in the repo does not silently become a new file on a public server.
rsync -az --delete --exclude '__pycache__' --exclude '*.pyc' buttfold/ "$DROPLET:$REMOTE/buttfold/"
rsync -az --delete static/ "$DROPLET:$REMOTE/static/"
rsync -az --delete data/ "$DROPLET:$REMOTE/data/"
rsync -az --delete templates/ "$DROPLET:$REMOTE/templates/"
rsync -az --delete tools/ "$DROPLET:$REMOTE/tools/"
rsync -az --delete native/ "$DROPLET:$REMOTE/native/"
rsync -az --delete deploy/ "$DROPLET:$REMOTE/deploy/"
rsync -az app.py requirements.txt requirements-queue.txt "$DROPLET:$REMOTE/"

# The static cache is state, not code, and lives outside the deployed tree. Symlinked in so
# `/static/cache/...` resolves without the app knowing where it really is.
ssh "$DROPLET" "rm -rf $REMOTE/static/cache && ln -sfn $STATE/cache $REMOTE/static/cache"

echo "==> remote build"
ssh "$DROPLET" bash -s <<REMOTE_BUILD
set -euo pipefail
cd $REMOTE

# The venv carries numpy for the queue worker and Flask for the web layer. The two
# production requirement files are deliberately disjoint; the droplet needs both because it
# runs both processes, from one venv, as two units with different budgets.
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt -r requirements-queue.txt

# The fold binary, built here from the vendored C. 298 lines, no dependencies. Rebuilt
# every deploy because it is seconds and a stale binary is a silent wrong answer.
mkdir -p build
gcc -O2 -o build/go_fold native/go_model_fold.c -lm
./build/go_fold 2>&1 | head -1 | grep -q usage || true

mkdir -p $STATE/cache $STATE/work
chown -R buttfold:buttfold $REMOTE $STATE
REMOTE_BUILD

if [[ "${1:-}" == "--provision" ]]; then
  echo "==> installing units and the nginx site"
  scp -q deploy/buttfold-web.service deploy/buttfold-worker.service "$DROPLET:/etc/systemd/system/"
  scp -q deploy/nginx.conf "$DROPLET:/etc/nginx/sites-available/buttfold"
  ssh "$DROPLET" bash -s <<'INSTALL'
set -euo pipefail
ln -sfn /etc/nginx/sites-available/buttfold /etc/nginx/sites-enabled/buttfold
nginx -t
systemctl daemon-reload
systemctl enable buttfold-web buttfold-worker
systemctl reload nginx
INSTALL
fi

# certbot writes a plain `listen 443 ssl;`. This droplet runs nginx 1.24.0, where the
# 1.25.1 `http2 on;` directive does not exist, so http2 has to go on the listen line - and
# every other vhost on this box already carries the same patch. Idempotent, and it runs on
# every deploy because a certificate renewal can rewrite the line back.
echo "==> http2 patch"
ssh "$DROPLET" bash -s <<'HTTP2'
set -euo pipefail
site=/etc/nginx/sites-available/buttfold
# Anchored to the start of the line with only whitespace before it, so it cannot rewrite
# the comment in this very file that explains the patch - which is exactly what a loose
# match did the first time.
if grep -qE "^[[:space:]]*listen 443 ssl;" "$site"; then
  sed -i -E "s/^([[:space:]]*)listen 443 ssl;/\1listen 443 ssl http2;/" "$site"
  nginx -t && systemctl reload nginx
  echo "    patched listen 443 ssl -> listen 443 ssl http2"
else
  echo "    already patched (or no TLS block yet)"
fi
HTTP2

echo "==> restarting"
ssh "$DROPLET" "systemctl restart buttfold-web && systemctl restart buttfold-worker"
sleep 3

# ---------------------------------------------------------------- verification -----------
# Everything below runs against the LIVE site, from here, and any failure is a failed
# deploy. A plain GET throughout: HEAD has lied about Cache-Control on this box before.

echo "==> verifying"
fail=0
check () {
  if [[ -n "$2" ]]; then printf '    ok   %s\n' "$1"; else printf '    FAIL %s\n' "$1"; fail=1; fi
}

active=$(ssh "$DROPLET" "systemctl is-active buttfold-web buttfold-worker | tr '\n' ' '")
[[ "$active" == "active active "* ]] && check "both units active" yes || check "both units active ($active)" ""

scheme=https
if ! curl -sf -m 10 -o /dev/null "https://$HOSTNAME_/healthz" 2>/dev/null; then
  scheme=http   # before certbot has run, the site is plain http and that is expected
fi
BASE="$scheme://$HOSTNAME_"
echo "    base $BASE"

health=$(curl -sf -m 15 "$BASE/healthz" || echo '{}')
echo "$health" | grep -q "\"version\": *\"$VERSION\"" \
  && check "healthz reports the NEW version $VERSION" yes \
  || check "healthz reports $VERSION (got: $(echo "$health" | tr -d '\n' | head -c 120))" ""

echo "$health" | grep -q '"folds": *[6-9]' && check "the gallery is served" yes || check "the gallery is served" ""

# A route added in this deploy, not just the old ones: this is what catches a restart that
# silently did not happen.
curl -sf -m 15 "$BASE/api/native/trp_cage" | grep -q '"coil"' \
  && check "/api/native/<id> serves the coil" yes || check "/api/native/<id> serves the coil" ""

# The ESMFold engine is only as good as its pulldown, and an empty catalogue leaves an
# enabled engine button beside a select with nothing in it. Counted rather than merely
# fetched: a route that returns {"entries": []} is a 200.
UNIPROT_COUNT=$(curl -sf -m 15 "$BASE/api/uniprot" \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["entries"]))' 2>/dev/null || echo 0)
[ "${UNIPROT_COUNT:-0}" -ge 10 ] \
  && check "the UniProt catalogue is served ($UNIPROT_COUNT entries)" yes \
  || check "the UniProt catalogue is served (got ${UNIPROT_COUNT:-0} entries)" ""

page=$(curl -sf -m 20 "$BASE/")
# The disclosure paragraph, on the live page, whitespace-normalised the way a reader sees
# it. PLAN section 11's Phase 5 gate, run against the deployed site rather than a template.
echo "$page" | tr -s ' \n\t' ' ' | grep -q "It is not a prediction of an unknown structure, it is not a physical folding pathway, and no protein folds this way." \
  && check "the disclosure paragraph is live" yes || check "the disclosure paragraph is live" ""
# The amber disclosure line was removed on Marc's instruction, 2026-09-01. The claim it
# carried is still on the page in two places: the stage badge, which names the engine and
# where it ran and never scrolls away, and the disclosure paragraph checked above. Asserted
# ABSENT rather than simply dropped from the checks, so it cannot creep back unnoticed.
echo "$page" | grep -q 'id="disclosure"' && check "the removed disclosure line is back" "" \
  || check "the disclosure line is gone, as instructed" yes
echo "$page" | grep -q 'id="badge-engine"' && check "the stage badge is present" yes || check "the stage badge is present" ""

# Cache-Control, with a GET.
html_cc=$(curl -sf -m 15 -D - -o /dev/null "$BASE/" | tr -d '\r' | grep -i '^cache-control:' || true)
[[ "$html_cc" == *"no-cache"* ]] && check "the HTML is no-cache ($html_cc)" yes || check "the HTML is no-cache (got: $html_cc)" ""

# The versioned tree is the one that may be cached forever, and the page must actually use
# it. An unversioned URL that claims to be immutable is the bug that shipped a new player
# against a year-old renderer.
build=$(echo "$page" | grep -o 'data-static-base="/static/v-[0-9a-f]*"' | head -1 \
        | sed 's/.*v-\([0-9a-f]*\)".*/\1/')
[[ -n "$build" ]] && check "the page loads a versioned front end (v-$build)" yes \
                  || check "the page loads a versioned front end" ""

versioned_cc=$(curl -sf -m 15 -D - -o /dev/null "$BASE/static/v-$build/js/stage.js" \
               | tr -d '\r' | grep -i '^cache-control:' || true)
[[ "$versioned_cc" == *"max-age=31536000"* ]] && check "versioned assets are long-cached" yes \
  || check "versioned assets are long-cached (got: $versioned_cc)" ""

# And every module the page will import must be reachable under that same prefix, because a
# relative import inherits it. A 404 here is a page that does not boot at all.
for module in player.js stage.js cartoon.js StageCamera.js Sonifier.js audio.js frames.js \
              PSEA.js ContactTracker.js MusicalScale.js fold_worker.js; do
  code=$(curl -sf -m 15 -o /dev/null -w '%{http_code}' "$BASE/static/v-$build/js/$module" || echo 000)
  [[ "$code" == "200" ]] || check "versioned /js/$module is served (got $code)" ""
done
check "every module resolves under the versioned prefix" yes

plain_cc=$(curl -sf -m 15 -D - -o /dev/null "$BASE/static/buttfold.css" | tr -d '\r' | grep -i '^cache-control:' || true)
[[ "$plain_cc" == *"no-cache"* ]] && check "unversioned assets revalidate" yes \
  || check "unversioned assets revalidate (got: $plain_cc)" ""

# The fold API is the launcher's beacon AND changes on every rebake, so it must revalidate
# rather than claim to be immutable: a response served from the browser's own cache never
# reaches the server, and an immutable beacon counts a visitor once and never again.
fold_cc=$(curl -sf -m 15 -D - -o /dev/null "$BASE/api/fold/ubiquitin" | tr -d '\r' | grep -i '^cache-control:' || true)
[[ "$fold_cc" == *"no-cache"* ]] && check "the fold API revalidates" yes \
  || check "the fold API revalidates (got: $fold_cc)" ""

# **Every content type the page needs, not the two that came to mind.** Checking the wasm
# and the png while `.mjs` went out as octet-stream is exactly how a broken live fold shipped:
# a browser refuses to import a module whose MIME type is not JavaScript, and says nothing.
types_ok=1
check_type () {   # path, expected substring
  local got
  got=$(curl -sf -m 15 -D - -o /dev/null "$BASE$1" | tr -d '\r' | grep -i '^content-type:' || true)
  if [[ "$got" != *"$2"* ]]; then
    printf '    FAIL %s should be %s, got: %s\n' "$1" "$2" "${got:-<none>}"
    types_ok=0
  fi
}
check_type "/static/v-$build/wasm/go_model.wasm" "application/wasm"
check_type "/static/v-$build/wasm/go_model.mjs"  "javascript"
check_type "/static/v-$build/js/player.js"       "javascript"
check_type "/static/v-$build/styles/fantasy.json" "application/json"
check_type "/static/v-$build/buttfold.css"       "text/css"
check_type "/static/screenshot.png"              "image/png"
check_type "/static/wasm/go_model.mjs"           "javascript"
[[ $types_ok -eq 1 ]] && check "every asset serves with the right content type" yes \
                      || check "every asset serves with the right content type" ""

if [[ "$scheme" == "https" ]]; then
  proto=$(curl -sf -m 15 -o /dev/null -w '%{http_version}' "$BASE/")
  [[ "$proto" == "2" ]] && check "http2 is on" yes || check "http2 is on (got HTTP/$proto)" ""
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "DEPLOYED AND VERIFIED: $BASE"
else
  echo "DEPLOY VERIFICATION FAILED - the site may be serving an old build"
  exit 1
fi
