"""The Flask routes, the caching behaviour and the served artefact.

PLAN.md section 10. What these are for is the difference between "the route returns 200"
and "the thing the route returns is the thing the page needs", which is where the failures
actually live.

    python3 -m pytest tests/ -q
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from app import app as flask_app  # noqa: E402


DISCLOSURE_PARAGRAPH = (
    "ButtFold shows a simple physics model relaxing a chain into a structure it already "
    "knows, and what a generative network's inventions look and sound like. It is not a "
    "prediction of an unknown structure, it is not a physical folding pathway, and no "
    "protein folds this way. The music is a faithful map of the simulation's events, and "
    "nothing more."
)


def visible_text(html: str) -> str:
    """Tags stripped and whitespace collapsed, which is what a reader actually sees.

    The disclosure paragraph is line-wrapped in the template, as prose in a template
    always will be, so a byte-for-byte substring search of the source fails on text that
    renders perfectly. HTML collapses runs of whitespace, so this is the comparison that
    means what the Phase 5 gate wants it to mean, and the deploy-time check against the
    live page normalises the same way for the same reason.
    """
    without_tags = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", without_tags).strip()


@pytest.fixture()
def client():
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


# ------------------------------------------------------------------ routes and shape ---

def test_healthz_reports_a_version_and_a_fold_count(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "ok"
    # deploy.sh asserts the NEW version string here, so it must be present and non-empty.
    assert re.fullmatch(r"\d+\.\d+\.\d+", body["version"]), body["version"]
    assert body["folds"] >= 6


def test_gallery_lists_at_least_the_six_launch_folds(client):
    response = client.get("/api/gallery")
    assert response.status_code == 200
    folds = response.get_json()["folds"]
    assert len(folds) >= 6
    ids = {f["id"] for f in folds}
    assert {"trp_cage", "ww_domain", "villin_hp36",
            "protein_g_b1", "alpha3d", "ubiquitin"} <= ids


def test_gallery_index_does_not_ship_the_frames(client):
    """Cards are drawn before any trajectory is downloaded.

    On the launch gallery the difference is 686 kB against about 2 kB, and an index that
    quietly carried the frames would look completely correct and make the first paint
    three hundred times heavier.
    """
    payload = client.get("/api/gallery").get_data(as_text=True)
    assert "frames" not in payload
    assert "points" not in payload
    assert len(payload) < 20_000, f"the index is {len(payload)} bytes; it carries frames"


def test_a_fold_carries_everything_the_player_needs(client):
    fold = client.get("/api/fold/ubiquitin").get_json()
    assert fold["id"] == "ubiquitin"
    assert fold["residueCount"] == 76
    assert len(fold["sequence"]) == 76
    assert fold["engine"] == "go"
    assert len(fold["frames"]) >= 100
    for key in ("points", "newContacts", "ss", "rg", "q"):
        assert key in fold["frames"][0], f"a frame is missing {key}"
    assert len(fold["frames"][0]["points"]) == 3 * fold["residueCount"]


def test_an_unknown_fold_is_a_404_and_not_a_500(client):
    response = client.get("/api/fold/not_a_protein")
    assert response.status_code == 404
    assert "error" in response.get_json()


def test_a_fold_id_cannot_escape_the_cache_directory(client):
    """`../` in a path parameter is an ordinary-looking string until it is joined."""
    for hostile in ["..%2f..%2fapp", "....//app", "%2e%2e%2fapp"]:
        response = client.get(f"/api/fold/{hostile}")
        assert response.status_code in (404, 308, 400), hostile


# ------------------------------------------------------------------ caching -------------

def test_html_is_not_heuristically_cacheable(client):
    """Flask sends no Cache-Control on a template, and a browser then pins the page along
    with the ?v= asset URLs in it, so a deploy appears to do nothing."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-cache, must-revalidate"


def test_a_fold_is_long_cached(client):
    response = client.get("/api/fold/trp_cage")
    assert "max-age=31536000" in response.headers["Cache-Control"]
    assert "immutable" in response.headers["Cache-Control"]


def test_asset_urls_carry_a_content_hash(client):
    page = client.get("/").get_data(as_text=True)
    for asset in ["buttfold.css", "player.js"]:
        match = re.search(rf'{re.escape(asset)}\?v=([0-9a-f]+)', page)
        assert match, f"{asset} is referenced without a ?v= content hash"
        assert len(match.group(1)) == 8, f"{asset} hash looks wrong: {match.group(1)}"


def test_the_hash_changes_with_content_and_not_with_mtime(tmp_path):
    """Content, not mtime: a redeploy rewrites every mtime whether or not the bytes
    changed, which busts every cache on every deploy and teaches browsers nothing."""
    from buttfold import store

    path = tmp_path / "asset.css"
    path.write_text("a{}")
    first = store.content_hash(path)
    path.touch()
    assert store.content_hash(path) == first, "the hash moved when only the mtime did"
    path.write_text("a{color:red}")
    assert store.content_hash(path) != first, "the hash did not move when the bytes did"


# ------------------------------------------------------------------ the page ------------

def test_the_disclosure_line_reaches_the_page_not_only_the_source(client):
    """The amber line under the title is written by the JS at load, so the server-rendered
    HTML does not contain it and a grep of the template would pass while the page showed
    nothing. What is asserted here is that the element the JS writes into exists; the
    served-page check is done by tests/stage_screenshot.mjs in a real browser."""
    page = client.get("/").get_data(as_text=True)
    assert 'id="disclosure"' in page
    assert 'class="disclosure"' in page


