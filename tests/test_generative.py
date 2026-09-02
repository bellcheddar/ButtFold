"""The Genie 2 entries: a trajectory that runs the other way, and the claims that go with it.

A generative bake fails BOTH of the gates the gallery lives by, and it is right to: those
gates are assertions about folding. This asserts the mirror image of each against the
committed entries, and then asserts the thing that matters more - that a page showing a
structure which has never existed never says otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tools"))

import bake_genie                                      # noqa: E402
from bake_gallery import formed, native_pairs          # noqa: E402
from buttfold import store                             # noqa: E402


@pytest.fixture(scope="module")
def entries():
    folds = [f for f in store.gallery()["folds"] if f.get("engine") == "generative"]
    if not folds:
        pytest.skip("no generative entries baked; run tools/bake_genie.py")
    return folds


def frames_of(fold):
    """Back to Angstroms, through the fold's own recorded ruler."""
    apu = fold["angstromsPerUnit"]
    n = fold["residueCount"]
    return [np.asarray(f["points"], dtype=np.float64).reshape(n, 3) * apu
            for f in fold["frames"]]


def radius_of_gyration(ca):
    centred = ca - ca.mean(axis=0)
    return float(np.sqrt((centred ** 2).sum(axis=1).mean()))


# ------------------------------------------------------------------ the mirrored gates ---

def test_every_generative_trajectory_expands_rather_than_collapsing(entries):
    """The Go gate is Rg_end / Rg_start <= 0.8. This is the opposite claim.

    A diffusion trajectory starts with every residue piled into a ball far tighter than any
    protein and opens out into one. A run that did not is a run with nothing to watch, which
    is the same thing the collapse gate is protecting against from the other side.
    """
    for fold in entries:
        frames = frames_of(fold)
        ratio = radius_of_gyration(frames[-1]) / radius_of_gyration(frames[0])
        assert ratio >= bake_genie.MIN_EXPANSION_RATIO, (
            f"{fold['id']} expanded only {ratio:.1f}x")


def test_every_generative_trajectory_starts_as_noise(entries):
    """It must not start as a protein, which is the generative form of "starts folded"."""
    for fold in entries:
        frames = frames_of(fold)
        n = fold["residueCount"]
        native_rg = 2.2 * n ** 0.38
        assert radius_of_gyration(frames[0]) <= bake_genie.MAX_START_RG_FRACTION * native_rg


def test_every_generative_result_is_a_chain_a_protein_could_be(entries):
    """Bond lengths, tightly. Measured on the samples at 3.80 +/- 0.14 against the real 3.80.

    This is the assertion that separates "a diffusion model produced a backbone" from "a
    diffusion model produced a cloud of points", and it is the one that would let a bad
    sample into the gallery looking exactly like a good one.
    """
    for fold in entries:
        bonds = np.linalg.norm(np.diff(frames_of(fold)[-1], axis=0), axis=1)
        assert abs(bonds.mean() - bake_genie.CA_CA_TARGET) <= bake_genie.CA_CA_TOLERANCE, (
            f"{fold['id']} has mean CA-CA {bonds.mean():.2f} A")


def test_structure_actually_emerges(entries):
    """Nothing happening is the failure mode a generative gallery entry has."""
    for fold in entries:
        assert fold["quality"]["structuredFraction"] >= \
            bake_genie.MIN_FINAL_STRUCTURED_FRACTION, fold["id"]
        first = fold["frames"][0]["q"] / 1000
        last = fold["frames"][-1]["q"] / 1000
        assert first < 0.1 and last > 0.9, (
            f"{fold['id']} goes from {first:.2f} to {last:.2f}: nothing resolved")


# ------------------------------------------------------------------ the contact rule -----

def test_the_one_sided_contact_rule_is_useless_on_a_diffusion_trajectory(entries):
    """This is why `formed` has two regimes, asserted rather than described.

    In the opening ball every pair is under any distance bar, so the Go model's rule reports
    the entire contact map as made on frame one - which would fire every note in the piece
    as one chord and then nothing.
    """
    fold = entries[0]
    frames = frames_of(fold)
    reference = frames[-1]
    pairs = native_pairs(reference)
    sigma = np.linalg.norm(reference[pairs[:, 0]] - reference[pairs[:, 1]], axis=1)
    d = np.linalg.norm(frames[0][pairs[:, 0]] - frames[0][pairs[:, 1]], axis=1)

    assert formed(d, sigma, "collapse").mean() > 0.95, (
        "the one-sided rule was expected to fire almost everything on frame 1")
    assert formed(d, sigma, "emerge").mean() < 0.05, (
        "the two-sided rule fired on the opening ball, so it is not measuring emergence")


def test_the_baked_onsets_are_spread_across_the_trajectory(entries):
    """A first frame carrying most of the contacts is the bug the two-sided rule fixes."""
    for fold in entries:
        assert fold["quality"]["firstFrameContactFraction"] < 0.25, fold["id"]
        assert fold["quality"]["contactsFormed"] > 50, fold["id"]


# ------------------------------------------------------------------ the claims -----------

def test_a_generative_entry_never_claims_a_native_structure(entries):
    for fold in entries:
        assert fold["provenance"] == "genie2-diffusion"
        assert fold["quality"]["rmsdToNative"] is None, (
            f"{fold['id']} reports an RMSD to a structure that does not exist")
        assert fold.get("referencePdb") is None
        assert fold.get("organism") is None


def test_a_generative_entry_says_what_made_it(entries):
    """A visitor has to be able to find out what produced this and on what."""
    for fold in entries:
        made = fold["generative"]
        assert made["model"] == "Genie 2"
        assert made["citation"].startswith("Lin et al.")
        assert made["timesteps"] == bake_genie.N_TIMESTEPS
        assert isinstance(made["seed"], int), "not reproducible without the seed"


def test_the_sequence_is_the_polyalanine_the_model_actually_produced(entries):
    """Genie 2 is sequence-agnostic and writes every residue as alanine.

    Inventing a plausible sequence to make the hydrophobicity colour mode look interesting
    would be making something up about a structure that is already made up.
    """
    for fold in entries:
        assert set(fold["sequence"]) == {"A"}
        assert len(fold["sequence"]) == fold["residueCount"]


def test_the_page_labels_a_generative_fold_as_never_having_existed():
    page = (REPO / "templates" / "index.html").read_text()
    assert "a protein that has never existed" in page
    player = (REPO / "static" / "js" / "player.js").read_text()
    assert "invented from noise" in player


def test_the_readouts_do_not_report_a_native_fraction_for_something_with_no_native():
    """"NATIVE 100%" beside a structure that never existed is a quiet false claim.

    It was there: `compaction` clamps to 1 on a diffusion trajectory's first frame and stays
    there, so both that readout and the one beside it sat at a motionless 100% while the
    picture changed completely.
    """
    player = (REPO / "static" / "js" / "player.js").read_text()
    assert "'Emerged'" in player and "'Size'" in player, (
        "the readouts are not relabelled for the generative engine")
    assert "the expansion, in" in player, (
        "the radius-of-gyration chart still calls a diffusion trajectory a collapse")


def test_the_generative_engine_does_not_take_its_tempo_from_compaction():
    sonifier = (REPO / "static" / "js" / "Sonifier.js").read_text()
    assert "frame.progress ?? compaction(" in sonifier, (
        "the sonifier still paces a generative fold by compaction, which is pinned at 1 for "
        "the whole trajectory: maximum tempo from the first frame to the last")
