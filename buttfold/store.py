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

from buttfold.paths import CACHE_DIR

REPO = Path(__file__).resolve().parent.parent
GALLERY = REPO / "static" / "baked" / "gallery.json"
# Genie 2 entries, baked separately because they are made by a different engine and gated by
# different assertions - see tools/bake_genie.py - but served through the same gallery, the
# same route and the same player. One file each rather than one big one: they are added a
# few at a time and a single artefact would have to be rewritten to add one.
GENIE = REPO / "static" / "baked" / "genie"
CACHE = CACHE_DIR

_lock = threading.Lock()
_gallery: dict | None = None


def _load_gallery() -> dict:
    global _gallery
    with _lock:
        if _gallery is None:
            if not GALLERY.exists():
                raise FileNotFoundError(
                    f"{GALLERY} is missing. Bake it: tools/bake_gallery.py")
            loaded = json.loads(GALLERY.read_text())
            # Appended rather than merged into the committed gallery file, so a re-bake of
            # either half cannot disturb the other. The Go folds come first because the page
            # opens on one and because a visitor should meet the real proteins before the
            # invented ones.
            for path in sorted(GENIE.glob("genie2_*.json")) if GENIE.exists() else []:
                loaded["folds"].append(json.loads(path.read_text()))
            _gallery = loaded
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
                # A generative trajectory has no native to be close to and does not
                # collapse; it expands. Carried alongside rather than squeezed into the
                # same field, so nothing has to guess which engine a number came from.
                "expansionRatio": quality.get("expansionRatio"),
                "structuredFraction": quality.get("structuredFraction"),
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


def build_version(root: Path) -> str:
    """One hash over everything under `static/`, naming this build of the front end.

    It goes in the URL **path**, as `/static/v-<hash>/...`, and not in a query string. That
    is the whole point, and it is worth being explicit about why, because getting it wrong
    shipped a stale renderer to a real browser:

    An ES module's `import './stage.js'` resolves against the importing module's own URL.
    Versioning only the entry point - `player.js?v=...` - therefore leaves every module it
    imports on a bare, unversioned URL. Those were served `immutable, max-age=31536000`, so a
    browser that had them would not re-fetch them for a year, and would not even ask. The
    page got a new `player.js` and a year-old `stage.js`, which is a new cartoon renderer
    calling into the old round-tube one.

    A version segment in the path fixes it without a build step or a bundler, because the
    relative imports inherit it: from `/static/v-abc/js/player.js`, `./stage.js` resolves to
    `/static/v-abc/js/stage.js`, and `../wasm/go_model.mjs` to `/static/v-abc/wasm/...`. Every
    URL changes together, so `immutable` becomes true rather than merely asserted.

    `static/cache/` is excluded: it is architecture B's results, it grows while the process
    runs, and it is not part of the front end.
    """
    digest = hashlib.sha256()
    for path in sorted((root / "static").rglob("*")):
        if not path.is_file() or "cache" in path.relative_to(root).parts:
            continue
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def content_hash(path: Path) -> str:
    """Eight hex characters of a file's SHA-256, for `?v=` in the template.

    Content, not mtime: a redeploy rewrites every mtime whether or not the bytes changed,
    which busts every cache on every deploy and teaches browsers nothing.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]
