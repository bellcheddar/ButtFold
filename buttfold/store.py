"""Access to the baked gallery and the architecture-B result cache.

Both are the same artefact format (PLAN.md section 5.3), which is the point: a fold the
droplet computed on demand is baked into exactly the shape the gallery ships in, so the
player downstream cannot tell them apart and there is only one thing to test.

The gallery is read once at import and held. It is a committed file that only changes on
deploy, it is under a megabyte, and re-reading and re-parsing it per request would be work
done for nothing on a box with 3.9 GB shared between five apps. The cache is read per
request, because it grows while the process runs.
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GALLERY = REPO / "static" / "baked" / "gallery.json"
CACHE = REPO / "static" / "cache"

_lock = threading.Lock()
_gallery: dict | None = None


def _load_gallery() -> dict:
    global _gallery
    with _lock:
        if _gallery is None:
            if not GALLERY.exists():
                raise FileNotFoundError(
                    f"{GALLERY} is missing. Bake it: tools/bake_gallery.py")
            _gallery = json.loads(GALLERY.read_text())
        return _gallery


def gallery() -> dict:
    """The whole baked artefact."""
    return _load_gallery()


def index() -> list[dict]:
    """One row per gallery fold: everything a card needs and none of the frames.

    Cards are drawn before any trajectory is downloaded, so this must not carry them. On
    the launch gallery the difference is 686 kB against about 2 kB.
    """
    rows = []
    for fold in _load_gallery()["folds"]:
        quality = fold.get("quality", {})
        rows.append({
            "id": fold["id"],
            "name": fold["name"],
            "organism": fold.get("organism"),
            "residueCount": fold["residueCount"],
            "engine": fold.get("engine", "go"),
            "provenance": fold.get("provenance"),
            "listeningNote": fold.get("listeningNote"),
            "referencePdb": fold.get("referencePdb"),
            "frameCount": len(fold.get("frames", [])),
            "quality": {
                "nativeFraction": quality.get("nativeFraction"),
                "rmsdToNative": quality.get("rmsdToNative"),
                "radiusOfGyrationStart": quality.get("radiusOfGyrationStart"),
                "radiusOfGyrationEnd": quality.get("radiusOfGyrationEnd"),
                "collapseRatio": quality.get("collapseRatio"),
                "seconds": quality.get("seconds"),
            },
        })
    return rows


def fold(fold_id: str) -> dict | None:
    """One baked fold by id, from the gallery first and then the B cache."""
    for entry in _load_gallery()["folds"]:
        if entry["id"] == fold_id:
            return entry
    return cached_fold(fold_id)


def cached_fold(fold_id: str) -> dict | None:
    """A fold architecture B computed earlier, if it is still on disk.

    The id is used as a filename, so it is checked against the resolved path rather than
    trusted: `../../etc/passwd` is a perfectly ordinary-looking string until it is joined
    to a directory.
    """
    candidate = (CACHE / f"{fold_id}.json").resolve()
    if not candidate.is_relative_to(CACHE.resolve()) or not candidate.exists():
        return None
    return json.loads(candidate.read_text())


def cache_key(protein_id: str, steps: int, kt: float, kt_final: float, seed: int) -> str:
    """SHA-256 of everything the trajectory depends on. PLAN section 5.5.

    Inputs are whitelisted, so this converges to a finite set of keys and B stops costing
    CPU once each has been computed once.
    """
    material = f"{protein_id}|{steps}|{kt}|{kt_final}|{seed}"
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def content_hash(path: Path) -> str:
    """Eight hex characters of a file's SHA-256, for `?v=` in the template.

    Content, not mtime: a redeploy rewrites every mtime whether or not the bytes changed,
    which busts every cache on every deploy and teaches browsers nothing.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]
