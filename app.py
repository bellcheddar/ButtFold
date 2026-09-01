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

from flask import Flask, jsonify, render_template, request, send_from_directory

from buttfold import store
from buttfold import queue as jobs
from buttfold.paths import QUEUE_DB, WORK_DIR

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


# The residue cap architecture B ships with, measured in P0-1: ubiquitin folds on the
# droplet in 7 min 07 s, inside the 15 minute rule. Read from the queue module rather than
# repeated, so the page, the routes, the worker and the tests cannot drift apart.
LIVE_RESIDUE_CAP = jobs.RESIDUE_CAP

# The Gō parameters, in one place. The baker, the droplet queue and the browser must all
# fold the same protein the same way, or a live fold is not comparable to the gallery entry
# beside it.
FOLD_PARAMS = {
    "kT": 1.0, "kTFinal": 0.6, "dt": 0.005, "gamma": 1.0,
    "cutoff": 8.0, "minSep": 3, "seed": 1, "stepsPerResidue": 100_000,
}


@app.route("/api/native/<protein_id>")
def api_native(protein_id: str):
    """What the browser needs to fold this protein itself: the native state and the coil.

    Both are committed data, not computed here. The droplet does no folding on this path at
    all: architecture C is the visitor's own CPU, and this route is a static file with a
    guard on it.
    """
    candidate = (REPO / "data" / "natives" / f"{protein_id}.json").resolve()
    natives = (REPO / "data" / "natives").resolve()
    if not candidate.is_relative_to(natives) or not candidate.exists():
        return jsonify({"error": f"no native structure for {protein_id!r}"}), 404
    record = json.loads(candidate.read_text())
    payload = {
        "id": record["id"],
        "name": record["name"],
        "sequence": record["sequence"],
        "residueCount": record["residueCount"],
        "ca": record["ca"],
        "coil": record["coil"],
        "coilSeed": record["coilSeed"],
        "params": FOLD_PARAMS,
        "steps": FOLD_PARAMS["stepsPerResidue"] * record["residueCount"],
        "residueCap": LIVE_RESIDUE_CAP,
    }
    response = jsonify(payload)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# One queue handle per process. SQLite in WAL mode is the concurrency control, so several
# gunicorn workers sharing this file is fine and is the expected deployment.
_queue = jobs.JobQueue(QUEUE_DB)

# Frames the queue's fold will produce, which is what a progress bar is measured against.
QUEUED_FRAME_COUNT = 301


def client_key() -> str:
    """Who is asking, for the per-IP cap.

    `X-Forwarded-For` because nginx is in front and `remote_addr` is always 127.0.0.1
    behind it; without this every visitor shares one identity and the per-IP cap becomes a
    global cap of one, which looks like a working queue that only ever serves one person.
    The left-most entry is the client, and it is only trusted because nginx sets this
    header itself and strips any inbound one.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


@app.route("/api/queue", methods=["POST"])
def api_queue_submit():
    """Submit a fold to the droplet. 202 with a job id, or 429 when a cap is reached."""
    payload = request.get_json(silent=True)
    # json.loads("3") is the integer 3, and `.get` on it is an AttributeError that kills the
    # request with a 500 rather than a 400. Guarded rather than assumed.
    if not isinstance(payload, dict):
        return jsonify({"error": "expected a JSON object with protein_id and seed"}), 400
    protein_id = payload.get("protein_id")
    seed = payload.get("seed", 1)
    if not isinstance(protein_id, str):
        return jsonify({"error": "protein_id must be a string"}), 400
    if isinstance(seed, bool) or not isinstance(seed, int):
        return jsonify({"error": "seed must be an integer"}), 400

    try:
        job = _queue.submit(
            protein_id=protein_id, seed=seed, client=client_key(),
            steps_per_residue=FOLD_PARAMS["stepsPerResidue"],
            kt=FOLD_PARAMS["kT"], kt_final=FOLD_PARAMS["kTFinal"],
            frames_total=QUEUED_FRAME_COUNT)
    except jobs.NotAllowed as err:
        return jsonify({"error": str(err)}), 400
    except jobs.QueueFull as err:
        response = jsonify({"error": str(err)})
        response.status_code = 429
        # A number, not a shrug: the caller can decide whether to wait or use the gallery.
        response.headers["Retry-After"] = str(int(jobs.MEASURED_WORST_CASE_SECONDS))
        return response

    body = {"job_id": job["id"], "state": job["state"], "cached": job.get("cached", False),
            "result_url": f"/api/fold/{job['cache_key']}"}
    return jsonify(body), (200 if job.get("cached") else 202)


@app.route("/api/queue/<job_id>")
def api_queue_status(job_id: str):
    """Progress, read from the growing frame file's SIZE.

    The stream format is two little-endian int32 (n, frames) then float32 xyz triples, so
    bytes map to frames exactly and a byte count is an exact progress figure. Parsing the
    binary's stdout for progress would be a second, lossier source of the same fact.
    """
    frames_done = None
    work = (WORK_DIR / job_id / "frames.bin")
    if work.exists():
        try:
            size = work.stat().st_size
            record = json.loads((REPO / "data" / "natives"
                                 / f"{_queue.status(job_id)['protein_id']}.json").read_text())
            per_frame = record["residueCount"] * 3 * 4
            frames_done = max(0, (size - 8) // per_frame) if per_frame else 0
        except (OSError, KeyError, TypeError):
            frames_done = None

    status = _queue.status(job_id, frames_done=frames_done)
    if status is None:
        return jsonify({"error": f"no job {job_id!r}"}), 404
    response = jsonify({
        "job_id": status["id"],
        "state": status["state"],
        "position": status["position"],
        "frames_done": status["frames_done"],
        "frames_total": status["frames_total"],
        "protein_id": status["protein_id"],
        "seed": status["seed"],
        "error": status["error"],
        "result_url": f"/api/fold/{status['cache_key']}" if status["state"] == "done" else None,
    })
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/queue/<job_id>/result")
def api_queue_result(job_id: str):
    """The finished trajectory, in the gallery's own artefact format.

    Same shape, same player, no code path of its own: that is the whole reason a queued
    fold is baked server-side rather than streamed raw.
    """
    status = _queue.status(job_id)
    if status is None:
        return jsonify({"error": f"no job {job_id!r}"}), 404
    if status["state"] != "done":
        response = jsonify({"error": f"job {job_id} is {status['state']}",
                            "state": status["state"]})
        response.status_code = 409
        response.headers["Cache-Control"] = "no-store"
        return response
    entry = store.cached_fold(status["cache_key"])
    if entry is None:
        return jsonify({"error": "the result is no longer in the cache"}), 410
    response = jsonify(entry)
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
        "residueCap": LIVE_RESIDUE_CAP,
        "queue": _queue.counts(),
    })


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(app.static_folder, "favicon.ico",
                               mimetype="image/vnd.microsoft.icon")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8007, debug=True)
