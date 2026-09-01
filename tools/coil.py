#!/usr/bin/env python3
"""The unfolded state every ButtFold trajectory starts from, and the xyz files the C reads.

Ported verbatim in behaviour from PhoneFold's `Tools/go_model_fold.py` (commit
6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, functions `random_coil` and `_place`), so that
ButtFold's coils are the same coils and a seeded fold here reproduces a seeded fold there.
Ported rather than imported: PLAN.md section 1 says files are vendored with provenance and
never referenced across repos by path.

A freely-rotating self-avoiding walk: bond 3.8 A, bond angles drawn across the range a CA
trace occupies, dihedrals uniform on the circle, rejection against a hard-sphere clash.
Its radius of gyration lands near the experimental scaling for denatured proteins
(Kohn et al., PNAS 101:12491, 2004: Rg = 2.54 N^0.522).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
NATIVES = REPO / "data" / "natives"


def _place(a: np.ndarray, b: np.ndarray, c: np.ndarray,
           bond: float, theta: float, phi: float) -> np.ndarray:
    """Next CA from the previous three, at the given bond angle and dihedral (NeRF)."""
    b1, b2 = c - b, b - a
    e1 = b1 / np.linalg.norm(b1)
    n1 = np.cross(b2, b1)
    n1 = n1 / np.linalg.norm(n1)
    e2 = np.cross(n1, e1)
    return c + bond * (-np.cos(theta) * e1
                       + np.sin(theta) * (np.cos(phi) * e2 + np.sin(phi) * n1))


def random_coil(n: int, rng: np.random.Generator, bond: float = 3.8,
                angle_deg: tuple[float, float] = (85.0, 145.0),
                clash: float = 4.0, attempts: int = 200) -> np.ndarray:
    """A self-avoiding random coil of n residues."""
    x = np.zeros((n, 3))
    x[1] = [bond, 0, 0]
    t2 = np.deg2rad(rng.uniform(*angle_deg))
    x[2] = x[1] + bond * np.array([-np.cos(t2), np.sin(t2), 0.0])
    k = 3
    stuck = 0
    while k < n:
        placed = False
        for _ in range(attempts):
            theta = np.deg2rad(rng.uniform(*angle_deg))
            phi = rng.uniform(-np.pi, np.pi)
            cand = _place(x[k - 3], x[k - 2], x[k - 1], bond, theta, phi)
            if k < 3 or np.all(np.linalg.norm(x[:k - 2] - cand, axis=1) > clash):
                x[k] = cand
                placed = True
                break
        if placed:
            k += 1
            stuck = 0
        else:
            # back up two residues and try again rather than accepting a clash
            k = max(3, k - 2)
            stuck += 1
            if stuck > 50:
                raise RuntimeError("could not build a self-avoiding coil")
    return x


def load_native(protein_id: str) -> dict:
    """One vendored native record from data/natives/, as written by extract_natives.py."""
    path = NATIVES / f"{protein_id}.json"
    if not path.exists():
        raise SystemExit(f"no vendored native for {protein_id!r}: run tools/extract_natives.py")
    return json.loads(path.read_text())


def native_ca(protein_id: str) -> np.ndarray:
    return np.asarray(load_native(protein_id)["ca"], dtype=np.float64)


def write_xyz(path: Path, ca: np.ndarray) -> Path:
    """The plain `x y z` per line that go_model_fold.c's read_xyz() consumes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savetxt(path, np.asarray(ca, dtype=np.float64))
    return path


def radius_of_gyration(ca: np.ndarray) -> float:
    centred = ca - ca.mean(axis=0)
    return float(np.sqrt((centred * centred).sum(axis=1).mean()))


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Write native.xyz and start.xyz for one protein.")
    ap.add_argument("protein_id")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", type=Path, default=REPO / "build" / "xyz")
    args = ap.parse_args()

    native = native_ca(args.protein_id)
    coil = random_coil(len(native), np.random.default_rng(args.seed))
    n = len(native)
    write_xyz(args.out / f"{args.protein_id}.native.xyz", native)
    write_xyz(args.out / f"{args.protein_id}.start.seed{args.seed}.xyz", coil)
    expected = 2.54 * n ** 0.522
    print(f"{args.protein_id}: {n} residues, "
          f"native Rg {radius_of_gyration(native):.1f} A, "
          f"coil Rg {radius_of_gyration(coil):.1f} A "
          f"(Kohn scaling expects {expected:.1f} A)")
    print(f"wrote to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
