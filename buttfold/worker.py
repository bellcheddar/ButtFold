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
import hashlib
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
from buttfold.paths import CACHE_DIR, PREDICTION_CACHE, QUEUE_DB, WORK_DIR  # noqa: E402


def resolve_native(protein_id: str, log) -> dict:
    """The native state this job folds toward, whatever produced it.

    Two sources, one record shape. A gallery protein reads its committed crystal structure
    off disk; a UniProt entry has ESMFold predict one. Everything after this line is
    identical, which is the same rule the three frame sources follow: the difference lives
    at the edge and nothing downstream can tell them apart.
    """
    import numpy as np

    from coil import load_native, random_coil

    from buttfold import uniprot

    if not uniprot.is_uniprot(protein_id):
        record = load_native(protein_id)
        record.setdefault("provenance", "structure-based-go")
        return record

    accession = uniprot.accession_of(protein_id)
    entry = uniprot.catalogue().get(protein_id)
    if entry is None:
        raise RuntimeError(f"{accession} is not in the catalogue")

    began = time.time()
    prediction = uniprot.cached_prediction(accession, entry["sequence"], PREDICTION_CACHE)
    log(f"  ESMFold {accession}: {len(prediction['ca'])} residues in "
        f"{time.time() - began:.1f} s at ESM Atlas")

    # The starting coil is seeded from the accession, so the same protein always starts from
    # the same chain and two folds of it differ only by the model's own seed - exactly the
    # arrangement the committed gallery uses.
    n = len(prediction["ca"])
    # A STABLE hash. Python randomises `hash()` on strings per process by default, so the
    # coil would have differed between worker restarts and the "same protein, same starting
    # chain" promise the gallery makes would have been quietly false - and the cache key,
    # which does not include the coil, would have served two different trajectories under
    # one id.
    seed_bytes = hashlib.sha256(accession.encode()).digest()[:4]
    rng = np.random.default_rng(int.from_bytes(seed_bytes, "big"))
    plddt = prediction["plddt"]
    return {
        "id": protein_id,
        "name": entry["name"],
        "organism": entry["organism"],
        "sequence": entry["sequence"],
        "residueCount": n,
        "ca": prediction["ca"],
        "coil": random_coil(n, rng).tolist(),
        "coilSeed": accession,
        "referencePdb": (entry.get("pdbs") or [None])[0],
        "provenance": "esmfold-prediction-go",
        "prediction": {
            "accession": accession,
            "entryName": entry.get("entryName"),
            "predictor": "ESMFold v1 at the ESM Metagenomic Atlas",
            "meanPlddt": round(sum(plddt) / len(plddt), 3) if plddt else None,
            "plddt": [round(v, 3) for v in plddt],
            "pdbs": entry.get("pdbs", []),
        },
    }


def fold_and_bake(job: dict, log) -> Path:
    """Run one job to completion and write its artefact into the cache.

    Imported lazily and inside the worker only: `bake_gallery` pulls in numpy, and the
    point of this being a separate process is that the web layer never does.
    """
    import json

    import numpy as np

    import bake_gallery as baker
    from coil import write_xyz

    protein_id, seed = job["protein_id"], job["seed"]
    record = resolve_native(protein_id, log)
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

    # **A zero exit code is not proof it wrote anything.** `native/go_model_fold.c` is
    # vendored verbatim from PhoneFold and checks `fopen` on its INPUTS - perror and exit -
    # but not on its output: if the file cannot be opened it folds to the end and returns 0
    # having written nothing. That is not hypothetical, it happened here, and what it looked
    # like was a FileNotFoundError a hundred lines later in the baker with nothing to say
    # about the fold. The C is not ours to edit, so the check lives here, next to the thing
    # that knows what the file was supposed to be.
    expected = 8 + (steps // stride + 1) * n * 3 * 4
    if not frames_path.exists():
        raise RuntimeError(
            f"the model exited 0 after {wall:.1f} s without writing {frames_path}. It does "
            f"not check whether it could open its output, so this is almost always a "
            f"directory that vanished or is not writable.")
    written = frames_path.stat().st_size
    if written < expected // 2:
        raise RuntimeError(
            f"the model wrote {written} bytes where about {expected} were expected for "
            f"{steps // stride + 1} frames of {n} residues. The trajectory is truncated.")

    # Bake through the SAME code the gallery is baked with, including its assertions. A
    # queued fold that did not collapse must fail loudly here rather than be served as an
    # animation of nothing happening.
    ca = baker.read_frames(frames_path)
    baked = baker.bake_frames(record, ca, wall)
    baked["engine"] = "go"
    # Where the target came from, which the badge reads. A fold toward a crystal structure
    # and a fold toward a prediction are two different claims and the page makes both.
    baked["provenance"] = record.get("provenance", "structure-based-go")
    baked["name"] = record["name"]
    baked["organism"] = record.get("organism")
    baked["referencePdb"] = record.get("referencePdb")
    if record.get("prediction"):
        baked["prediction"] = record["prediction"]
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
