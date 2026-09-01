#!/usr/bin/env python3
"""The single fold worker for architecture B. One job at a time, at nice 19.

PLAN.md section 5.5. Run under the same systemd unit as gunicorn so the two live and die
together:

    python3 -m buttfold.worker

A separate process from Flask on purpose. The bake needs numpy; the web layer must not, and
on a 3.9 GB box shared with four other apps the difference between "the page imports numpy"
and "a worker does" is real. `requirements.txt` is the web layer's and stays two lines;
`requirements-queue.txt` is this file's.

**The fold is the C binary, never Python.** 298 lines, no dependencies, measured at
16.6 s for trp-cage and 7 min 07 s for ubiquitin on this box under `nice -n 19` while the
other apps were serving. What Python does here is start it, watch it, kill it if it runs
long, and turn its output into the same artefact the gallery ships.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tools"))

from buttfold import queue as jobs  # noqa: E402
from buttfold.paths import CACHE_DIR, QUEUE_DB, WORK_DIR  # noqa: E402


def fold_and_bake(job: dict, log) -> Path:
    """Run one job to completion and write its artefact into the cache.

    Imported lazily and inside the worker only: `bake_gallery` pulls in numpy, and the
    point of this being a separate process is that the web layer never does.
    """
    import json

    import numpy as np

    import bake_gallery as baker
    from coil import load_native, random_coil, write_xyz

    protein_id, seed = job["protein_id"], job["seed"]
    record = load_native(protein_id)
    native = np.asarray(record["ca"], dtype=np.float64)
    n = len(native)
    steps = baker.STEPS_PER_RESIDUE * n
    stride = max(steps // (baker.FRAME_CAP * 2), 1)

    work = WORK_DIR / job["id"]
    work.mkdir(parents=True, exist_ok=True)
    write_xyz(work / "native.xyz", native)
    # The committed coil, so a queued fold starts where the gallery entry beside it started
    # and the two are comparable. The C's --seed is what varies between jobs.
    write_xyz(work / "start.xyz", np.asarray(record["coil"], dtype=np.float64))
    frames_path = work / "frames.bin"

    command = [
        str(baker.ensure_binary()),
        "--native", str(work / "native.xyz"), "--start", str(work / "start.xyz"),
        "--out", str(frames_path), "--steps", str(steps), "--stride", str(stride),
        "--kT", str(baker.KT_START), "--kT-final", str(baker.KT_FINAL),
        "--dt", str(baker.DT), "--gamma", str(baker.GAMMA),
        "--cutoff", str(baker.CUTOFF), "--min-sep", str(baker.MIN_SEP),
        "--seed", str(seed),
    ]
    log(f"  folding {protein_id} n={n} steps={steps:,} seed={seed}")

    began = time.time()
    # A new process GROUP, so a timeout kills the fold and anything it started rather than
    # leaving an orphan holding a core. `nice -n 19` so it can never starve nginx or the
    # other four apps on this box: the fold is the lowest-priority thing here by design.
    process = subprocess.Popen(
        ["nice", "-n", "19", *command],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        start_new_session=True)
    try:
        _out, err = process.communicate(timeout=jobs.TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        process.wait()
        raise TimeoutError(
            f"the fold passed {jobs.TIMEOUT_SECONDS} s, which is three times the measured "
            f"worst case, and was stopped")
    wall = time.time() - began
    if process.returncode != 0:
        raise RuntimeError(f"the model exited {process.returncode}: {err.strip()[:400]}")
    log(f"  folded in {wall:.1f} s")

    # Bake through the SAME code the gallery is baked with, including its assertions. A
    # queued fold that did not collapse must fail loudly here rather than be served as an
    # animation of nothing happening.
    ca = baker.read_frames(frames_path)
    baked = baker.bake_frames(record, ca, wall)
    baked["engine"] = "go"
    baked["provenance"] = "structure-based-go"
    baked["id"] = job["cache_key"]
    baked["queued"] = {"jobId": job["id"], "proteinId": protein_id, "seed": seed,
                       "seconds": round(wall, 1)}

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    destination = CACHE_DIR / f"{job['cache_key']}.json"
    destination.write_text(json.dumps(baked, separators=(",", ":"), sort_keys=True))
    log(f"  baked {destination.name}, {destination.stat().st_size / 1024:.0f} kB, "
        f"Q {baked['quality']['nativeFraction']}, "
        f"Rg {baked['quality']['radiusOfGyrationStart']} -> "
        f"{baked['quality']['radiusOfGyrationEnd']} A")

    for leftover in work.glob("*"):
        leftover.unlink()
    work.rmdir()
    return destination


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=QUEUE_DB)
    ap.add_argument("--poll", type=float, default=2.0, help="seconds between checks")
    ap.add_argument("--once", action="store_true",
                    help="take at most one job and exit, for the tests")
    args = ap.parse_args()

    def log(message: str) -> None:
        print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)

    queue = jobs.JobQueue(args.db)
    # A job is only ever 'running' while a worker is alive. Finding one at startup means the
    # previous worker died mid-fold, and the honest thing is to fold it again rather than
    # leave it stuck forever showing progress that will never move.
    requeued = queue.reset_running()
    if requeued:
        log(f"requeued {requeued} job(s) left running by a previous worker")
    log(f"watching {args.db}, cap {jobs.RESIDUE_CAP} residues, "
        f"timeout {jobs.TIMEOUT_SECONDS} s")

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
        log("stopping after this job")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while not stopping:
        job = queue.claim()
        if job is None:
            if args.once:
                return 0
            time.sleep(args.poll)
            continue
        log(f"job {job['id']} {job['protein_id']} seed {job['seed']}")
        try:
            fold_and_bake(job, log)
            queue.finish(job["id"], "done")
            log(f"job {job['id']} done")
        except TimeoutError as err:
            queue.finish(job["id"], "timeout", str(err))
            log(f"job {job['id']} TIMEOUT: {err}")
        except Exception as err:                      # noqa: BLE001 - reported, not swallowed
            queue.finish(job["id"], "failed", f"{type(err).__name__}: {err}")
            log(f"job {job['id']} FAILED: {type(err).__name__}: {err}")
        if args.once:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
