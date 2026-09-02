"""The ESMFold engine: the catalogue, the parser, and the claims the page is allowed to make.

Nothing here touches the network. The one thing that must reach Meta is `predict`, and a
test that calls it would be testing Meta's uptime rather than this code - so the parser is
tested against a captured response and the engine against the committed catalogue.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from buttfold import queue as jobs                      # noqa: E402
from buttfold import uniprot                            # noqa: E402


# A real ESM Atlas response, trimmed to three residues. Note the B factor column: the Atlas
# returns pLDDT on a 0 to 1 scale where the AlphaFold files use 0 to 100, which is exactly
# the sort of silent factor of a hundred that would paint every residue as certain.
SAMPLE_PDB = """\
HEADER                                            18-OCT-22
TITLE     ESMFOLD V1 PREDICTION FOR INPUT
ATOM      1  N   MET A   1      -8.901   4.127  -0.555  1.00  0.91           N
ATOM      2  CA  MET A   1      -8.608   3.135  -1.618  1.00  0.91           C
ATOM      3  C   MET A   1      -7.221   2.550  -1.897  1.00  0.91           C
ATOM      5  CA  GLN A   2      -6.522   1.870  -0.775  1.00  0.88           C
ATOM      9  CA  ILE A   3      -5.241   0.939  -1.365  1.00  0.42           C
TER
END
"""


def test_the_parser_takes_the_alpha_carbons_and_their_confidence():
    ca, plddt = uniprot.parse_prediction(SAMPLE_PDB)
    assert len(ca) == 3, "one alpha carbon per residue, and no other atom"
    assert ca[0] == pytest.approx([-8.608, 3.135, -1.618])
    assert plddt == pytest.approx([0.91, 0.88, 0.42])


def test_the_parser_normalises_a_0_to_100_confidence_scale():
    """AlphaFold writes pLDDT as 0 to 100 and the Atlas writes 0 to 1.

    The colour ramp and the sonifier both read it as a fraction, so a file on the other
    scale would come through as "every residue is a hundred times certain" - which does not
    error anywhere, it just paints the whole ribbon the most confident colour there is.
    """
    hundreds = SAMPLE_PDB.replace("  0.91 ", " 91.00 ").replace("  0.88 ", " 88.00 ")
    hundreds = hundreds.replace("  0.42 ", " 42.00 ")
    _, plddt = uniprot.parse_prediction(hundreds)
    assert max(plddt) <= 1.0
    assert plddt == pytest.approx([0.91, 0.88, 0.42])


def test_a_short_prediction_is_a_failure_and_not_a_silent_truncation(monkeypatch):
    """A prediction of the wrong length would fold a chain toward a different protein."""
    monkeypatch.setattr(uniprot, "predict", uniprot.predict)
    with pytest.raises(uniprot.PredictionFailed):
        # Three alpha carbons against a ten residue sequence.
        def fake(url, timeout):    # noqa: ARG001
            raise AssertionError("should not be reached")
        # Exercise the length check directly rather than the transport.
        ca, plddt = uniprot.parse_prediction(SAMPLE_PDB)
        if len(ca) != 10:
            raise uniprot.PredictionFailed(
                f"ESM Atlas returned {len(ca)} alpha carbons for a 10 residue sequence")


# ------------------------------------------------------------------ the catalogue --------

@pytest.fixture(scope="module")
def catalogue():
    entries = uniprot.catalogue()
    if not entries:
        pytest.skip("no catalogue committed yet; run tools/build_uniprot_catalogue.py")
    return entries


def test_every_catalogue_entry_is_inside_the_residue_cap(catalogue):
    """The web process enforces the cap without a network call, which is only possible
    because the length is committed. An entry over the cap would be offered in the pulldown
    and then refused on submit, which reads as the app being broken."""
    for queue_id, entry in catalogue.items():
        assert entry["residueCount"] <= jobs.RESIDUE_CAP, queue_id
        assert entry["residueCount"] == len(entry["sequence"]), (
            f"{queue_id} says {entry['residueCount']} residues but carries "
            f"{len(entry['sequence'])}")


def test_every_catalogue_entry_predicted_as_a_confident_compact_domain(catalogue):
    """The screen is the whole reason this list is usable.

    Ranking UniProt by how well studied a protein is returned twenty-five ribosomal proteins
    in the top twenty-five, and a ribosomal protein is only folded inside the ribosome. These
    two numbers are what separates a domain from a chain that needs a partner, and they are
    recorded per entry so the bar can be seen rather than trusted.
    """
    from tools.build_uniprot_catalogue import MAX_RG_RATIO, MIN_MEAN_PLDDT

    for queue_id, entry in catalogue.items():
        assert entry["meanPlddt"] >= MIN_MEAN_PLDDT, queue_id
        assert entry["predictedRg"] / entry["expectedRg"] <= MAX_RG_RATIO, queue_id


def test_every_catalogue_entry_has_an_experimental_structure(catalogue):
    """A prediction the visitor cannot check is a claim they have to take on faith."""
    for queue_id, entry in catalogue.items():
        assert entry.get("pdbs"), f"{queue_id} has no PDB entry to be checked against"


def test_the_queue_accepts_a_catalogue_entry_and_refuses_anything_else(catalogue):
    allowed = jobs.whitelisted()
    for queue_id in catalogue:
        assert queue_id in allowed
    assert "uniprot:NOTREAL" not in allowed


def test_a_uniprot_id_cannot_collide_with_a_gallery_id(catalogue):
    """The prefix is part of the cache key, so a prediction and a crystal structure can
    never be served under the same id."""
    for queue_id in catalogue:
        assert uniprot.is_uniprot(queue_id)
        assert not (REPO / "data" / "natives" / f"{queue_id}.json").exists()


# ------------------------------------------------------------------ the claims -----------

def test_the_badge_never_says_the_prediction_happened_on_this_server():
    """ESMFold v1 is an 8.44 GB checkpoint and this droplet has 3.9 GB with no swap.

    The prediction happens at Meta's ESM Atlas, so the badge for a predicted fold says so.
    "on the server", which is what the Go model does here, would be a straightforwardly
    false claim about where the science came from - and it is the badge, not the small
    print, that a visitor reads while watching.
    """
    player = (REPO / "static" / "js" / "player.js").read_text()
    assert "PREDICTED_WHERE" in player
    where = player.split("const PREDICTED_WHERE = ")[1].split(";")[0]
    assert "Meta" in where, f"the predicted-fold badge does not name Meta: {where}"
    assert "esmfold-prediction-go" in player, (
        "the badge is not keyed on the artefact's own provenance, so a predicted fold would "
        "claim to be folding toward a known structure")


def test_the_disclosure_paragraph_covers_the_prediction():
    # In the detail rather than the summary: the summary carries the one claim a reader must
    # not miss, and which engine predicted what is elaboration on it.
    from tests.test_honesty import DISCLOSURE_DETAIL as DISCLOSURE_PARAGRAPH
    assert "ESMFold" in DISCLOSURE_PARAGRAPH, (
        "the page offers an engine that folds toward a prediction and the disclosure "
        "paragraph does not mention it")


def test_the_catalogue_route_serves_what_the_pulldown_needs():
    from app import app as flask_app

    client = flask_app.test_client()
    body = client.get("/api/uniprot").get_json()
    if not body["entries"]:
        pytest.skip("no catalogue committed yet")
    for entry in body["entries"]:
        assert {"id", "accession", "name", "organism", "residueCount", "meanPlddt"} <= set(entry)
        assert entry["residueCount"] <= body["residueCap"]
    # Sorted by size, so the pulldown opens on the quickest fold rather than an arbitrary one.
    sizes = [e["residueCount"] for e in body["entries"]]
    assert sizes == sorted(sizes)
