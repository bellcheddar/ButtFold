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
import re
from pathlib import Path

from flask import Flask, jsonify, make_response, render_template, request, send_from_directory

from buttfold import store
from buttfold import uniprot
from buttfold import queue as jobs
from buttfold.paths import PREDICTION_CACHE, QUEUE_DB, WORK_DIR

REPO = Path(__file__).resolve().parent
VERSION = "0.1.0"

app = Flask(__name__, static_folder=str(REPO / "static"), template_folder=str(REPO / "templates"))


# One version for the whole front end, in the URL PATH rather than in a query string.
#
# Versioning only the entry point does not work for ES modules, and shipping that was a real
# bug: `import './stage.js'` resolves against the importing module's own URL, so
# `player.js?v=...` leaves every module it imports on a bare URL. Those were served
# `immutable, max-age=31536000`, so a browser that already had them would not re-fetch them
# for a year and would not even ask - a new player calling into a year-old renderer.
#
# A version segment in the path fixes it with no build step, because relative imports inherit
# it: from `/static/v-abc/js/player.js`, `./stage.js` is `/static/v-abc/js/stage.js` and
# `../wasm/go_model.mjs` is `/static/v-abc/wasm/go_model.mjs`. Every URL moves together, so
# `immutable` is true rather than merely claimed.
_BUILD = None


def build_version() -> str:
    global _BUILD
    if _BUILD is None or app.debug:
        _BUILD = store.build_version(REPO)
    return _BUILD


@app.route("/static/v-<version>/<path:asset>")
def versioned_static(version: str, asset: str):
    """The same files as `/static/`, at a URL that changes when any of them do.

    The version is not checked against the current build: an older one must keep working,
    because a page already open in a tab will go on asking for the URLs it was served with.
    """
    response = send_from_directory(app.static_folder, asset)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


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
        build=build_version(),
        gallery=store.index(),
        residueCap=LIVE_RESIDUE_CAP,
        links=json.loads((REPO / "static" / "links.json").read_text()),
    )


@app.route("/api/gallery")
def api_gallery():
    """Cards, without the frames. See store.index for why that matters."""
    return jsonify({"version": VERSION, "folds": store.index()})


def _revalidating(payload: dict, tag: str):
    """A JSON response the browser may keep but must revalidate, with an ETag so that
    revalidating usually costs a 304 and no body.

    **Not `immutable`, which is what this used to send at a URL carrying no version.** A
    fold is a file that changes whenever the gallery is rebaked, so claiming it never will
    is simply false, and a browser takes that claim at its word for a year.

    It is also what makes the launcher's hit counter work. mdeller.com counts a visit by
    watching for a request only a rendering browser makes, and this route is ButtFold's:
    the page fetches a fold after its module graph has run, where a scanner fetches the HTML
    and stops. A response the browser serves from its own cache never reaches the server, so
    an immutable beacon counts a visitor once and never again.
    """
    if request.if_none_match and tag in request.if_none_match:
        response = make_response("", 304)
    else:
        response = jsonify(payload)
    response.set_etag(tag)
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


@app.route("/api/fold/<fold_id>")
def api_fold(fold_id: str):
    entry = store.fold(fold_id)
    if entry is None:
        return jsonify({"error": f"no fold with id {fold_id!r}"}), 404
    return _revalidating(entry, f"{build_version()}-{fold_id}")


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


@app.route("/api/uniprot")
def api_uniprot():
    """The catalogue the ESMFold engine offers.

    Committed and screened rather than a live UniProt query: a pulldown backed by a network
    call is a pulldown that is sometimes empty, and every entry here was predicted once and
    kept only if it came back as a confident, compact domain. `tools/build_uniprot_catalogue.py`
    has the numbers and the reason a name-based filter was not enough.
    """
    entries = [
        {"id": queue_id, "accession": e["accession"], "name": e["name"],
         "organism": e["organism"], "residueCount": e["residueCount"],
         "meanPlddt": e["meanPlddt"], "pdbs": e.get("pdbs", [])}
        for queue_id, e in sorted(uniprot.catalogue().items(),
                                  key=lambda kv: (kv[1]["residueCount"], kv[1]["name"]))
    ]
    return _revalidating({"entries": entries, "residueCap": LIVE_RESIDUE_CAP},
                         f"{build_version()}-uniprot")


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
# ...and how many of them survive into the artefact. The binary is run at twice the cap and
# the baker keeps an evenly spaced half. A browser watching a fold as it happens sees the
# RAW stream, so it needs both numbers to pick the same frames the artefact will keep; told
# only the total it would show 301 frames and then be replaced by 150. Pinned against the
# baker's own constants by tests/test_queue.py rather than kept in step by hand.
QUEUED_FRAME_CAP = 150


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


# The stream the C binary writes: two little-endian int32 (n, frames) then float32 xyz
# triples. Bytes map to frames exactly, which is what makes both the progress figure and the
# frame route below readings of the file itself rather than of anything the worker says.
FRAME_HEADER_BYTES = 8


