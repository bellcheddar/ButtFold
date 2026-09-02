"""The job queue for architecture B: the droplet folds, one job at a time.

PLAN.md section 5.5. B is the fallback for browsers that cannot run the WASM module, and
the path for anything too heavy for a phone. It is also **the only architecture with a kill
condition**, and P0-1 measured its way past that: trp-cage folds on the droplet in 16.6 s
and ubiquitin in 7 min 07 s, both inside the decision rule, so B ships on demand with the
residue cap at 76.

The whole design is bounds. A queue on a 3.9 GB box shared with four other apps is only
safe if every dimension of it is capped and every cap is enforced in one place:

- **one worker, one job at a time**, at `nice -n 19`, so a fold can never starve nginx or
  the other apps;
- **a residue cap**, from measurement, so no job can be arbitrarily long;
- **a queue depth cap**, so a burst returns 429 rather than accumulating work;
- **one pending job per IP**, so one visitor cannot fill the queue by themselves;
- **a timeout at three times the measured worst case**, so a job that goes wrong is killed
  and reported rather than held forever;
- **a result cache**, so the finite set of whitelisted inputs converges and B stops costing
  CPU at all.

SQLite rather than a directory of files: the position-in-queue query, the per-IP count and
the depth cap are all one statement each, and the concurrency between a Flask worker
accepting jobs and the fold worker taking them is exactly what a transaction is for.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
from buttfold import uniprot

NATIVES = REPO / "data" / "natives"

# Caps. Every one of these is a measured number or a deliberate policy, and they live here
# rather than in the route so the worker and the tests read the same values.
RESIDUE_CAP = 76             # P0-1: ubiquitin, 7 min 07 s on the droplet
QUEUE_DEPTH_CAP = 5          # a burst returns 429 rather than accumulating work
PER_IP_PENDING_CAP = 1       # one visitor cannot fill the queue alone
# Three times the measured worst case for the largest permitted protein: ubiquitin at
# 427.4 s, so 1282 s. A job that exceeds it has gone wrong, and is killed and reported.
MEASURED_WORST_CASE_SECONDS = 427.4
TIMEOUT_SECONDS = int(3 * MEASURED_WORST_CASE_SECONDS)

STATES = ("queued", "running", "done", "failed", "timeout", "cancelled")

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    protein_id   TEXT NOT NULL,
    seed         INTEGER NOT NULL,
    cache_key    TEXT NOT NULL,
    client       TEXT NOT NULL,
    state        TEXT NOT NULL,
    created      REAL NOT NULL,
    started      REAL,
    finished     REAL,
    frames_total INTEGER NOT NULL,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs (state, created);
CREATE INDEX IF NOT EXISTS jobs_cache_key ON jobs (cache_key);
"""


class QueueFull(Exception):
    """The depth cap or the per-IP cap is reached. The caller answers 429."""


class NotAllowed(Exception):
    """The request is for something the queue will not fold. The caller answers 400."""


def cache_key(protein_id: str, seed: int, steps: int, kt: float, kt_final: float) -> str:
    """SHA-256 of everything the trajectory depends on.

    Inputs are whitelisted, so this converges to a finite set of keys: once each has been
    computed once, B costs no CPU at all and every request is a cache hit.
    """
    material = f"{protein_id}|{seed}|{steps}|{kt}|{kt_final}"
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def whitelisted() -> dict[str, dict]:
    """The proteins the queue will fold: the committed natives and the screened catalogue.

    Still no arbitrary uploads. A user-supplied sequence is a user-supplied amount of CPU,
    and the point of the caps is that the work is bounded and known - so the ESMFold engine
    offers a committed list that was screened offline rather than a text box. Every entry's
    residue count is known here without a network call, which is what lets the web process
    enforce the cap before accepting a job.
    """
    out = {}
    for path in sorted(NATIVES.glob("*.json")):
        record = json.loads(path.read_text())
        out[record["id"]] = {"id": record["id"], "name": record["name"],
                             "residueCount": record["residueCount"]}
    for queue_id, entry in uniprot.catalogue().items():
        out[queue_id] = {"id": queue_id, "name": entry["name"],
                         "residueCount": entry["residueCount"]}
    return out