def test_the_page_carries_the_verbatim_disclosure_strings():
    """These are quotations from the shipped app and are checked byte for byte, em dash
    included. The Phase 5 gate repeats this against a LIVE GET; this one is the cheap
    version that fails in CI before a deploy ever happens."""
    player = (REPO / "static/js/player.js").read_text()
    assert "Simulated on device toward a known structure — not a prediction" in player
    assert "Genie 2 invents a backbone from noise. Not a named protein" in player


def test_the_page_carries_the_disclosure_paragraph(client):
    text = visible_text(client.get("/").get_data(as_text=True))
    assert DISCLOSURE_PARAGRAPH in text, (
        "the disclosure paragraph on the page is not the approved wording")


def test_every_gallery_fold_gets_a_card(client):
    page = client.get("/").get_data(as_text=True)
    for fold in client.get("/api/gallery").get_json()["folds"]:
        assert f'data-fold-id="{fold["id"]}"' in page, f"{fold['id']} has no card"


def test_the_shop_window_never_implies_an_app_is_live_before_it_is(client):
    """PLAN section 8 and the trademark note in section 13: the honest state is the
    default, and a card with no store URL must say so rather than look live."""
    links = json.loads((REPO / "static/links.json").read_text())
    page = client.get("/").get_data(as_text=True)
    for app_entry in links["apps"]:
        if app_entry["app_store_url"] is None:
            assert app_entry["name"] in page
            assert "On the App Store" not in page.split(app_entry["name"])[1][:400], (
                f"{app_entry['name']} has no store URL but the page claims it is live")


# ------------------------------------------------------------------ the artefact --------

def test_every_baked_fold_actually_collapses():
    """The assertion that would have caught PhoneFold's thrown-away Watch bake. Repeated
    here against the COMMITTED artefact, not only inside the baker, because the baker is
    not run in CI and the committed file is what ships."""
    gallery = json.loads((REPO / "static/baked/gallery.json").read_text())
    assert len(gallery["folds"]) >= 6
    for fold in gallery["folds"]:
        quality = fold["quality"]
        ratio = quality["radiusOfGyrationEnd"] / quality["radiusOfGyrationStart"]
        assert ratio <= 0.8, f"{fold['id']}: Rg ratio {ratio:.2f}, this did not fold"
        total = quality["contactsFormed"]
        first = len(fold["frames"][0]["newContacts"])
        assert first / total < 0.25, (
            f"{fold['id']}: {first} of {total} contacts on frame 1, this starts folded")


def test_baked_frames_are_quantised_integers_inside_the_declared_box():
    gallery = json.loads((REPO / "static/baked/gallery.json").read_text())
    limit = gallery["quantisedRange"]
    for fold in gallery["folds"]:
        for index, frame in enumerate(fold["frames"]):
            assert all(isinstance(v, int) for v in frame["points"]), \
                f"{fold['id']} frame {index}: non-integer coordinate"
            assert max(abs(v) for v in frame["points"]) <= limit, \
                f"{fold['id']} frame {index}: coordinate outside the +/-{limit} box"


def test_exactly_one_frame_reaches_the_edge_of_the_box():
    """One scale per trajectory, taken from the widest frame. If every frame reached the
    edge the scale would be per-frame, which draws a coil and a folded core the same size
    and deletes the only thing the animation is about."""
    gallery = json.loads((REPO / "static/baked/gallery.json").read_text())
    limit = gallery["quantisedRange"]
    for fold in gallery["folds"]:
        extents = [max(abs(v) for v in frame["points"]) for frame in fold["frames"]]
        assert max(extents) == limit, f"{fold['id']}: no frame reaches the box edge"
        at_edge = sum(1 for e in extents if e >= limit - 1)
        assert at_edge <= 3, (
            f"{fold['id']}: {at_edge} of {len(extents)} frames sit at the box edge, which "
            f"is what per-frame normalisation looks like")


def test_secondary_structure_is_assigned_and_is_not_a_constant():
    """A baker with the SS code wired to the wrong frame, or not wired at all, shows up
    as a column of identical values. Two of the six folds are all-helix and two are
    mixed, so a real assignment cannot be constant across the gallery."""
    gallery = json.loads((REPO / "static/baked/gallery.json").read_text())
    finals = set()
    for fold in gallery["folds"]:
        encoded = fold["frames"][-1]["ss"]
        assert re.fullmatch(r"(\d+[HEC])+", encoded), f"{fold['id']}: bad run-length {encoded}"
        expanded = "".join(ch * int(num) for num, ch in re.findall(r"(\d+)([HEC])", encoded))
        assert len(expanded) == fold["residueCount"], f"{fold['id']}: SS length"
        finals.add(encoded)
        # And it must change over the trajectory: a coil at frame 0 is not the folded
        # structure's assignment.
        assert fold["frames"][0]["ss"] != encoded, \
            f"{fold['id']}: secondary structure never changed across the fold"
    assert len(finals) == len(gallery["folds"]), "two folds have identical secondary structure"


def test_q_rises_and_rg_falls_across_every_trajectory():
    gallery = json.loads((REPO / "static/baked/gallery.json").read_text())
    for fold in gallery["folds"]:
        frames = fold["frames"]
        assert frames[-1]["q"] > frames[0]["q"], f"{fold['id']}: Q did not rise"
        assert frames[-1]["rg"] < frames[0]["rg"], f"{fold['id']}: Rg did not fall"
        assert frames[-1]["q"] >= 900, \
            f"{fold['id']}: final Q is {frames[-1]['q'] / 1000}, below 0.9"
