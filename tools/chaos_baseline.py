#!/usr/bin/env python3
"""P0-3b: how far apart do two runs of the SAME build land?

P0-3 held the WASM build to "within 0.1 A of the native build's RMSD". On trp-cage the
gap was 0.09 A and it passed; on protein G it was 0.12 A and it failed. Before deciding
that means anything about the WASM build, the question has to be asked the other way
round: **how much does this trajectory move when nothing is wrong at all?**

A Langevin trajectory in a funnelled potential is chaotic. The forces agree to 2.9e-15
relative, so the two builds are the same physics; a single-ulp difference in one of the
millions of `gauss()` draws is enough to send the two runs down different paths inside the
same funnel. What that costs at the endpoint is not a matter of opinion, it is a number,
and this measures it.

The coil is held FIXED at the seed-1 coil and only the C's `--seed` varies, so the only
thing changing is the random force, which is exactly the thing a rounding difference
perturbs. Comparing across different starting coils would measure something else and
would flatter the result.

    tools/chaos_baseline.py --protein protein_g_b1 --seeds 5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parent

from coil import native_ca, random_coil, write_xyz  # noqa: E402
from parity_check import (KT, KT_FINAL, STEPS_PER_RESIDUE, fold_with, fraction_native,  # noqa: E402
                          kabsch_rmsd, native_command, native_pairs, wasm_command)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--protein", default="protein_g_b1")
    ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--build", choices=["native", "wasm", "both"], default="native")
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args()

    native = native_ca(args.protein)
    n = len(native)
    coil = random_coil(n, np.random.default_rng(1))     # fixed: only --seed varies below
    work = REPO / "build" / "p0" / "chaos"
    work.mkdir(parents=True, exist_ok=True)
    native_xyz = write_xyz(work / f"{args.protein}.native.xyz", native)
    start_xyz = write_xyz(work / f"{args.protein}.start.xyz", coil)

    steps = STEPS_PER_RESIDUE * n
    stride = max(steps // 300, 1)
    pairs = native_pairs(native)
    sigma = np.linalg.norm(native[pairs[:, 0]] - native[pairs[:, 1]], axis=1)

    builders = {"native": native_command, "wasm": wasm_command}
    chosen = ["native", "wasm"] if args.build == "both" else [args.build]

    print(f"{args.protein}, n={n}, {steps:,} steps, one fixed coil, "
          f"seeds 1..{args.seeds}\n")
    out: dict = {"protein": args.protein, "residues": n, "steps": steps,
                 "coilSeed": 1, "runs": {}}
    for label in chosen:
        rows = []
        for seed in range(1, args.seeds + 1):
            frames, wall = fold_with_seed(builders[label], native_xyz, start_xyz,
                                          work / f"{args.protein}.{label}.{seed}.bin",
                                          steps, stride, seed)
            q = fraction_native(frames[-1], pairs, sigma)
            rmsd = kabsch_rmsd(frames[-1], native)
            rows.append({"seed": seed, "seconds": round(wall, 1),
                         "q": round(q, 4), "rmsd": round(rmsd, 3)})
            print(f"  {label:7s} seed {seed}  {wall:6.1f} s  Q {q:.3f}  RMSD {rmsd:.2f} A")
        rmsds = np.array([r["rmsd"] for r in rows])
        qs = np.array([r["q"] for r in rows])
        summary = {
            "rmsdMin": float(rmsds.min()), "rmsdMax": float(rmsds.max()),
            "rmsdSpread": float(rmsds.max() - rmsds.min()),
            "rmsdStdev": float(rmsds.std(ddof=1)) if len(rmsds) > 1 else 0.0,
            "qMin": float(qs.min()), "qMax": float(qs.max()),
            "qSpread": float(qs.max() - qs.min()),
        }
        out["runs"][label] = {"perSeed": rows, "summary": summary}
        print(f"  {label}: RMSD {summary['rmsdMin']:.2f} to {summary['rmsdMax']:.2f} A, "
              f"spread {summary['rmsdSpread']:.2f} A, sd {summary['rmsdStdev']:.2f} A; "
              f"Q spread {summary['qSpread']:.3f}\n")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(out, indent=1))
        print(f"wrote {args.json}")
    return 0


def fold_with_seed(builder, native_xyz: Path, start_xyz: Path, out: Path,
                   steps: int, stride: int, seed: int):
    """`fold_with` fixes the seed at 1; this varies it, which is the whole experiment."""
    import subprocess
    import time

    from parity_check import read_frames

    t0 = time.time()
    subprocess.run(
        builder("--native", str(native_xyz), "--start", str(start_xyz), "--out", str(out),
                "--steps", str(steps), "--stride", str(stride), "--kT", str(KT),
                "--kT-final", str(KT_FINAL), "--seed", str(seed)),
        check=True, capture_output=True, text=True)
    return read_frames(out), time.time() - t0


if __name__ == "__main__":
    raise SystemExit(main())
