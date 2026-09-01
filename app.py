#!/usr/bin/env python3
"""ButtFold: a protein folds in your browser and the trajectory becomes music.

Flask, despite the vibe-coding skill's "never Flask" line: that rule governs single-file
browser apps, and ButtFold is a droplet-hosted service with a queue, like AlphaFraud,
PANTS and FlexAppeal. Port 8007 behind nginx at buttfold.mdeller.com.

Routes are PLAN.md section 5.2. The queue routes arrive in Phase 4; everything the baked
gallery needs is here.

    python3 app.py            development, port 8007
    gunicorn -b 127.0.0.1:8007 app:app     production, via buttfold.service
"""

from __future__ import annotations

import json
from pathlib import Path

from flask import Flask, jsonify, render_template, send_from_directory

from buttfold import store

REPO = Path(__file__).resolve().parent
VERSION = "0.1.0"

app = Flask(__name__, static_folder=str(REPO / "static"), template_folder=str(REPO / "templates"))


def asset_versions() -> dict[str, str]:
    """`?v=<content hash>` for every asset the template names.

    Computed per request in development and once per process in production; either way it
    is a few small SHA-256s. The alternative, hard-coding the list at deploy time, is a
    second place for the truth to live and the place it goes stale.
    """
    wanted = {
        "css": "static/buttfold.css",
        "player": "static/js/player.js",
        "stage": "static/js/stage.js",
        "contacts": "static/js/ContactTracker.js",
        "psea": "static/js/PSEA.js",
        "gallery": "static/baked/gallery.json",
    }
    out = {}
    for key, relative in wanted.items():
        path = REPO / relative
        out[key] = store.content_hash(path) if path.exists() else "missing"
    return out


@app.after_request
def _no_heuristic_caching_on_html(response):
    """Stop browsers heuristically caching the HTML.

    Flask sends no Cache-Control on a rendered template. With no explicit header a browser
    is free to apply *heuristic* caching, and it does: it pins the page, and with it the
    `?v=<hash>` asset URLs embedded in that page. The CSS and JS are then cached hard and
    correctly at those URLs, so a deploy changes the files, changes the hashes, and the
    browser never learns because it is still reading the old HTML. The symptom is a deploy
    that appears to do nothing at all.

    Only HTML is marked no-cache; static assets keep nginx's long cache, which is safe
    precisely because their URLs are content-versioned.

    Verify with a real GET. `curl -I` sends HEAD, which has lied about this before.
    """
    if response.mimetype == "text/html":
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.route("/")
def index():
    return render_template(
        "index.html",
        version=VERSION,
        assets=asset_versions(),
        gallery=store.index(),
        links=json.loads((REPO / "static" / "links.json").read_text()),
    )


@app.route("/api/gallery")
def api_gallery():
    """Cards, without the frames. See store.index for why that matters."""
    return jsonify({"version": VERSION, "folds": store.index()})


@app.route("/api/fold/<fold_id>")
def api_fold(fold_id: str):
    entry = store.fold(fold_id)
    if entry is None:
        return jsonify({"error": f"no fold with id {fold_id!r}"}), 404
    response = jsonify(entry)
    # Immutable for a given content hash, and the template asks for it with one. A fold
    # that changes gets a new hash and therefore a new URL.
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.route("/healthz")
def healthz():
    """200 and the deployed version, for the launcher's dot and for deploy.sh.

    deploy.sh asserts the NEW version string here. A deploy that rsyncs and then fails to
    restart leaves the old process serving the old version, and the script exiting 0 is not
    evidence of anything.
    """
    return jsonify({
        "status": "ok",
        "version": VERSION,
        "folds": len(store.index()),
    })


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.ico",
                               mimetype="image/vnd.microsoft.icon")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8007, debug=True)
