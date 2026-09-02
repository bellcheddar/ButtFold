"""Where things live, in one place.

The droplet and the Mac disagree about every one of these, and a path guessed twice is a
path that is wrong once. Overridable by environment variable so the systemd unit can put
state under /var/lib rather than in the deployed tree, which must stay a read-only copy of
the repo: a deploy rsyncs over it, and anything the app wrote there would be destroyed on
the next deploy or, worse, survive as a stale file nobody expects.
"""

from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _from_env(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser() if value else default


# Everything the queue writes. On the droplet: BUTTFOLD_STATE=/var/lib/buttfold
STATE_DIR = _from_env("BUTTFOLD_STATE", REPO / "build" / "state")
QUEUE_DB = _from_env("BUTTFOLD_QUEUE_DB", STATE_DIR / "queue.db")
WORK_DIR = _from_env("BUTTFOLD_WORK", STATE_DIR / "work")

# ESMFold predictions, cached by accession. Under the state directory rather than in the
# tree, like everything else the app writes: a deploy rsyncs over the tree, so a prediction
# left there would be destroyed on the next deploy or survive as a stale file nobody expects.
# ESMFold is deterministic for a given sequence, so this is a pure cache - and it means a
# protein folded twice costs Meta's free endpoint one request rather than two.
PREDICTION_CACHE = _from_env("BUTTFOLD_PREDICTIONS", STATE_DIR / "predictions")

# Finished jobs, baked into the gallery's own artefact format. Served by /api/fold/<id>
# through the same store the gallery uses, so a queued fold plays through the identical
# player with no code path of its own.
CACHE_DIR = _from_env("BUTTFOLD_CACHE", REPO / "static" / "cache")
