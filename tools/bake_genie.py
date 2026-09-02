#!/usr/bin/env python3
"""Bake Genie 2 backbones into gallery entries: structure emerging from noise.

    python3 tools/bake_genie.py --lengths 64 72 80 --seed 7

**Why this is baked on the Mac and not an engine on the droplet.** Genie 2 is only 15.7 M
parameters, but sampling is 1000 denoising steps and each one is a forward pass. Measured:
132 ms a step on this Mac at 2 threads and 609 ms on the droplet, so one 80 residue backbone
is 2.2 minutes here and 10.2 minutes there - and more cores do not help, because at batch 1
it is latency-bound on a long chain of small matmuls rather than compute-bound (8 threads
measured no faster than 2). Ten minutes of a shared 2-core box that runs nine other apps is
not an interactive engine. So Genie 2 joins the gallery the way the Go folds did: computed
once, here, and served flat.

**The trajectory runs the other way, and almost nothing about that is cosmetic.** A Go fold
starts as an extended coil and collapses; Genie 2 starts as every residue piled into a ball
of radius 1.1 Angstroms and INFLATES into a protein, growing secondary structure on the way
out. Measured on an 80 residue sample: Rg 1.1 -> 11.2, and 3003 of 3004 contacts "form" on
frame one because at the start everything is within any distance you care to name.

Both of the bake gates the gallery lives by therefore fail, and they are right to: they are
assertions about FOLDING. This file states the mirror image of each, and reuses
`build_frames` rather than writing frames of its own, because one frame builder is the rule
that makes `tests/live_parity.test.mjs` possible at all.

Genie 2 is sequence-agnostic - every residue is alanine in its own output - so these entries
carry a polyalanine sequence, and the hydrophobicity colour mode is honestly flat for them.
That is what the model actually produced.

Genie 2: Lin, Lee, Watson, Baker, AlQuraishi, "Out of Many, One" (arXiv:2405.15489),
Apache 2.0. Checkpoint from the v1.0.0 release, downloaded on demand rather than committed.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))

import numpy as np                                                      # noqa: E402

import bake_gallery as baker                                            # noqa: E402
import psea                                                             # noqa: E402

GENIE_REPO = "https://github.com/aqlaboratory/genie2.git"
GENIE_CHECKPOINT = ("https://github.com/aqlaboratory/genie2/releases/download/"
                    "v1.0.0/epoch.40.ckpt")
WORK = REPO / "build" / "genie2"
OUT = REPO / "static" / "baked" / "genie"

N_TIMESTEPS = 1000
NOISE_SCALE = 0.6            # the paper's own setting for unconditional generation

# --- the gates, mirrored ----------------------------------------------------------------
# A Go fold must collapse by at least a fifth; this must EXPAND by at least fourfold. The
# measured sample went from 1.1 to 11.2 Angstroms, a factor of ten, so four is well below
# anything real and still rejects a run that produced a ball.
MIN_EXPANSION_RATIO = 4.0
# It must start as noise rather than as a protein: the first frame's radius of gyration has
# to be well under the folded-globule scaling for its length.
MAX_START_RG_FRACTION = 0.35
# And end as something a chain could be. Measured on the sample: 3.80 +/- 0.14 Angstroms
# against the real 3.80, so this is tight on purpose - a backbone with 2 Angstrom bonds is
# not a protein and should not reach the gallery looking like one.
CA_CA_TARGET = 3.80
CA_CA_TOLERANCE = 0.25
# Emerging structure is the entire subject. A run that ends all coil is a run with nothing
# to watch, whatever its bond lengths say.
MIN_FINAL_STRUCTURED_FRACTION = 0.25


class GenerativeBakeError(RuntimeError):
    pass


def ensure_genie() -> Path:
    """Genie 2's code and weights, fetched on demand.

    Not vendored: the checkpoint is 181 MB and this repository is public and small. The
    same arrangement `ensure_binary` uses for the C - the tool that produces the artefact is
    reproducible, and the artefact is what gets committed.
    """
    WORK.mkdir(parents=True, exist_ok=True)
    source = WORK / "genie2"
    if not source.exists():
        print(f"cloning {GENIE_REPO}", file=sys.stderr)
        subprocess.run(["git", "clone", "--depth", "1", "-q", GENIE_REPO, str(source)],
                       check=True)
    checkpoint = source / "results" / "base" / "checkpoints" / "epoch=40.ckpt"
    if not checkpoint.exists():
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading {GENIE_CHECKPOINT} (181 MB)", file=sys.stderr)
        with urllib.request.urlopen(GENIE_CHECKPOINT, timeout=600) as response, \
                open(checkpoint, "wb") as handle:
            shutil.copyfileobj(response, handle)
    return source


def sample(length: int, seed: int, source: Path) -> tuple[np.ndarray, float]:
    """One reverse diffusion, captured as a trajectory rather than only an endpoint.

    The loop is Genie 2's own, from `genie/sampler/base.py`, with two lines added: a seed so
    a gallery entry is reproducible, and a copy of `ts.trans` every few steps. `ts.trans` IS
    the alpha carbon set at that step, in Angstroms - the model works in real coordinates
    and its own PDB writer does no rescaling - so this is the trajectory, not a proxy for it.
    """
    sys.path.insert(0, str(source))
    import torch

    from genie.utils.affine_utils import T
    from genie.utils.feat_utils import batchify_np_features, convert_np_features_to_tensor
    from genie.utils.geo_utils import compute_frenet_frames
    from genie.utils.model_io import load_pretrained_model
    from genie.sampler.unconditional import UnconditionalSampler

    torch.manual_seed(seed)
    cwd = Path.cwd()
    try:
        import os
        os.chdir(source)
        model = load_pretrained_model("results", "base", 40).eval().to("cpu")
    finally:
        os.chdir(cwd)

    sampler = UnconditionalSampler(model)
    features = convert_np_features_to_tensor(
        batchify_np_features([sampler.create_np_features(
            {"length": length, "num_samples": 1})]), "cpu")

    trans = torch.randn_like(features["atom_positions"])
    rots = compute_frenet_frames(trans, features["chain_index"], features["residue_mask"])
    ts = T(rots, trans)

    keep_every = max(N_TIMESTEPS // baker.FRAME_CAP, 1)
    captured: list[np.ndarray] = []
    began = time.time()
    for step in reversed(np.arange(1, N_TIMESTEPS + 1)):
        timesteps = torch.Tensor([step]).int()
        with torch.no_grad():
            z_pred = model.model(ts, timesteps, features)["z"]
        w_z = (1. - model.alphas[timesteps]) / model.sqrt_one_minus_alphas_cumprod[timesteps]
        trans_mean = (1. / model.sqrt_alphas[timesteps]).view(-1, 1, 1) * (
            ts.trans - w_z.view(-1, 1, 1) * z_pred)
        trans_mean = trans_mean * features["residue_mask"].unsqueeze(-1)
        if step == 1:
            ts = T(compute_frenet_frames(trans_mean, features["chain_index"],
                                         features["residue_mask"]).detach(),
                   trans_mean.detach())
        else:
            noise = torch.randn_like(ts.trans)
            trans = trans_mean + NOISE_SCALE * model.sqrt_betas[timesteps].view(-1, 1, 1) * noise
            trans = trans * features["residue_mask"].unsqueeze(-1)
            ts = T(compute_frenet_frames(trans, features["chain_index"],
                                         features["residue_mask"]).detach(), trans.detach())
        if int(step) % keep_every == 0 or step == 1:
            captured.append(ts.trans[0].clone().numpy().astype(np.float64))
        if len(captured) % 25 == 0 and len(captured):
            print(f"\r    step {N_TIMESTEPS - int(step) + 1}/{N_TIMESTEPS}",
                  end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    return np.asarray(captured[:baker.FRAME_CAP]), time.time() - began


def bake_one(length: int, seed: int, source: Path) -> dict:
    print(f"genie {length:3d} residues, seed {seed}", file=sys.stderr)
    frames, wall = sample(length, seed, source)
    n = frames.shape[1]

    # --- the assertions, mirrored, before anything is written --------------------------
    rg_start = baker.radius_of_gyration(frames[0])
    rg_end = baker.radius_of_gyration(frames[-1])
    expansion = rg_end / max(rg_start, 1e-6)
    native_rg = 2.2 * n ** 0.38
    bonds = np.linalg.norm(np.diff(frames[-1], axis=0), axis=1)
    final_ss, _ = psea.assign(frames[-1])
    structured = (final_ss.count("H") + final_ss.count("E")) / n

    if expansion < MIN_EXPANSION_RATIO:
        raise GenerativeBakeError(
            f"length {length}: Rg went {rg_start:.1f} -> {rg_end:.1f} A, an expansion of "
            f"{expansion:.1f}x, below the {MIN_EXPANSION_RATIO}x bar. A diffusion trajectory "
            "that does not open out has nothing in it to watch.")
    if rg_start > MAX_START_RG_FRACTION * native_rg:
        raise GenerativeBakeError(
            f"length {length}: the first frame has Rg {rg_start:.1f} A against a folded "
            f"{native_rg:.1f} A for this length. It did not start as noise.")
    if abs(bonds.mean() - CA_CA_TARGET) > CA_CA_TOLERANCE:
        raise GenerativeBakeError(
            f"length {length}: mean CA-CA is {bonds.mean():.2f} +/- {bonds.std():.2f} A "
            f"against the real {CA_CA_TARGET}. This is not a chain.")
    if structured < MIN_FINAL_STRUCTURED_FRACTION:
        raise GenerativeBakeError(
            f"length {length}: the result is {100 * structured:.0f}% helix or sheet, below "
            f"the {100 * MIN_FINAL_STRUCTURED_FRACTION:.0f}% bar. Nothing emerged.")

    # --- the frames, through the ONE builder -------------------------------------------
    # The reference is the trajectory's own last frame: there is no native structure here,
    # because nothing was being folded toward. That is the whole claim the badge makes.
    reference = frames[-1]
    pairs = baker.native_pairs(reference)
    sigma = np.linalg.norm(reference[pairs[:, 0]] - reference[pairs[:, 1]], axis=1)
    onsets = baker.contact_onsets(list(frames), pairs, sigma, "emerge")
    baked_frames, angstroms_per_unit, widest_ratio = baker.build_frames(
        list(frames), onsets, pairs, sigma, regime="emerge")

    total_contacts = sum(len(c) for c in onsets)
    first_fraction = len(onsets[0]) / max(total_contacts, 1)
    print(f"    {len(baked_frames)} frames, {total_contacts} contacts "
          f"({first_fraction:.0%} on frame 1), Rg {rg_start:.1f} -> {rg_end:.1f} A "
          f"(x{expansion:.1f}), CA-CA {bonds.mean():.2f} A, "
          f"SS H{final_ss.count('H')}/E{final_ss.count('E')}/C{final_ss.count('C')}, "
          f"{wall:.0f} s", file=sys.stderr)

    return {
        "id": f"genie2_{n}_{seed}",
        "name": f"Genie 2 backbone, {n} residues",
        "organism": None,
        "residueCount": n,
        # Genie 2 is sequence-agnostic: every residue is alanine in its own output. Stated
        # rather than invented, so the hydrophobicity mode is honestly flat for these.
        "sequence": "A" * n,
        "engine": "generative",
        "provenance": "genie2-diffusion",
        "listeningNote": "There is no protein here. A diffusion model was asked for a "
                         "backbone of this length and this is it emerging from noise; the "
                         "music follows the structure resolving rather than a chain "
                         "collapsing.",
        "referencePdb": None,
        "generative": {
            "model": "Genie 2",
            "parameters": 15_700_000,
            "timesteps": N_TIMESTEPS,
            "noiseScale": NOISE_SCALE,
            "seed": seed,
            "citation": "Lin et al., arXiv:2405.15489",
            "computedOn": "a Mac, once; see tools/bake_genie.py for why not the droplet",
        },
        "quality": {
            "nativeFraction": round(baked_frames[-1]["q"] / 1000, 3),
            "rmsdToNative": None,
            "radiusOfGyrationStart": round(rg_start, 1),
            "radiusOfGyrationEnd": round(rg_end, 1),
            "expansionRatio": round(expansion, 2),
            "meanCaCa": round(float(bonds.mean()), 2),
            "structuredFraction": round(structured, 3),
            "seconds": round(wall, 1),
            "contactsFormed": total_contacts,
            "firstFrameContactFraction": round(first_fraction, 3),
        },
        "angstromsPerUnit": angstroms_per_unit,
        "widestFrameRatio": widest_ratio,
        "frames": baked_frames,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lengths", type=int, nargs="+", default=[64, 72, 80])
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    source = ensure_genie()
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for offset, length in enumerate(args.lengths):
        fold = bake_one(length, args.seed + offset, source)
        path = OUT / f"{fold['id']}.json"
        path.write_text(json.dumps(fold, separators=(",", ":"), sort_keys=True))
        index.append({"id": fold["id"], "file": f"genie/{path.name}",
                      "name": fold["name"], "residueCount": fold["residueCount"],
                      "engine": fold["engine"]})
        print(f"    wrote {path.name}, {path.stat().st_size / 1024:.0f} kB", file=sys.stderr)
    (OUT / "index.json").write_text(json.dumps({"folds": index}, indent=1) + "\n")
    print(f"\n{len(index)} generative entries in {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