class JobQueue:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, isolation_level="IMMEDIATE")
        db.row_factory = sqlite3.Row
        # WAL, because a Flask worker accepting jobs and the fold worker taking them are two
        # processes on the same file, and the default rollback journal makes readers block
        # writers. A queue that stalls the page while a job starts is not a queue.
        db.execute("PRAGMA journal_mode=WAL")
        return db

    # -- accepting work -----------------------------------------------------------------

    def submit(self, protein_id: str, seed: int, client: str, steps_per_residue: int,
               kt: float, kt_final: float, frames_total: int) -> dict:
        """Accept a job, or raise. Returns the job row, which may be an existing one."""
        catalogue = whitelisted()
        entry = catalogue.get(protein_id)
        if entry is None:
            # An honest refusal names what IS available. The gallery is short enough to
            # list; the ESMFold catalogue is two dozen entries, so it gets a count and the
            # route that returns it rather than a wall of accessions.
            gallery = sorted(i for i in catalogue if not uniprot.is_uniprot(i))
            predicted = sum(1 for i in catalogue if uniprot.is_uniprot(i))
            raise NotAllowed(
                f"{protein_id!r} is not one of the proteins this queue folds. "
                f"The gallery is {', '.join(gallery)}"
                + (f", and /api/uniprot lists {predicted} UniProt entries the ESMFold "
                   "engine offers." if predicted else "."))
        if entry["residueCount"] > RESIDUE_CAP:
            raise NotAllowed(
                f"{entry['name']} is {entry['residueCount']} residues and this server folds "
                f"up to {RESIDUE_CAP}. It takes about "
                f"{MEASURED_WORST_CASE_SECONDS / 60:.0f} minutes at the cap, measured, and a "
                f"longer one would hold the single worker for everybody else.")
        if not isinstance(seed, int) or not (1 <= seed <= 2**31 - 1):
            raise NotAllowed("seed must be a positive integer below 2^31")

        steps = steps_per_residue * entry["residueCount"]
        key = cache_key(protein_id, seed, steps, kt, kt_final)

        with self._connect() as db:
            # A finished job with the same key is the answer; nothing is spawned.
            done = db.execute(
                "SELECT * FROM jobs WHERE cache_key = ? AND state = 'done' "
                "ORDER BY finished DESC LIMIT 1", (key,)).fetchone()
            if done is not None:
                return dict(done) | {"cached": True}

            # An identical job already in flight is that job, for everyone waiting on it.
            live = db.execute(
                "SELECT * FROM jobs WHERE cache_key = ? AND state IN ('queued', 'running') "
                "ORDER BY created LIMIT 1", (key,)).fetchone()
            if live is not None:
                return dict(live) | {"cached": False}

            pending = db.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running')"
            ).fetchone()["n"]
            if pending >= QUEUE_DEPTH_CAP:
                raise QueueFull(
                    f"the queue is full ({pending} of {QUEUE_DEPTH_CAP} jobs). "
                    f"This server folds one protein at a time on purpose.")
            mine = db.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE client = ? "
                "AND state IN ('queued', 'running')", (client,)).fetchone()["n"]
            if mine >= PER_IP_PENDING_CAP:
                raise QueueFull(
                    "you already have a fold in the queue. One at a time, so that one "
                    "visitor cannot fill it.")

            job_id = hashlib.sha256(
                f"{key}|{client}|{time.time()}".encode()).hexdigest()[:16]
            db.execute(
                "INSERT INTO jobs (id, protein_id, seed, cache_key, client, state, created, "
                "frames_total) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
                (job_id, protein_id, seed, key, client, time.time(), frames_total))
            return dict(db.execute("SELECT * FROM jobs WHERE id = ?",
                                   (job_id,)).fetchone()) | {"cached": False}

    # -- reporting ----------------------------------------------------------------------

    def status(self, job_id: str, frames_done: int | None = None) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:
                return None
            position = 0
            if row["state"] == "queued":
                # How many jobs are ahead of this one. 1-based, so "position 1" means next.
                position = db.execute(
                    "SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued' AND created < ?",
                    (row["created"],)).fetchone()["n"] + 1
        out = dict(row)
        out["position"] = position
        out["frames_done"] = frames_done if frames_done is not None else (
            out["frames_total"] if row["state"] == "done" else 0)
        return out

    # -- the worker's side ---------------------------------------------------------------

    def claim(self) -> dict | None:
        """Take the oldest queued job, atomically. One worker, but the transaction is what
        makes "one worker" a fact rather than an assumption."""
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute("UPDATE jobs SET state = 'running', started = ? WHERE id = ?",
                       (time.time(), row["id"]))
            return dict(row) | {"state": "running"}

    def finish(self, job_id: str, state: str, error: str | None = None) -> None:
        if state not in STATES:
            raise ValueError(f"unknown state {state!r}")
        with self._connect() as db:
            db.execute("UPDATE jobs SET state = ?, finished = ?, error = ? WHERE id = ?",
                       (state, time.time(), error, job_id))

    def reset_running(self) -> int:
        """Put anything left 'running' back in the queue. Called by the worker at startup.

        A job is only ever 'running' while a worker is alive; if one is found at startup the
        previous worker died mid-fold, and the honest thing is to fold it again rather than
        leave it stuck forever showing progress that will never move.
        """
        with self._connect() as db:
            cursor = db.execute(
                "UPDATE jobs SET state = 'queued', started = NULL WHERE state = 'running'")
            return cursor.rowcount

    def counts(self) -> dict[str, int]:
        with self._connect() as db:
            rows = db.execute("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state")
            return {row["state"]: row["n"] for row in rows}
