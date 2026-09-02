"""The queue's caps, its cache and its failure modes.

PLAN.md section 11, Phase 4's exit gate, one test per clause:

  - a job completes and its result plays through the player;
  - a second identical request is a cache hit, and no process is spawned;
  - the 6th queued job gets a 429;
  - an oversized protein gets a 400 with an honest message;
  - a timeout kills the fold and reports it.

Every one of these runs against a temporary database and a temporary cache, so the tests
never touch the state a running server owns.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from buttfold import queue as jobs  # noqa: E402


@pytest.fixture()
def queue(tmp_path):
    return jobs.JobQueue(tmp_path / "queue.db")


SUBMIT = dict(steps_per_residue=100_000, kt=1.0, kt_final=0.6, frames_total=301)


# ------------------------------------------------------------------ the caps ------------

def test_an_unknown_protein_is_refused_with_the_list(queue):
    with pytest.raises(jobs.NotAllowed) as caught:
        queue.submit("gfp", 1, "1.2.3.4", **SUBMIT)
    message = str(caught.value)
    assert "gfp" in message
    # An honest message names what IS available rather than only what is not. The gallery
    # is listed; the ESMFold catalogue is two dozen accessions, so it is named by count and
    # by the route that returns it rather than dumped into an error string.
    assert "trp_cage" in message and "ubiquitin" in message
    if any(i.startswith("uniprot:") for i in jobs.whitelisted()):
        assert "/api/uniprot" in message


def test_an_oversized_protein_is_refused_with_the_measured_reason(monkeypatch, queue):
    """The cap is 76 because ubiquitin takes 7 minutes on the droplet, measured. A refusal
    that does not say so is indistinguishable from an arbitrary limit."""
    monkeypatch.setattr(jobs, "RESIDUE_CAP", 20)
    with pytest.raises(jobs.NotAllowed) as caught:
        queue.submit("ubiquitin", 1, "1.2.3.4", **SUBMIT)
    message = str(caught.value)
    assert "76 residues" in message
    assert "20" in message
    assert "minutes" in message, "the refusal does not say why the cap exists"


def test_a_bad_seed_is_refused(queue):
    for seed in [0, -1, 2**31, "one", 1.5]:
        with pytest.raises(jobs.NotAllowed):
            queue.submit("trp_cage", seed, "1.2.3.4", **SUBMIT)


def test_one_pending_job_per_client(queue):
    queue.submit("trp_cage", 1, "1.2.3.4", **SUBMIT)
    with pytest.raises(jobs.QueueFull) as caught:
        queue.submit("ubiquitin", 1, "1.2.3.4", **SUBMIT)
    assert "one at a time" in str(caught.value).lower()


def test_the_sixth_queued_job_is_refused(queue):
    """Depth cap 5. Six different clients, because one client is capped at one job."""
    for i in range(jobs.QUEUE_DEPTH_CAP):
        queue.submit("trp_cage", i + 1, f"10.0.0.{i}", **SUBMIT)
    assert sum(queue.counts().values()) == jobs.QUEUE_DEPTH_CAP
    with pytest.raises(jobs.QueueFull) as caught:
        queue.submit("trp_cage", 99, "10.0.0.99", **SUBMIT)
    assert "full" in str(caught.value)
    # And nothing was recorded for the refused one: a cap that still writes a row is a leak.
    assert sum(queue.counts().values()) == jobs.QUEUE_DEPTH_CAP


# ------------------------------------------------------------------ the cache -----------

def test_an_identical_request_in_flight_joins_the_existing_job(queue):
    first = queue.submit("trp_cage", 1, "1.1.1.1", **SUBMIT)
    second = queue.submit("trp_cage", 1, "2.2.2.2", **SUBMIT)
    assert second["id"] == first["id"], "the same fold was queued twice"
    assert second["cached"] is False
    assert sum(queue.counts().values()) == 1


def test_a_finished_job_is_a_cache_hit_and_spawns_nothing(queue):
    first = queue.submit("trp_cage", 1, "1.1.1.1", **SUBMIT)
    queue.claim()
    queue.finish(first["id"], "done")

    before = sum(queue.counts().values())
    again = queue.submit("trp_cage", 1, "3.3.3.3", **SUBMIT)
    assert again["cached"] is True
    assert again["id"] == first["id"]
    assert sum(queue.counts().values()) == before, "a cache hit created a job"
    # And nothing is claimable, which is what "no process was spawned" means here.
    assert queue.claim() is None


def test_a_different_seed_is_a_different_fold(queue):
    one = queue.submit("trp_cage", 1, "1.1.1.1", **SUBMIT)
    two = queue.submit("trp_cage", 2, "2.2.2.2", **SUBMIT)
    assert one["cache_key"] != two["cache_key"]
    assert one["id"] != two["id"]


def test_the_cache_key_covers_every_parameter_the_trajectory_depends_on():
    base = dict(protein_id="trp_cage", seed=1, steps=2_000_000, kt=1.0, kt_final=0.6)
    key = jobs.cache_key(**base)
    for field, other in [("protein_id", "ubiquitin"), ("seed", 2), ("steps", 2_000_001),
                         ("kt", 1.1), ("kt_final", 0.5)]:
        assert jobs.cache_key(**(base | {field: other})) != key, (
            f"changing {field} did not change the cache key, so a cache hit would serve a "
            f"trajectory computed with different parameters")


# ------------------------------------------------------------------ the worker ----------

def test_claiming_is_first_in_first_out_and_takes_each_job_once(queue):
    ids = [queue.submit("trp_cage", i + 1, f"10.0.0.{i}", **SUBMIT)["id"] for i in range(3)]
    claimed = [queue.claim()["id"] for _ in range(3)]
    assert claimed == ids, "jobs were not claimed oldest first"
    assert queue.claim() is None, "a job was claimed twice"


def test_a_job_left_running_by_a_dead_worker_is_requeued(queue):
    job = queue.submit("trp_cage", 1, "1.1.1.1", **SUBMIT)
    queue.claim()
    assert queue.status(job["id"])["state"] == "running"
    assert queue.reset_running() == 1
    assert queue.status(job["id"])["state"] == "queued"
    assert queue.claim()["id"] == job["id"]


def test_position_counts_the_jobs_ahead(queue):
    ids = []
    for i in range(3):
        ids.append(queue.submit("trp_cage", i + 1, f"10.0.0.{i}", **SUBMIT)["id"])
        time.sleep(0.002)      # distinct creation times, which is what position orders on
    assert [queue.status(job_id)["position"] for job_id in ids] == [1, 2, 3]
    queue.claim()
    # The running job is no longer "ahead" of anybody in the queue.
    assert queue.status(ids[1])["position"] == 1


def test_a_timeout_is_recorded_as_a_timeout_and_not_as_a_failure(queue):
    job = queue.submit("trp_cage", 1, "1.1.1.1", **SUBMIT)
    queue.claim()
    queue.finish(job["id"], "timeout", "the fold passed 1282 s and was stopped")
    status = queue.status(job["id"])
    assert status["state"] == "timeout"
    assert "stopped" in status["error"]


def test_the_timeout_is_three_times_the_measured_worst_case():
    """Not a round number chosen for tidiness: 3x the measured 427.4 s for ubiquitin, which
    is the largest protein the cap admits."""
    assert jobs.TIMEOUT_SECONDS == int(3 * jobs.MEASURED_WORST_CASE_SECONDS)
    assert 1200 < jobs.TIMEOUT_SECONDS < 1400


# ------------------------------------------------------------------ end to end ----------

@pytest.mark.slow
def test_a_real_job_folds_bakes_and_plays_through_the_player(tmp_path, monkeypatch):
    """The whole path: submit, fold with the real binary, bake with the real baker, and
    load the result through the same store the gallery is served from.

    Trp-cage, because it is 5 s on this Mac. Marked slow so the fast suite stays fast.
    """
    numpy = pytest.importorskip("numpy", reason="the bake needs numpy, as the worker does")
    assert numpy is not None

    # The paths are patched on the modules rather than set in the environment and
    # re-imported. Popping `buttfold.store` from sys.modules is not enough: the `buttfold`
    # PACKAGE still holds a `store` attribute pointing at the old module, so
    # `from buttfold import store` hands back the stale one and the test silently checks a
    # cache directory nothing wrote to. In production the environment is set before the
    # process starts, so import order never arises there.
    from buttfold import paths, store, worker  # noqa: PLC0415

    cache = tmp_path / "cache"
    state = tmp_path / "state"
    monkeypatch.setattr(paths, "CACHE_DIR", cache)
    monkeypatch.setattr(paths, "WORK_DIR", state / "work")
    monkeypatch.setattr(store, "CACHE", cache)
    monkeypatch.setattr(worker, "CACHE_DIR", cache)
    monkeypatch.setattr(worker, "WORK_DIR", state / "work")
    fold_and_bake = worker.fold_and_bake

    q = jobs.JobQueue(state / "queue.db")
    job = q.submit("trp_cage", 3, "1.1.1.1", **SUBMIT)
    claimed = q.claim()
    assert claimed["id"] == job["id"]

    destination = fold_and_bake(claimed, lambda message: None)
    q.finish(job["id"], "done")
    assert destination.exists()

    baked = json.loads(destination.read_text())
    # The same assertions the gallery is held to. A queued fold that did not collapse must
    # not be servable.
    quality = baked["quality"]
    assert quality["collapseRatio"] <= 0.8
    assert quality["nativeFraction"] >= 0.9
    assert len(baked["frames"]) >= 100
    first = len(baked["frames"][0]["newContacts"])
    assert first / quality["contactsFormed"] < 0.25

    # And it loads through the ordinary fold route's store, by its cache key, with no code
    # path of its own. That is what "plays through the player" means.
    served = store.cached_fold(job["cache_key"])
    assert served is not None
    assert served["id"] == job["cache_key"]
    for key in ("points", "newContacts", "ss", "conf", "rg", "q"):
        assert key in served["frames"][0], f"a queued frame is missing {key}"
    assert served["queued"]["seed"] == 3


# ------------------------------------------------------------------ the HTTP layer ------

@pytest.fixture()
def client(tmp_path, monkeypatch):
    """The Flask app with its queue pointed at a temporary database.

    The handle is replaced rather than the app re-imported: `app` opens one queue at import
    and several gunicorn workers share it, which is the deployment this is meant to model.
    """
    import app as web

    monkeypatch.setattr(web, "_queue", jobs.JobQueue(tmp_path / "http.db"))
    web.app.config["TESTING"] = True
    with web.app.test_client() as c:
        yield c


def post(client, body, ip="9.9.9.9"):
    return client.post("/api/queue", json=body, headers={"X-Forwarded-For": ip})


def test_a_submission_is_202_with_a_job_id(client):
    response = post(client, {"protein_id": "trp_cage", "seed": 1})
    assert response.status_code == 202
    body = response.get_json()
    assert body["job_id"] and body["cached"] is False
    assert body["result_url"].startswith("/api/fold/")


def test_an_oversized_protein_is_400_and_says_why(client, monkeypatch):
    monkeypatch.setattr(jobs, "RESIDUE_CAP", 20)
    response = post(client, {"protein_id": "ubiquitin"})
    assert response.status_code == 400
    assert "76 residues" in response.get_json()["error"]


def test_the_sixth_job_is_429_with_a_retry_after(client):
    for i in range(jobs.QUEUE_DEPTH_CAP):
        assert post(client, {"protein_id": "trp_cage", "seed": i + 1},
                    ip=f"10.1.0.{i}").status_code == 202
    response = post(client, {"protein_id": "trp_cage", "seed": 99}, ip="10.1.0.99")
    assert response.status_code == 429
    # A number, not a shrug: the caller can decide whether to wait or use the gallery.
    assert int(response.headers["Retry-After"]) > 0


def test_a_scalar_json_body_is_400_and_not_a_500(client):
    """json.loads("3") is the integer 3, and `.get` on it is an AttributeError."""
    response = client.post("/api/queue", data="3", content_type="application/json")
    assert response.status_code == 400


def test_status_is_never_cached(client):
    job_id = post(client, {"protein_id": "trp_cage"}).get_json()["job_id"]
    response = client.get(f"/api/queue/{job_id}")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert body["state"] == "queued" and body["position"] == 1
    assert body["frames_total"] > 0


def test_an_unfinished_result_is_409_and_an_unknown_job_is_404(client):
    job_id = post(client, {"protein_id": "trp_cage"}).get_json()["job_id"]
    assert client.get(f"/api/queue/{job_id}/result").status_code == 409
    assert client.get("/api/queue/deadbeef/result").status_code == 404
    assert client.get("/api/queue/deadbeef").status_code == 404


def test_clients_are_told_apart_by_the_forwarded_header(client):
    """Behind nginx every remote_addr is 127.0.0.1. Without X-Forwarded-For the per-IP cap
    becomes a global cap of one, which looks like a working queue that serves one person."""
    assert post(client, {"protein_id": "trp_cage", "seed": 1}, ip="1.1.1.1").status_code == 202
    assert post(client, {"protein_id": "ubiquitin", "seed": 1}, ip="1.1.1.1").status_code == 429
    assert post(client, {"protein_id": "ubiquitin", "seed": 1}, ip="2.2.2.2").status_code == 202


def test_the_frame_route_streams_only_whole_frames(tmp_path, monkeypatch):
    """A fold being watched must never be handed half of one step and half of the next.

    The worker appends to this file while the route reads it, so the route reads the size
    once and floors to a frame boundary. A torn frame is not a corrupt download that a
    browser would notice: it is a plausible structure that never existed, drawn without
    complaint.
    """
    import app as app_module

    residues = 4
    per_frame = residues * 3 * 4
    work = tmp_path / "job"
    work.mkdir()
    # Two whole frames and a deliberately torn third.
    payload = b"\x00" * 8 + b"\x01" * (per_frame * 2) + b"\x02" * (per_frame // 2)
    (work / "frames.bin").write_bytes(payload)

    monkeypatch.setattr(app_module, "WORK_DIR", tmp_path)
    monkeypatch.setattr(app_module, "_job_stream",
                        lambda job_id: (work / "frames.bin", per_frame))
    client = app_module.app.test_client()

    whole = client.get("/api/queue/job/frames")
    assert whole.status_code == 200
    assert len(whole.data) == per_frame * 2, "the torn frame was served"
    assert whole.headers["X-Frames-Count"] == "2"
    assert whole.headers["Cache-Control"] == "no-store"

    # Resuming from a frame index returns only what is new, which is what makes the client
    # able to poll without re-reading and re-appending the whole trajectory.
    rest = client.get("/api/queue/job/frames?from=1")
    assert len(rest.data) == per_frame
    assert rest.headers["X-Frames-From"] == "1"
    # Past the end is empty, not an error: the client polls ahead of the worker constantly.
    assert client.get("/api/queue/job/frames?from=99").data == b""


def test_the_frame_route_refuses_a_job_id_that_is_not_one():
    """`job_id` reaches the route from the URL and is used to build a path.

    Nothing the queue mints could contain a traversal - they are sha256 digests - but a
    route defends against what it is sent, not against what it expects.
    """
    import app as app_module
    client = app_module.app.test_client()
    for bogus in ["..", "../../etc", "NOTHEX", "abc!", ""]:
        response = client.get(f"/api/queue/{bogus}/frames")
        assert response.status_code in (404, 308), f"{bogus!r} was not refused"


def test_the_frame_route_rejects_a_from_that_is_not_a_frame_index():
    import app as app_module
    client = app_module.app.test_client()
    # 404 first, because the job does not exist; the point is that neither ever 500s.
    for bad in ["-1", "banana", "1.5"]:
        assert client.get(f"/api/queue/{'a' * 16}/frames?from={bad}").status_code in (400, 404)


def test_the_published_frame_numbers_match_what_the_worker_will_actually_produce():
    """The browser picks its preview frames from these two numbers.

    They are constants in `app.py` because the queue route cannot import the baker's tools
    module, so the thing that keeps them honest is this: the worker's own stride arithmetic,
    run here, must produce what the route promises. A drift would not raise anything - the
    preview would simply keep the wrong frames and change pace when the result landed.
    """
    import sys
    sys.path.insert(0, str(REPO / "tools"))
    import bake_gallery as baker

    import app as app_module

    assert app_module.QUEUED_FRAME_CAP == baker.FRAME_CAP

    # The worker's arithmetic, verbatim from buttfold/worker.py, on the largest protein the
    # cap admits: the raw frame count is one more than the number of strides, because the
    # binary emits before its first step.
    for n in (20, jobs.RESIDUE_CAP):
        steps = baker.STEPS_PER_RESIDUE * n
        stride = max(steps // (baker.FRAME_CAP * 2), 1)
        assert steps // stride + 1 == app_module.QUEUED_FRAME_COUNT, (
            f"{n} residues yields {steps // stride + 1} raw frames, but the route tells the "
            f"browser {app_module.QUEUED_FRAME_COUNT}")
