#!/usr/bin/env python3
"""Fold the launch gallery on the Mac and bake it into the artefact the browser plays.

This is architecture A: zero droplet compute, zero visitor compute, and the thing every
visitor sees on first paint. It runs here and its output is committed.

Adapted from PhoneFold's `Tools/make_fold_of_the_day.py` (commit
6f44c8a1ac7684da93668a580b29cbe9a67cfc5e), whose hard-won decisions carry over unchanged
and are restated where they are enforced below, because each of them was paid for once.

**The first Watch bake was thrown away and that is the reason for the assertions.** It was
made from the bundled ESMFold trajectories, which are already folded: 137 of protein G's
210 contacts formed on frame 1 and the structure's width changed by one part in a thousand.
Baked, that is an already-folded protein twitching. Every upstream check passed; only the
end-to-end one failed, and only because someone measured the first frame against the last.
So this baker asserts what the animation is *about*, and aborts loudly when it is absent:

    Rg_end / Rg_start <= 0.8          the chain must actually collapse
    first-frame contacts < 25% total  it must not start folded

What differs from the Watch format: coordinates are 3D, because the browser's stage orbits,
and each frame carries the sonifier's inputs so that path A never touches the geometry code.

    tools/bake_gallery.py                 bake all six, write static/baked/gallery.json
    tools/bake_gallery.py --only trp_cage
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

import psea  # noqa: E402
from coil import load_native, radius_of_gyration, random_coil, write_xyz  # noqa: E402
from contacts import ContactTracker  # noqa: E402

NATIVE_BIN = REPO / "build" / "go_fold"
SOURCE = REPO / "native" / "go_model_fold.c"
CACHE = REPO / "build" / ".fold_cache"
OUTPUT = REPO / "static" / "baked" / "gallery.json"

# The launch gallery. **Ubiquitin first**, and it is therefore what the page loads with.
#
# It used to be trp-cage, shortest first, and that was the wrong opening: trp-cage is 20
# residues of helix and coil with NO sheet at all, so the cyan never appeared until a visitor
# clicked something, and the first thing anyone saw was a short magenta-and-slate squiggle.
# Ubiquitin is the beta-grasp fold: helix and sheet both, 76 residues, and it collapses from
# Rg 21.3 to 11.5 A, which is the most legible fold in the set.
CHOSEN = ["ubiquitin", "protein_g_b1", "alpha3d", "villin_hp36", "ww_domain", "trp_cage"]

FRAME_CAP = 150            # interpolated in the browser; PLAN section 5.3
QUANTISED_RANGE = 1000     # a tenth of a per cent of the structure's width

# Cooling rather than more steps. PhoneFold measured a fold going from 0.86 A to 0.23 A for
# free by ending colder. And never *fewer* steps as a shortcut: 200,000 steps stops at
# Q = 0.49, a chain that has collapsed but not packed.
KT_START, KT_FINAL = 1.0, 0.6
STEPS_PER_RESIDUE = 100_000
SEED = 1
DT, GAMMA, CUTOFF, MIN_SEP = 0.005, 1.0, 8.0, 3

# The assertions. Measured folds range 0.47 to 0.73 on the collapse ratio, so 0.8 is a
# generous bar that still catches a trajectory that never folded.
MAX_COLLAPSE_RATIO = 0.8
MAX_FIRST_FRAME_CONTACT_FRACTION = 0.25


class BakeError(RuntimeError):
    """A bake that would have shipped an animation of nothing happening."""


def ensure_binary() -> Path:
    if not NATIVE_BIN.exists() or NATIVE_BIN.stat().st_mtime < SOURCE.stat().st_mtime:
        NATIVE_BIN.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["clang", "-O2", "-o", str(NATIVE_BIN), str(SOURCE), "-lm"], check=True)
    return NATIVE_BIN


def read_frames(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    n, _declared = np.frombuffer(raw, dtype="<i4", count=2)
    return np.frombuffer(raw, dtype="<f4", offset=8).reshape(-1, n, 3).astype(np.float64)


def kabsch_rmsd(P: np.ndarray, Q: np.ndarray) -> float:
    p, q = P - P.mean(0), Q - Q.mean(0)
    u, _s, vt = np.linalg.svd(p.T @ q)
    r = u @ np.diag([1.0, 1.0, np.sign(np.linalg.det(u @ vt))]) @ vt
    return float(np.sqrt(((p @ r - q) ** 2).sum(1).mean()))


def per_residue_native_fraction(ca: np.ndarray, pairs: np.ndarray, sigma: np.ndarray,
                                tolerance: float = 1.2) -> np.ndarray:
    """The confidence the sonifier reads, per residue, on a 0 to 100 scale.

    The Gō model has no pLDDT. What it has, and what PhoneFold's structure-based path uses,
    is the fraction of a residue's OWN native contacts that have formed. That is the thing
    worth watching: the hydrophobic core locks in first and completely while the termini are
    still loose, and one number over the whole chain hides it.

    A residue with no native contacts of its own takes the chain's overall value, because
    0/0 is not 0. A flexible terminus or a residue on a convex surface can have no
    long-range partners at all, and scoring those zero would paint them as permanently
    unfolded even in the native structure, which is both wrong and exactly the sort of thing
    a viewer would read as meaningful.

    Ported from PhoneFold's `FoldEngine/LiveTrajectory.swift`, `perResidueNativeFraction`.
    """
    n = len(ca)
    formed = np.zeros(n)
    total = np.zeros(n)
    if len(pairs):
        d = np.linalg.norm(ca[pairs[:, 0]] - ca[pairs[:, 1]], axis=1)
        close = d < tolerance * sigma
        np.add.at(total, pairs[:, 0], 1)
        np.add.at(total, pairs[:, 1], 1)
        np.add.at(formed, pairs[close, 0], 1)
        np.add.at(formed, pairs[close, 1], 1)
        overall = float(close.mean())
    else:
        overall = 0.0
    with np.errstate(invalid="ignore", divide="ignore"):
        fraction = np.where(total > 0, formed / np.maximum(total, 1), overall)
    return fraction * 100.0


def native_pairs(ca: np.ndarray) -> np.ndarray:
    d = np.linalg.norm(ca[:, None, :] - ca[None, :, :], axis=-1)
    sep = np.abs(np.arange(len(ca))[:, None] - np.arange(len(ca))[None, :])
    ii, jj = np.where(np.triu(np.ones_like(d, bool), 1) & (sep >= MIN_SEP) & (d < CUTOFF))
    return np.stack([ii, jj], 1)


def fold(protein_id: str) -> tuple[dict, np.ndarray, float]:
    """Fold this protein, reusing the last run's coordinates when they still apply.

    The Go runs are deterministic in the seed and take between five seconds and two and a
    half minutes each; the projection, the quantisation and the format are what get
    iterated on and cost milliseconds. Two rounds of that were paid for at full price in
    PhoneFold before its cache existed. The key carries every parameter the trajectory
    depends on, so changing one re-folds rather than silently serving the old numbers.
    """
    record = load_native(protein_id)
    native = np.asarray(record["ca"], dtype=np.float64)
    n = len(native)
    start = random_coil(n, np.random.default_rng(SEED))
    steps = STEPS_PER_RESIDUE * n
    stride = max(steps // (FRAME_CAP * 2), 1)

    key = (f"{protein_id}-n{n}-s{steps}-st{stride}-kt{KT_START}-{KT_FINAL}"
           f"-dt{DT}-g{GAMMA}-c{CUTOFF}-m{MIN_SEP}-seed{SEED}.npz")
    cached = CACHE / key
    print(f"{protein_id:14s} {n:3d} residues, {steps:,} steps", end="", flush=True)
    if cached.exists():
        with np.load(cached) as store:
            ca = store["ca"].astype(np.float64)
            wall = float(store["wall"])
        print("  (cached)")
    else:
        print()
        work = CACHE / "work"
        write_xyz(work / f"{protein_id}.native.xyz", native)
        write_xyz(work / f"{protein_id}.start.xyz", start)
        out = work / f"{protein_id}.frames.bin"
        began = time.time()
        subprocess.run([
            str(ensure_binary()),
            "--native", str(work / f"{protein_id}.native.xyz"),
            "--start", str(work / f"{protein_id}.start.xyz"),
            "--out", str(out), "--steps", str(steps), "--stride", str(stride),
            "--kT", str(KT_START), "--kT-final", str(KT_FINAL), "--dt", str(DT),
            "--gamma", str(GAMMA), "--cutoff", str(CUTOFF), "--min-sep", str(MIN_SEP),
            "--seed", str(SEED)], check=True, capture_output=True, text=True)
        wall = time.time() - began
        ca = read_frames(out)
        CACHE.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(cached, ca=ca.astype(np.float32), wall=wall)
    return record, ca, wall


def bake(protein_id: str) -> dict:
    """Fold this protein and bake it. The gallery path."""
    record, ca, wall = fold(protein_id)
    return bake_frames(record, ca, wall)


def bake_frames(record: dict, ca: np.ndarray, wall: float) -> dict:
    """Bake a trajectory that has already been folded.

    Split out from `bake` so the droplet's queue worker can reuse it verbatim, assertions
    included. A queued fold that did not collapse must fail here exactly as a gallery bake
    would, rather than being served as an animation of nothing happening - and it must fail
    through THIS code rather than through a second implementation that might not.
    """
    native = np.asarray(record["ca"], dtype=np.float64)

    frames = list(ca)
    if len(frames) > FRAME_CAP:
        # Always including the last: it is the folded structure, and it is what the whole
        # animation is heading towards.
        indices = np.linspace(0, len(frames) - 1, FRAME_CAP).round().astype(int)
        frames = [frames[i] for i in sorted(set(indices.tolist()))]

    # --- the assertions, before anything is written -----------------------------------
    rg_start, rg_end = radius_of_gyration(frames[0]), radius_of_gyration(frames[-1])
    ratio = rg_end / rg_start
    tracker = ContactTracker()
    per_frame_contacts = [tracker.update(f) for f in frames]
    total_contacts = sum(len(c) for c in per_frame_contacts)
    first_fraction = (len(per_frame_contacts[0]) / total_contacts) if total_contacts else 1.0

    if ratio > MAX_COLLAPSE_RATIO:
        raise BakeError(
            f"{protein_id}: Rg went {rg_start:.1f} -> {rg_end:.1f} A, a ratio of "
            f"{ratio:.2f}, above the {MAX_COLLAPSE_RATIO} bar. This trajectory does not "
            f"collapse, so there is no animation in it. Do not relax the bar; find out why "
            f"it did not fold.")
    if first_fraction >= MAX_FIRST_FRAME_CONTACT_FRACTION:
        raise BakeError(
            f"{protein_id}: {len(per_frame_contacts[0])} of {total_contacts} contacts "
            f"({first_fraction:.0%}) form on frame 1, at or above the "
            f"{MAX_FIRST_FRAME_CONTACT_FRACTION:.0%} bar. This trajectory starts folded. "
            f"That is exactly the bake PhoneFold threw away.")

    # --- geometry per frame ------------------------------------------------------------
    pairs = native_pairs(native)
    sigma = np.linalg.norm(native[pairs[:, 0]] - native[pairs[:, 1]], axis=1)
    smoother = psea.Hysteresis(residue_count=len(native))

    # **Translate per frame, scale once.** Both halves took a wrong turn first in PhoneFold.
    # Centring every frame on the folded structure's centroid put the coil off to one side,
    # because a coil's centre of mass is nowhere near the core it collapses into, and the
    # animation drifted into frame as it went. Centring on the trajectory's bounding box
    # fixed the coil and broke the ending. What a viewer does is keep the object in the
    # middle and let it change size: centre each frame on its own centroid, take the scale
    # once from the widest frame.
    centred = [f - f.mean(axis=0) for f in frames]
    half = max(float(np.abs(c).max()) for c in centred)
    scale = QUANTISED_RANGE / max(half, 1e-6)
    # The ruler, recorded. Quantised units are unitless by construction, and anything that
    # wants real lengths back - the live path's scale continuity, the spatial audio, any
    # future export - would otherwise have to reconstruct it from a frame's Rg, which is a
    # derived quantity and lossy. One float per fold.
    angstroms_per_unit = 1.0 / scale

    baked_frames = []
    for index, (frame, contacts) in enumerate(zip(centred, per_frame_contacts)):
        raw_ss, raw_confidence = psea.assign(frames[index])
        ss, ss_confidence = smoother.smooth(raw_ss, raw_confidence)
        d = np.linalg.norm(frames[index][pairs[:, 0]] - frames[index][pairs[:, 1]], axis=1)
        q = float((d < 1.2 * sigma).mean()) if len(pairs) else 0.0
        # Per-residue confidence, rounded to whole percent. That is a tenth of the
        # sonifier's velocity resolution (velocity = 30 + 90q, so one percent is 0.9 of a
        # MIDI velocity step), so nothing musical is lost and the payload stays small.
        confidence = per_residue_native_fraction(frames[index], pairs, sigma)
        baked_frames.append({
            "points": np.round(frame * scale).astype(int).reshape(-1).tolist(),
            "newContacts": [[int(i), int(j)] for i, j in contacts],
            "ss": psea.run_length_encode(ss),
            "conf": [int(round(c)) for c in confidence],
            # P-SEA's own certainty per residue, which is a different thing from `conf`
            # above: that is how much of the fold has happened, this is how sure the
            # assigner is that this residue is helix or sheet. The cartoon sweeps its cross
            # section from it, so a ribbon grows in rather than snapping. Carried through
            # the same hysteresis as the structure, so a held residue keeps its own
            # structure's certainty rather than borrowing a different one's.
            "ssConf": [int(round(c * 100)) for c in ss_confidence],
            "rg": int(round(radius_of_gyration(frames[index]) * 10)),
            "q": int(round(q * 1000)),
        })

    quality = {
        "nativeFraction": round(baked_frames[-1]["q"] / 1000, 3),
        "rmsdToNative": round(kabsch_rmsd(frames[-1], native), 2),
        "radiusOfGyrationStart": round(rg_start, 1),
        "radiusOfGyrationEnd": round(rg_end, 1),
        "collapseRatio": round(ratio, 2),
        "seconds": round(wall, 1),
        "contactsFormed": total_contacts,
        "firstFrameContactFraction": round(first_fraction, 3),
    }
    final_ss = psea.run_length_decode(baked_frames[-1]["ss"])
    print(f"    {len(baked_frames)} frames, {total_contacts} contacts "
          f"({first_fraction:.0%} on frame 1), Q {quality['nativeFraction']}, "
          f"RMSD {quality['rmsdToNative']} A, Rg {rg_start:.1f} -> {rg_end:.1f} A "
          f"(ratio {ratio:.2f}), SS H{final_ss.count('H')}/E{final_ss.count('E')}/"
          f"C{final_ss.count('C')}")

    return {
        "id": record["id"],
        "name": record["name"],
        "organism": record.get("organism"),
        "residueCount": record["residueCount"],
        "sequence": record["sequence"],
        "engine": "go",
        "provenance": "structure-based-go",
        "listeningNote": record.get("listeningNote"),
        "referencePdb": record.get("referencePdb"),
        "quality": quality,
        # Full precision, deliberately NOT rounded for tidiness. This is the ruler: anything
        # that multiplies quantised units back to Angstroms uses it, and the live-parity test
        # rebuilds every frame through it. Rounded to six decimals it carries a relative
        # error of about 3e-5, which is invisible in every length it produces and is enough
        # to move a coordinate sitting near a rounding boundary by one unit - measured, on
        # trp-cage frame 8, coordinate 50.
        "angstromsPerUnit": angstroms_per_unit,
        # What the live path needs to pick a scale before it has seen the whole trajectory:
        # how much wider the widest frame is than the first one. Measured across the launch
        # gallery it runs 1.05 to 1.39, so a live fold that scales from its own starting
        # coil and then grows monotonically never has to shrink by much, and never shrinks
        # at all in the common case.
        "widestFrameRatio": round(
            QUANTISED_RANGE / max(float(np.abs(centred[0]).max()) * scale, 1e-6), 3),
        "frames": baked_frames,
    }


def write_frame_fixtures(fold_ids: list[str]) -> None:
    """The exact Angstrom coordinates the baker built its frames from, for the JS test.

    `tests/live_parity.test.mjs` has to compare `static/js/frames.js` against this baker on
    the SAME input, and the obvious way to get that input - multiplying the committed
    quantised integers back by the recorded scale - is lossy by half a unit, which is about
    0.008 A on trp-cage. That is far below anything a viewer sees and it is not below the
    8.0 A contact cutoff: a pair sitting within 0.008 A of the threshold flips, and the test
    reported a difference between two implementations that agree. Measured, on trp-cage
    frame 16, contact (4, 10).

    So the fixture carries the coordinates themselves, as the raw float32 the C emitted,
    base64 encoded. Exact, and about a third the size of the same numbers as JSON text.
    """
    import base64

    out = REPO / "tests" / "fixtures" / "frames"
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for protein_id in fold_ids:
        record, ca, _wall = fold(protein_id)
        frames = list(ca)
        if len(frames) > FRAME_CAP:
            picked = np.linspace(0, len(frames) - 1, FRAME_CAP).round().astype(int)
            frames = [frames[i] for i in sorted(set(picked.tolist()))]
        flat = np.asarray(frames, dtype=np.float32).reshape(len(frames), -1)
        payload = {
            "id": protein_id,
            "residueCount": int(record["residueCount"]),
            "frameCount": len(frames),
            "encoding": "base64 little-endian float32, xyzxyz per frame, in Angstroms",
            "frames": [base64.b64encode(row.tobytes()).decode("ascii") for row in flat],
        }
        path = out / f"{protein_id}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")))
        index.append({"id": protein_id, "file": f"{protein_id}.json",
                      "frames": len(frames), "residueCount": payload["residueCount"]})
        print(f"{protein_id:14s} {len(frames)} frames, {path.stat().st_size / 1024:.0f} kB")
    (out / "index.json").write_text(json.dumps({"cases": index}, indent=1))
    print(f"\nwrote {len(index)} frame fixtures to {out.relative_to(REPO)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=OUTPUT)
    ap.add_argument("--only", type=str, default=None,
                    help="comma-separated ids, for trying one without baking all")
    ap.add_argument("--frame-fixtures", action="store_true",
                    help="also write tests/fixtures/frames/ for the JS parity test")
    args = ap.parse_args()

    chosen = args.only.split(",") if args.only else CHOSEN
    folds = [bake(protein_id) for protein_id in chosen]

    payload = {
        "version": 1,
        "generated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "quantisedRange": QUANTISED_RANGE,
        "parameters": {
            "stepsPerResidue": STEPS_PER_RESIDUE, "kT": KT_START, "kTFinal": KT_FINAL,
            "dt": DT, "gamma": GAMMA, "cutoff": CUTOFF, "minimumSeparation": MIN_SEP,
            "seed": SEED, "frameCap": FRAME_CAP,
        },
        "folds": folds,
    }
    out = args.out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    size = out.stat().st_size
    shown = out.relative_to(REPO) if out.is_relative_to(REPO) else out
    print(f"\nwrote {shown}  {size / 1024:.0f} kB, {len(folds)} folds")
    print(f"P0-4: baked payload {size / 1024 / 1024:.2f} MB against a 4 MB budget")
    if args.frame_fixtures:
        print()
        write_frame_fixtures(["trp_cage", "protein_g_b1"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