def _job_stream(job_id: str) -> tuple[Path, int] | None:
    """The growing frame file for a job, and its bytes per frame.

    `job_id` reaches this from the URL, so it is checked against the shape the queue
    actually mints - a sha256 hex digest - rather than pasted into a path. Nothing in the
    queue would produce a `..`, but nothing in the queue is what a route is defending
    against.
    """
    if not re.fullmatch(r"[0-9a-f]{8,64}", job_id):
        return None
    status = _queue.status(job_id)
    if status is None:
        return None
    path = WORK_DIR / job_id / "frames.bin"
    # From the queue's own whitelist, which knows both sources. This used to read
    # `data/natives/<protein_id>.json` directly, which is only where a GALLERY protein lives:
    # an ESMFold job looked for `data/natives/uniprot:P0A9X9.json`, got an OSError, and the
    # route 404ed while the progress figure read a flat zero for the whole fold. One place
    # knows how many residues a job has, and it is the place that accepted the job.
    entry = jobs.whitelisted().get(status["protein_id"])
    if entry is None:
        return None
    per_frame = entry["residueCount"] * 3 * 4
    return (path, per_frame) if per_frame else None


@app.route("/api/queue/<job_id>/native")
def api_queue_native(job_id: str):
    """The native state a running job is folding toward.

    For a gallery protein this is a committed file and `/api/native/<id>` serves it. For an
    ESMFold job it is a prediction that lives at Meta and then in this server's cache, so
    the browser has to ask the job for it - and it needs it for the same reason it needs the
    committed one: to score contacts against while it watches the fold stream in.

    The prediction is only read here, never made. The worker makes it, once, and this fails
    honestly if the job has not got that far rather than firing a request at a free endpoint
    on a page load.
    """
    status = _queue.status(job_id)
    if status is None:
        return jsonify({"error": f"no job {job_id!r}"}), 404
    protein_id = status["protein_id"]
    if not uniprot.is_uniprot(protein_id):
        return jsonify({"error": "this job folds a committed protein; use /api/native"}), 404

    accession = uniprot.accession_of(protein_id)
    entry = uniprot.catalogue().get(protein_id)
    cached = PREDICTION_CACHE / f"{accession}.json"
    if entry is None or not cached.exists():
        response = jsonify({"error": "the prediction is not ready yet", "state": status["state"]})
        response.status_code = 409
        response.headers["Cache-Control"] = "no-store"
        return response

    prediction = json.loads(cached.read_text())
    payload = {
        "id": protein_id,
        "name": entry["name"],
        "organism": entry["organism"],
        "sequence": entry["sequence"],
        "residueCount": entry["residueCount"],
        "ca": prediction["ca"],
        "plddt": prediction["plddt"],
        "params": FOLD_PARAMS,
        "predictor": "ESMFold v1 at the ESM Metagenomic Atlas",
    }
    response = jsonify(payload)
    # Deterministic for a sequence, so it may be cached hard - but keyed on the job, which
    # is not, so it revalidates.
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.route("/api/queue/<job_id>/frames")
def api_queue_frames(job_id: str):
    """The coordinates written SO FAR, raw, so a queued fold can be watched as it happens.

    Without this the server path was a percentage over a still picture: the droplet folded
    for half a minute and the visitor saw a number climb, while the same protein folding in
    the browser turned and collapsed in front of them. Two engines, and only one of them
    looked like anything. The frames are already on disk - the progress figure above is a
    reading of this same file's length - so streaming them is a matter of serving what is
    there rather than computing anything new.

    Deliberately raw Angstroms, not the finished artefact: the browser runs `frames.js`
    over them, which is the same builder the baker and the live worker use, so a frame
    watched mid-fold and the frame that arrives in the finished artefact are made the same
    way. The finished artefact still replaces the lot when the job is done, because THAT is
    the canonical result and this is a preview of it.
    """
    stream = _job_stream(job_id)
    if stream is None:
        return jsonify({"error": f"no job {job_id!r}"}), 404
    path, per_frame = stream
    try:
        start = int(request.args.get("from", 0))
    except ValueError:
        return jsonify({"error": "'from' must be a frame index"}), 400
    if start < 0:
        return jsonify({"error": "'from' must be a frame index"}), 400

    payload = b""
    available = 0
    if path.exists():
        try:
            # Read the size ONCE and never past it. The worker is appending while this
            # runs, so a read that trusted a second stat could return a torn final frame:
            # half of one step's coordinates and half of the next's, which is a structure
            # that never existed.
            size = path.stat().st_size
            available = max(0, (size - FRAME_HEADER_BYTES) // per_frame)
            if start < available:
                with path.open("rb") as handle:
                    handle.seek(FRAME_HEADER_BYTES + start * per_frame)
                    payload = handle.read((available - start) * per_frame)
                    payload = payload[: len(payload) // per_frame * per_frame]
        except OSError:
            payload = b""

    response = app.response_class(payload, mimetype="application/octet-stream")
    response.headers["X-Frames-From"] = str(start)
    response.headers["X-Frames-Count"] = str(len(payload) // per_frame)
    response.headers["X-Frames-Available"] = str(available)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/queue/<job_id>")
def api_queue_status(job_id: str):
    """Progress, read from the growing frame file's SIZE.

    Bytes map to frames exactly, so a byte count is an exact progress figure. Parsing the
    binary's stdout for progress would be a second, lossier source of the same fact.
    """
    frames_done = None
    stream = _job_stream(job_id)
    if stream is not None and stream[0].exists():
        try:
            frames_done = max(0, (stream[0].stat().st_size - FRAME_HEADER_BYTES) // stream[1])
        except OSError:
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
        "frame_cap": QUEUED_FRAME_CAP,
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
