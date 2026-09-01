#!/usr/bin/env python3
"""Serve the P0-2 benchmark and collect its results, from any browser on the network.

Three things needed a server rather than a `file://` page:

- The module is loaded as an ES module and fetches JSON, so `file://` is blocked by CORS.
- A headless Chrome run has to signal that it has *finished*. `--dump-dom` snapshots
  whenever it feels like it and cheerfully returned an empty result while the fold was
  still running, which looks exactly like a browser that cannot run the module at all.
  The page posting its own results removes the guess.
- Mobile Safari on Marc's iPhone is one of the four required measurements and there is no
  way to drive it headlessly. It is a phone on the same wifi opening a URL, and the result
  has to land on this disk without anyone copying JSON out of a phone by hand.

    tools/bench/serve.py                 # serves on 0.0.0.0:8099, prints the LAN URL
    tools/bench/serve.py --port 9000

Results are written to `build/p0/p02/<browser>-<timestamp>.json`, one file per run, never
overwritten: a second run of the same browser is a second measurement, not a correction.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RESULTS = REPO / "build" / "p0" / "p02"


def browser_slug(user_agent: str) -> str:
    """A short name for the filename. Order matters: every Chrome UA also says Safari."""
    ua = user_agent or ""
    if "Edg/" in ua:
        return "edge"
    if "Firefox/" in ua:
        return "firefox"
    if "Chrome/" in ua or "CriOS/" in ua:
        base = "chrome"
    elif "Safari/" in ua:
        base = "safari"
    else:
        base = "unknown"
    if "iPhone" in ua or "iPad" in ua:
        return f"mobile-{base}"
    return base


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(REPO), **kwargs)

    def end_headers(self):
        # The benchmark must never measure a cached module.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # nginx will need this too (PLAN section 9); getting it wrong here would hide the
        # problem until deploy.
        if str(path).endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)

    def do_POST(self):
        if self.path != "/p02":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("payload is not an object")
        except (json.JSONDecodeError, ValueError) as err:
            self.send_error(400, f"bad payload: {err}")
            return

        RESULTS.mkdir(parents=True, exist_ok=True)
        slug = browser_slug(payload.get("userAgent", ""))
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        name = re.sub(r"[^a-z0-9.-]", "-", f"{slug}-{stamp}.json")
        (RESULTS / name).write_text(json.dumps(payload, indent=1))

        print(f"\n  <- {slug}: {RESULTS.relative_to(REPO) / name}")
        for row in payload.get("results", []):
            if "error" in row:
                print(f"     {row.get('id')}: ERROR {row['error']}")
            else:
                print(f"     {row['id']:14s} {row['residues']:3d} res  "
                      f"{row['seconds']:8.2f} s  {row['stepsPerSecond']:>9,} steps/s  "
                      f"Q {row['q']:.3f}")
        sys.stdout.flush()

        body = json.dumps({"stored": name}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Logged, because a browser that never requested the page and a browser that
        # requested it and then failed silently look identical from here otherwise. That
        # ambiguity cost a whole Safari run.
        print(f"  -> GET {self.path}  {browser_slug(self.headers.get('User-Agent', ''))}")
        sys.stdout.flush()
        super().do_GET()

    def log_message(self, fmt, *args):
        pass  # do_GET and the POST handler above are the only logs worth having


def lan_address() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))     # no packet is sent; this just picks the interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--bind", default="0.0.0.0")
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    path = "/tools/bench/index.html"
    print(f"serving {REPO}")
    print(f"  this machine:  http://127.0.0.1:{args.port}{path}")
    print(f"  same wifi:     http://{lan_address()}:{args.port}{path}")
    print(f"  results ->     {RESULTS.relative_to(REPO)}/")
    print("ctrl-c to stop")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
