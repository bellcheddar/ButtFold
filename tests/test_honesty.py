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
    "protein folds this way. The music is a faithful map of the simulation's events, and "
    "nothing more."
)


def visible_text(html: str) -> str:
    """Tags stripped and whitespace collapsed: what a reader actually sees.

    Comments go too. The template explains in a comment why Apple's badge artwork is not
    used yet, and that comment contains the badge's own wording; a check that grepped the
    source would fail on its own documentation.
    """
    without_comments = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", without_comments)).strip()


def featured_block(html: str) -> str:
    """Just the featured app's card. Scoped exactly, because the "More from Marc" row below
    it legitimately contains other apps that ARE still in review, and a text window that
    overshoots into them tests the wrong card."""
    start = html.index('class="shop-feature"')
    end = html.index('class="section-head"', start)
    return visible_text(html[start:end])


@pytest.fixture()
def client():
    import app as web

    web.app.config["TESTING"] = True
    with web.app.test_client() as c:
        yield c


def test_the_engine_disclosures_are_byte_for_byte_the_apps_own():
    """Quotations, so they are compared exactly. A paraphrase is a different claim."""
    player = (REPO / "static" / "js" / "player.js").read_text(encoding="utf-8")
    assert DISCLOSURE_GO in player
    assert DISCLOSURE_GENERATIVE in player
    # The em dash is load-bearing: it is what makes this a quotation rather than a rewrite.
    assert "—" in DISCLOSURE_GO
    assert player.count(DISCLOSURE_GO) == 1, "the string is duplicated and can drift"


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

def test_no_app_is_shown_as_live_before_it_is(client):
    """The honest state is the default. PLAN section 8 and the trademark note in 13."""
    links = json.loads(LINKS.read_text())
    text = visible_text(client.get("/").get_data(as_text=True))
    for entry in links["apps"]:
        assert entry["name"] in text, f"{entry['name']} is missing from the page"
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
    assert "In review at the App Store" in featured_block(before_html)

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
    card = featured_block(after_html)
    assert "Download on the App Store" in card, "the store link did not appear on the card"
    assert "In review at the App Store" not in card, "the card still says it is in review"
    assert "apps.apple.com/app/id1234567890" in after_html, "the store URL is not linked"
    assert before != after, "changing links.json changed nothing in the served page"
    # The other apps, which did NOT change, must be untouched: a flip that rewrote the whole
    # shop window would pass the assertions above and be the wrong mechanism.
    assert "JUMPjet" in after and "In review at the App Store" in after
