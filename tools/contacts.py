#!/usr/bin/env python3
"""Which residue pairs come into contact, and on which frame. The note onsets.

Ported from PhoneFold's `PhoneFoldKit/Sources/FoldGeometry/ContactTracker.swift`, commit
6f44c8a1ac7684da93668a580b29cbe9a67cfc5e. Used by the baker so that a gallery frame arrives
at the browser with its onsets already in it, and used as the fixture generator for
`ContactTracker.js`, which the live and queued paths run on frames as they arrive.

What matters is the **transition**, not the state: a pair that stays in contact for two
hundred frames is one note, not two hundred.

Two details keep it musical, and both are preserved:

- **Hysteresis.** A pair forms at 8.0 A and only breaks once it exceeds 8.5 A. Without the
  gap, a pair sitting exactly on 8 A chatters in and out and machine-guns the sequencer.
- **A stable order.** Events come back sorted by sequence separation and then by first
  residue, so the same trajectory always produces the same sequence of notes. Separation is
  what sets a note's register, so this is the order the music is written in.

Interpolated frames are never fed in. Only raw model readouts advance the tracker; feeding
it 60 fps of interpolation would fire the same contact repeatedly as the spline wobbles
across the threshold.
"""

from __future__ import annotations

import numpy as np

FORMATION_CUTOFF = 8.0
BREAK_CUTOFF = 8.5
MINIMUM_SEPARATION = 3


class ContactTracker:
    def __init__(self, formation_cutoff: float = FORMATION_CUTOFF,
                 break_cutoff: float = BREAK_CUTOFF,
                 minimum_separation: int = MINIMUM_SEPARATION):
        if break_cutoff < formation_cutoff:
            raise ValueError("break cutoff must not be below the formation cutoff")
        self.formation_cutoff = formation_cutoff
        self.break_cutoff = break_cutoff
        self.minimum_separation = minimum_separation
        self._held: np.ndarray | None = None
        self._eligible: np.ndarray | None = None
        self.residue_count = 0

    def reset(self) -> None:
        if self._held is not None:
            self._held[:] = False

    @property
    def active_contact_count(self) -> int:
        return 0 if self._held is None else int(self._held.sum())

    def update(self, ca: np.ndarray) -> list[tuple[int, int]]:
        """Feed one raw frame; get back the pairs that formed on it, in note order."""
        ca = np.asarray(ca, dtype=np.float64)
        n = len(ca)
        if n != self.residue_count:
            self.residue_count = n
            self._held = np.zeros((n, n), dtype=bool)
            sep = np.abs(np.arange(n)[:, None] - np.arange(n)[None, :])
            self._eligible = np.triu(np.ones((n, n), bool), 1) & (sep >= self.minimum_separation)
        if n <= self.minimum_separation:
            return []

        distance = np.linalg.norm(ca[:, None, :] - ca[None, :, :], axis=-1)
        # Vectorised, but the state machine is the Swift one exactly: held pairs break only
        # above break_cutoff, free pairs form only at or below formation_cutoff.
        broke = self._held & (distance > self.break_cutoff)
        formed = (~self._held) & self._eligible & (distance <= self.formation_cutoff)
        self._held = (self._held & ~broke) | formed

        ii, jj = np.where(formed)
        pairs = sorted(zip(ii.tolist(), jj.tolist()), key=lambda p: (p[1] - p[0], p[0]))
        return pairs


def contact_map(ca: np.ndarray, cutoff: float = FORMATION_CUTOFF,
                minimum_separation: int = MINIMUM_SEPARATION) -> list[tuple[int, int]]:
    """Every pair currently in contact, for a one-off map rather than a stream of events."""
    ca = np.asarray(ca, dtype=np.float64)
    n = len(ca)
    if n <= minimum_separation:
        return []
    distance = np.linalg.norm(ca[:, None, :] - ca[None, :, :], axis=-1)
    sep = np.abs(np.arange(n)[:, None] - np.arange(n)[None, :])
    ii, jj = np.where(np.triu(np.ones((n, n), bool), 1)
                      & (sep >= minimum_separation) & (distance <= cutoff))
    return list(zip(ii.tolist(), jj.tolist()))


def _write_fixtures() -> int:
    """Reference outputs for the Node test of ContactTracker.js.

    A real trajectory, not a synthetic one: the whole point of the hysteresis is what it
    does to a chain that is wobbling near the threshold, and no hand-built case exercises
    that. The cases below are the first 40 frames of the baked trp-cage and protein G
    folds, which between them cover a pair forming, a pair breaking above 8.5 A, and a pair
    sitting between the two cutoffs and correctly firing nothing.
    """
    import json
    import sys
    from pathlib import Path

    repo = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(repo / "tools"))
    gallery_path = repo / "static" / "baked" / "gallery.json"
    if not gallery_path.exists():
        print(f"missing {gallery_path}: run tools/bake_gallery.py first", file=sys.stderr)
        return 1
    gallery = json.loads(gallery_path.read_text())
    scale = gallery["quantisedRange"]

    out = repo / "tests" / "fixtures" / "contacts"
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for fold in gallery["folds"]:
        if fold["id"] not in ("trp_cage", "protein_g_b1"):
            continue
        # The baked points are quantised into a +/-1000 box, so they are NOT angstroms and
        # the 8.0/8.5 cutoffs would be meaningless against them. Rescaled back to angstroms
        # using the fold's own recorded Rg, which is the only length in the artefact that
        # is still in real units.
        frames = fold["frames"][:40]
        first = np.array(frames[0]["points"], dtype=np.float64).reshape(-1, 3)
        rg_quantised = float(np.sqrt(((first - first.mean(0)) ** 2).sum(1).mean()))
        angstroms_per_unit = (frames[0]["rg"] / 10.0) / rg_quantised
        cases = []
        tracker = ContactTracker()
        for frame in frames:
            ca = (np.array(frame["points"], dtype=np.float64).reshape(-1, 3)
                  * angstroms_per_unit)
            cases.append({
                "positions": [round(float(v), 6) for v in ca.reshape(-1)],
                "formed": [[int(i), int(j)] for i, j in tracker.update(ca)],
                "activeAfter": tracker.active_contact_count,
            })
        record = {"id": fold["id"], "residueCount": fold["residueCount"],
                  "quantisedRange": scale, "frames": cases}
        (out / f"{fold['id']}.json").write_text(json.dumps(record, separators=(",", ":")))
        total = sum(len(c["formed"]) for c in cases)
        index.append({"id": fold["id"], "file": f"{fold['id']}.json",
                      "frames": len(cases), "contactsFormed": total})
        print(f"{fold['id']:14s} {len(cases)} frames, {total} contacts formed, "
              f"{cases[-1]['activeAfter']} held at the end")
    (out / "index.json").write_text(json.dumps({"cases": index}, indent=1))
    print(f"\nwrote {len(index)} fixtures to {out.relative_to(repo)}")
    return 0


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Contact tracking and ContactTracker.js fixtures.")
    ap.add_argument("--fixtures", action="store_true", help="write tests/fixtures/contacts/")
    args = ap.parse_args()
    if args.fixtures:
        raise SystemExit(_write_fixtures())
    ap.error("nothing to do: pass --fixtures")
