"""The Phase 5 gate: the honesty strings are live, and the shop window cannot lie.

PLAN.md section 11: "the three verbatim disclosure strings and the approved disclosure
paragraph appear in a live GET of `/`; flipping a links.json field flips the card between
fallback and store badge in the served page."

Two of the three disclosure strings are written into the page by JavaScript at load, so a
GET of the HTML does not contain them and never will. Greping the served HTML for those
would pass forever while the page showed nothing, which is the exact failure this file
exists to prevent - so they are checked where they actually live (the shipped module, byte
for byte, em dash included) and their presence ON THE PAGE is asserted in a real browser by
`tests/stage_screenshot.mjs` and `tests/live_fold.mjs`.

The deploy-time version of this runs against `https://buttfold.mdeller.com/` with a plain
GET, not `curl -I`.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

LINKS = REPO / "static" / "links.json"

# Verbatim quotations from the shipped app. The em dash in the first is PhoneFold's, not
# ButtFold's: ButtFold's own prose uses none, and this is not ButtFold's own prose.
DISCLOSURE_GO = "Simulated on device toward a known structure — not a prediction"
DISCLOSURE_GENERATIVE = "Genie 2 invents a backbone from noise. Not a named protein"
DISCLOSURE_MORPH = "A smooth interpolation into the known structure. Not physics"

DISCLOSURE_PARAGRAPH = (
    "ButtFold shows a simple physics model relaxing a chain into a structure it already "
    "knows, and what a generative network's inventions look and sound like. It is not a "
    "prediction of an unknown structure, it is not a physical folding pathway, and no "
    "protein folds this way. The 150 poses in each trajectory are 50,000 integration steps "
    "apart, far enough that an atom can move further than the protein is wide between two "
    "of them; what you see in between is drawn to join them up, not computed, so the "
    "motion is smooth where the model is not. The music is a faithful map of the "
    "simulation's events, and nothing more."
)


def test_the_interpolation_is_disclosed_rather_than_left_implied():
    """Interpolation makes the animation smoother than the thing it is animating.

    A visitor watching a fluid, continuous fold would reasonably assume they were watching
    the model's own output at every instant, and between frames they are not: an alpha
    carbon moves up to 30 Angstroms between two of them and the pose in the middle is drawn
    rather than computed. PLAN section 7's rule is that the page says what it is doing where
    it is doing it, so the claim is pinned here the way the rest of them are.
    """
    assert "drawn to join them up, not computed" in DISCLOSURE_PARAGRAPH


def visible_text(html: str) -> str:
    """Tags stripped and whitespace collapsed: what a reader actually sees.

    Comments go too. The template explains in a comment why Apple's badge artwork is not
    used yet, and that comment contains the badge's own wording; a check that grepped the
    source would fail on its own documentation.
    """
    without_comments = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", without_comments)).strip()


def shop_link(html: str) -> str:
    """The header's PhoneFold link, which is what carries the advertisement now that the
    panel is gone. Scoped exactly rather than by a text window: a window that overshoots
    reads whatever follows, and an earlier version of this test did exactly that."""
    start = html.index('class="shop-link"')
    end = html.index("</a>", start)
    return html[start:end]


@pytest.fixture()
def client():
    import app as web

    web.app.config["TESTING"] = True
    with web.app.test_client() as c:
        yield c


def test_the_engine_claim_is_still_made_on_the_stage():
    """Marc removed the amber line under the title on 2026-09-01. The CLAIM did not go.

    PLAN section 7 asked for the app's verbatim strings in that position; they are no longer
    on the page. What remains is the badge, which states the engine and where it ran in the
    stage's own corner and never scrolls away while anything plays, and the disclosure
    paragraph below the gallery, which says it in full as body text. Two placements rather
    than three, and this asserts the badge still names both engines: a generative entry must
    never be able to appear labelled as a Gō fold.
    """
    player = (REPO / "static" / "js" / "player.js").read_text(encoding="utf-8")
    assert "toward a known structure" in player, "the badge no longer says what the Gō model does"
    assert "invented from noise" in player, "the badge no longer distinguishes a generative entry"
    assert "precomputed" in player and "in your browser" in player and "on the server" in player, (
        "the badge no longer says where the fold was computed")
    # And the line really is gone, rather than hidden.
    assert DISCLOSURE_GO not in player


def test_the_morph_disclosure_is_absent_because_no_morph_engine_ships():
    """PLAN section 7 lists it "if and when a morph engine is added; not in scope for v1".

    Asserted absent rather than ignored: a disclosure for an engine that does not exist
    would be the page describing something it does not do, which is its own kind of
    dishonesty, and this test fails the day someone adds the string without the engine.
    """
    player = (REPO / "static" / "js" / "player.js").read_text(encoding="utf-8")
    assert DISCLOSURE_MORPH not in player


def test_the_disclosure_paragraph_is_in_the_served_page(client):
    text = visible_text(client.get("/").get_data(as_text=True))
    assert DISCLOSURE_PARAGRAPH in text, "the served paragraph is not the approved wording"


def test_the_disclosure_paragraph_is_body_text_and_not_behind_a_link(client):
    """A web page reaches people with no context, so this must not be a "learn more"."""
    html = client.get("/").get_data(as_text=True)
    block = html[html.index('class="honesty"'):]
    block = block[:block.index("</div>")]
    assert "<a " not in block, "the disclosure paragraph is inside a link"
    assert "<details" not in block and "hidden" not in block


def test_the_engine_badge_element_is_present_and_says_where(client):
    """The badge never scrolls away while the animation runs, so it is inside the stage."""
    html = client.get("/").get_data(as_text=True)
    stage = html[html.index('class="stage-wrap"'):]
    stage = stage[:stage.index("</div>\n\n")] if "</div>\n\n" in stage else stage[:2000]
    assert 'id="badge-engine"' in stage
    assert 'id="badge-where"' in stage


# ------------------------------------------------------------------ the shop window -----

def test_the_phonefold_link_is_still_driven_by_the_data(client):
    """The shop panel was removed on 2026-09-01 and the header link carries the
    advertisement instead. It is still driven by links.json, so the before/after-live
    mechanism survives: setting an app_store_url flips it with no template edit."""
    links = json.loads(LINKS.read_text())
    entry = next(a for a in links["apps"] if a["id"] == "phonefold")
    page = client.get("/").get_data(as_text=True)
    assert "PhoneFold" in visible_text(page)
    assert (entry["app_store_url"] or entry["fallback_url"]) in page


def test_no_app_is_shown_as_live_before_it_is(client):
    """The honest state is the default. PLAN section 8 and the trademark note in 13."""
    links = json.loads(LINKS.read_text())
    text = visible_text(client.get("/").get_data(as_text=True))
    if all(entry["app_store_url"] is None for entry in links["apps"]):
        assert "Download on the App Store" not in text, (
            "the page offers an App Store download while no app has a store URL")


def test_apples_badge_wording_is_only_used_with_a_real_store_url(client):
    """Apple's badge may only be shown for an app that is actually on the store.

    Checked on the VISIBLE text, not the raw HTML: the template carries a comment
    explaining why the badge artwork is not used yet, and that comment contains the phrase.
    A test that greps the source would fail on its own documentation.
    """
    html = client.get("/").get_data(as_text=True)
    text = visible_text(html)
    if "Download on the App Store" in text:
        assert "apps.apple.com" in html, (
            "the App Store badge wording appears with no store URL behind it")


def test_flipping_links_json_flips_the_card_with_no_code_change(client, monkeypatch,
                                                               tmp_path):
    """The mechanism PLAN section 8 is built on: before/after live is data, not code.

    Verified by diffing two GETs of the same page with only the JSON changed, which is
    exactly what the deploy-time check does against the live site.
    """
    import app as web

    before_html = client.get("/").get_data(as_text=True)
    before = visible_text(before_html)
    entry = next(a for a in json.loads(LINKS.read_text())["apps"] if a["id"] == "phonefold")
    assert entry["app_store_url"] is None, "PhoneFold now has a store URL; update this test"
    assert entry["fallback_url"] in shop_link(before_html)

    links = json.loads(LINKS.read_text())
    for entry in links["apps"]:
        if entry["id"] == "phonefold":
            entry["app_store_url"] = "https://apps.apple.com/app/id1234567890"
    flipped = tmp_path / "links.json"
    flipped.write_text(json.dumps(links))

    original = web.REPO

    class Redirected:
        """`REPO / "static" / "links.json"` resolved to the flipped copy, and nothing else
        touched: the point is that ONLY the data changed."""

        def __truediv__(self, part):
            return original / part if part != "static" else _Static()

    class _Static:
        def __truediv__(self, part):
            return flipped if part == "links.json" else original / "static" / part

    monkeypatch.setattr(web, "REPO", Redirected())
    after = visible_text(client.get("/").get_data(as_text=True))

    after_html = client.get("/").get_data(as_text=True)
    after = visible_text(after_html)
    link = shop_link(after_html)
    assert "apps.apple.com/app/id1234567890" in link, "the link did not flip to the store"
    assert "on the App Store" in link, "the wording did not change with the link"
    assert before != after, "changing links.json changed nothing in the served page"
    # Only the card changed. A flip that rewrote the page around it would pass every
    # assertion above and be the wrong mechanism, so the rest of the page is compared for
    # equality with the card's own block cut out of both.
    def without_the_link(html: str) -> str:
        head = html[:html.index('class="shop-link"')]
        tail = html[html.index("</a>", html.index('class="shop-link"')):]
        return visible_text(head + tail)

    assert without_the_link(before_html) == without_the_link(after_html), (
        "flipping one links.json field changed the page outside the PhoneFold link")


def test_the_stage_badge_carries_the_status_so_it_cannot_contradict_itself(client):
    """Engine, place and what is happening, in one line.

    The status used to be a separate paragraph under the transport, which could say
    "folding on the server" while the badge two hundred pixels above still said
    "precomputed": two lines making different claims about the same fold. They are now one
    element, and `_status` in player.js is the only thing that writes there, setting the
    place at the same time.
    """
    page = client.get("/").get_data(as_text=True)
    badge = page[page.index('class="stage-badge"'):]
    badge = badge[:badge.index("</div>")]
    for element in ('id="badge-engine"', 'id="badge-where"', 'id="live-status"'):
        assert element in badge, f"{element} is not inside the stage badge"

    player = (REPO / "static/js/player.js").read_text()
    # Exactly one thing may write the status, and it is `_status`, which sets the place at
    # the same time. Any second writer is how the two got out of step in the first place.
    writes = player.count("$('live-status').textContent")
    assert writes == 1, (
        f"{writes} places write the status directly; only _status may, so that the place "
        f"beside it is always set with it")
    definition = player[player.index("_status(text, where = null)"):]
    assert "$('live-status').textContent" in definition[:400], (
        "the one direct write is not the one inside _status")
    # And it is used, rather than being a wrapper nothing calls.
    assert player.count("this._status(") >= 8
