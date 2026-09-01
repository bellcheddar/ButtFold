#!/usr/bin/env python3
"""P0-3: does the WASM build compute the same physics as the native build?

Two bars, both from PLAN.md section 3:

1. **Forces at step 0 agree to 1e-9.** This is the same bar the C was held to against the
   Swift port. It is a pure function of the model and the input coordinates, so any
   disagreement is a compiler or a floating-point-mode difference and nothing else.
2. **A full same-seed fold agrees at the endpoint**: within 0.02 of the native build's Q,
   and an RMSD inside the native build's own seed-to-seed range. Bitwise trajectory
   identity across compilers is not required and not expected. `gauss()` calls `log`,
   `sqrt` and `cos` from libm, and emscripten's libm is not Apple's; a one-ulp difference
   in the first random number is enough to send the trajectory somewhere else while leaving
   the funnel it is falling into unchanged. What must agree is where it lands.

   PLAN.md section 3 wrote that second bar as a fixed 0.1 A of RMSD. P0-3b measured what
   the number actually does: the same build, folding the same coil, lands anywhere across
   0.84 to 1.16 A on protein G depending on nothing but the random-force seed. A 0.1 A bar
   is therefore narrower than the measurement's own noise and no correct implementation can
   meet it, the reference one included. Q over the same five seeds was 0.993 every time.
   So the RMSD bar is taken from `--rmsd-range`, which is the measured range from
   `tools/chaos_baseline.py`, and Q carries the weight. See METRICS.md, P0-3b.

    tools/parity_check.py --protein trp_cage
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

from coil import native_ca, random_coil, write_xyz  # noqa: E402

NATIVE_BIN = REPO / "build" / "go_fold"
WASM_CLI = REPO / "build" / "wasm" / "go_model_cli.js"
NODE = Path(os.environ.get("BUTTFOLD_NODE",
                           Path.home() / "emsdk/node/24.19.0_64bit/bin/node"))

STEPS_PER_RESIDUE = 100_000
KT, KT_FINAL, SEED = 1.0, 0.6, 1


def native_command(*args: str) -> list[str]:
    return [str(NATIVE_BIN), *args]


def wasm_command(*args: str) -> list[str]:
    return [str(NODE), str(WASM_CLI), *args]


def read_frames(path: Path) -> np.ndarray:
    raw = path.read_bytes()
    n, _frames = np.frombuffer(raw, dtype="<i4", count=2)
    return np.frombuffer(raw, dtype="<f4", offset=8).reshape(-1, n, 3).astype(np.float64)


def kabsch_rmsd(P: np.ndarray, Q: np.ndarray) -> float:
    """RMSD after optimal superposition. Kabsch, Acta Cryst A32:922 (1976)."""
    p = P - P.mean(0)
    q = Q - Q.mean(0)
    u, _s, vt = np.linalg.svd(p.T @ q)
    d = np.sign(np.linalg.det(u @ vt))
    r = u @ np.diag([1.0, 1.0, d]) @ vt
    return float(np.sqrt(((p @ r - q) ** 2).sum(1).mean()))


def native_pairs(ca: np.ndarray, cutoff: float = 8.0, min_sep: int = 3) -> np.ndarray:
    d = np.linalg.norm(ca[:, None, :] - ca[None, :, :], axis=-1)
    sep = np.abs(np.arange(len(ca))[:, None] - np.arange(len(ca))[None, :])
    ii, jj = np.where(np.triu(np.ones_like(d, bool), 1) & (sep >= min_sep) & (d < cutoff))
    return np.stack([ii, jj], 1)


def fraction_native(ca: np.ndarray, pairs: np.ndarray, sigma: np.ndarray,
                    tol: float = 1.2) -> float:
    d = np.linalg.norm(ca[pairs[:, 0]] - ca[pairs[:, 1]], axis=1)
    return float((d < tol * sigma).mean()) if len(pairs) else 0.0


def forces_of(command_builder, native_xyz: Path, start_xyz: Path) -> np.ndarray:
    proc = subprocess.run(
        command_builder("--native", str(native_xyz), "--start", str(start_xyz), "--forces"),
        check=True, capture_output=True, text=True)
    return np.array([[float(v) for v in line.split()]
                     for line in proc.stdout.strip().splitlines()])


def fold_with(command_builder, native_xyz: Path, start_xyz: Path, out: Path,
              steps: int, stride: int) -> tuple[np.ndarray, float]:
    t0 = time.time()
    subprocess.run(
        command_builder("--native", str(native_xyz), "--start", str(start_xyz),
                        "--out", str(out), "--steps", str(steps), "--stride", str(stride),
                        "--kT", str(KT), "--kT-final", str(KT_FINAL), "--seed", str(SEED)),
        check=True, capture_output=True, text=True)
    return read_frames(out), time.time() - t0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--protein", default="trp_cage")
    ap.add_argument("--forces-only", action="store_true")
    ap.add_argument("--rmsd-range", type=float, nargs=2, metavar=("MIN", "MAX"),
                    default=None,
                    help="the native build's measured seed-to-seed RMSD range for this "
                         "protein, from tools/chaos_baseline.py. Without it, only the "
                         "forces and Q bars are enforced and the RMSD is reported bare.")
    ap.add_argument("--json", type=Path, default=None)
    args = ap.parse_args()

    for path, what in [(NATIVE_BIN, "native binary: clang -O2 -o build/go_fold "
                                    "native/go_model_fold.c -lm"),
                       (WASM_CLI, "wasm CLI: ./tools/build_wasm.sh cli"),
                       (NODE, "node: set BUTTFOLD_NODE or install emsdk")]:
        if not path.exists():
            print(f"missing {path}\n  build it with: {what}", file=sys.stderr)
            return 1

    native = native_ca(args.protein)
    n = len(native)
    coil = random_coil(n, np.random.default_rng(SEED))
    work = REPO / "build" / "p0"
    work.mkdir(parents=True, exist_ok=True)
    native_xyz = write_xyz(work / f"{args.protein}.native.xyz", native)
    start_xyz = write_xyz(work / f"{args.protein}.start.xyz", coil)

    result: dict = {"protein": args.protein, "residues": n}

    fn = forces_of(native_command, native_xyz, start_xyz)
    fw = forces_of(wasm_command, native_xyz, start_xyz)
    if fn.shape != fw.shape:
        print(f"force arrays differ in shape: {fn.shape} vs {fw.shape}", file=sys.stderr)
        return 1
    absolute = float(np.abs(fn - fw).max())
    scale = float(np.abs(fn).max())
    relative = absolute / scale if scale else 0.0
    result["forces"] = {"maxAbsoluteDifference": absolute,
                        "maxRelativeDifference": relative,
                        "largestForceComponent": scale,
                        "identical": bool(np.array_equal(fn, fw))}
    print(f"forces at step 0, {args.protein} (n={n}):")
    print(f"  max |native - wasm|   {absolute:.3e}")
    print(f"  relative to |f|max    {relative:.3e}   (bar: 1e-9)")
    print(f"  bitwise identical     {result['forces']['identical']}")
    forces_pass = relative <= 1e-9
    if args.forces_only:
        result["pass"] = forces_pass
        if args.json:
            args.json.write_text(json.dumps(result, indent=1))
        return 0 if forces_pass else 1

    steps = STEPS_PER_RESIDUE * n
    stride = max(steps // 300, 1)
    pairs = native_pairs(native)
    sigma = np.linalg.norm(native[pairs[:, 0]] - native[pairs[:, 1]], axis=1)

    print(f"\nfull fold, {steps:,} steps, seed {SEED}:")
    endpoints = {}
    for label, builder in [("native", native_command), ("wasm", wasm_command)]:
        frames, wall = fold_with(builder, native_xyz, start_xyz,
                                 work / f"{args.protein}.{label}.bin", steps, stride)
        q = fraction_native(frames[-1], pairs, sigma)
        rmsd = kabsch_rmsd(frames[-1], native)
        rg_start = float(np.sqrt(((frames[0] - frames[0].mean(0)) ** 2).sum(1).mean()))
        rg_end = float(np.sqrt(((frames[-1] - frames[-1].mean(0)) ** 2).sum(1).mean()))
        endpoints[label] = {"seconds": round(wall, 2), "q": round(q, 4),
                            "rmsd": round(rmsd, 3), "frames": int(len(frames)),
                            "rgStart": round(rg_start, 2), "rgEnd": round(rg_end, 2)}
        print(f"  {label:7s} {wall:7.1f} s  Q {q:.3f}  RMSD {rmsd:.2f} A  "
              f"Rg {rg_start:.1f} -> {rg_end:.1f} A  {len(frames)} frames")

    dq = abs(endpoints["native"]["q"] - endpoints["wasm"]["q"])
    drmsd = abs(endpoints["native"]["rmsd"] - endpoints["wasm"]["rmsd"])
    slowdown = endpoints["wasm"]["seconds"] / max(endpoints["native"]["seconds"], 1e-9)
    result["endpoints"] = endpoints
    result["endpointAgreement"] = {"deltaQ": round(dq, 4), "deltaRmsd": round(drmsd, 3),
                                   "wasmSlowdown": round(slowdown, 2)}
    print(f"\n  delta Q     {dq:.3f}   (bar: 0.02)")
    print(f"  wasm / native wall time  {slowdown:.2f}x")

    if args.rmsd_range:
        low, high = sorted(args.rmsd_range)
        in_range = low <= endpoints["wasm"]["rmsd"] <= high
        print(f"  wasm RMSD   {endpoints['wasm']['rmsd']:.2f} A "
              f"(bar: inside the native build's own {low:.2f} to {high:.2f} A seed spread) "
              f"{'ok' if in_range else 'OUTSIDE'}")
        result["endpointAgreement"]["rmsdInNativeSeedRange"] = bool(in_range)
        result["endpointAgreement"]["nativeSeedRange"] = [low, high]
    else:
        in_range = True
        print(f"  wasm RMSD   {endpoints['wasm']['rmsd']:.2f} A "
              f"(delta {drmsd:.2f} A; no --rmsd-range given, so not a bar)")

    endpoint_pass = dq <= 0.02 and in_range
    result["pass"] = bool(forces_pass and endpoint_pass)
    print(f"\nP0-3 {'PASS' if result['pass'] else 'FAIL'}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=1))
        print(f"wrote {args.json}")
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
