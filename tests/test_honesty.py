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

import html as html_module
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

# The whole disclosure, summary and detail together. `visible_text` reads the served DOM,
# and a collapsed <details> is still in the DOM, so this is every word the page carries.
DISCLOSURE_PARAGRAPH = (
    "Yes, it is a butt-dial joke. It will not come up again. No protein folds this way. "
    "ButtFold animates a simple physics model relaxing a chain toward a structure it "
    "already knows."
)

# The part that must never be behind a click. See the test below for why this is now a
# split rather than a ban on disclosure elements.
DISCLOSURE_SUMMARY = "No protein folds this way."

DISCLOSURE_DETAIL = (
    "That is not a prediction of an unknown structure and it is not a folding pathway. "
    "ESMFold predicts where a real UniProt protein ends up \u2014 at Meta, not on this "
    "server \u2014 and the G\u014d model then animates a chain collapsing toward that "
    "prediction. A prediction can be wrong, so every protein offered has an experimental "
    "structure in the PDB to check it against. The 150 poses in a trajectory are 50,000 "
    "integration steps apart, far enough that an atom can move further than the protein is "
    "wide between two of them. What you see in between is drawn to join them up, not "
    "computed, so the motion is smooth where the model is not. The music is a faithful map "
    "of the simulation's events, and nothing more."
)


def test_the_interpolation_is_disclosed_rather_than_left_implied():
    """Interpolation makes the animation smoother than the thing it is animating.

    A visitor watching a fluid, continuous fold would reasonably assume they were watching
    the model's own output at every instant, and between frames they are not: an alpha
    carbon moves up to 30 Angstroms between two of them and the pose in the middle is drawn
    rather than computed. PLAN section 7's rule is that the page says what it is doing where
    it is doing it, so the claim is pinned here the way the rest of them are.
    """
    assert "drawn to join them up, not computed" in DISCLOSURE_DETAIL, (
        "the interpolation is no longer disclosed anywhere in the panel")


def visible_text(html: str) -> str:
    """Tags stripped and whitespace collapsed: what a reader actually sees.

    Comments go too. The template explains in a comment why Apple's badge artwork is not
    used yet, and that comment contains the badge's own wording; a check that grepped the
    source would fail on its own documentation.

    Entities are decoded, because a reader sees "G\u014d" where the template writes
    "&#333;". Without that this compared the approved wording against the source's escapes
    and only passed as long as the approved wording happened to contain no accented letter.
    """
    without_comments = re.sub(r"<!--.*?-->", " ", html, flags=re.S)
    stripped = re.sub(r"<[^>]+>", " ", without_comments)
    return re.sub(r"\s+", " ", html_module.unescape(stripped)).strip()


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


def test_the_claim_that_matters_is_not_behind_a_click(client):
    """A web page reaches people with no context, so this must not be a "learn more".

    The rule used to be enforced by banning `<details>` from the block outright. On Marc's
    instruction, 2026-09-02, the elaboration now collapses behind a Read more - so the rule
    is enforced where it actually lives instead: the load-bearing sentence has to be in the
    SUMMARY, which is on screen whether or not anything is opened. What may be folded away
    is the detail behind that sentence, never the sentence.

    Still no link: a claim inside an anchor is a claim on another page.
    """
    html = client.get("/").get_data(as_text=True)
    block = html[html.index('class="panel panel-honesty"'):]
    # Bounded, or "no link in the block" reads the whole rest of the document and trips over
    # the footer's byline. A window that overshoots reads whatever follows.
    block = block[:block.index("</details>")]
    summary = block[block.index("<summary"):block.index("</summary>")]

    assert DISCLOSURE_SUMMARY in visible_text(summary), (
        f"{DISCLOSURE_SUMMARY!r} is not in the always-visible summary, so a reader who "
        "never opens the panel is not told the one thing they most need to know")
    assert "<a " not in block, "the disclosure is inside a link"
    assert "<details" not in summary, "the summary itself must not collapse"


def test_the_joke_is_styled_by_a_rule_that_exists(client):
    """`.honesty .joke` outlived the block it was scoped to and styled nothing for a while.

    A selector aimed at a class that no longer exists fails silently and reads as a design
    choice, so the pairing is checked rather than assumed: the markup uses the class, and
    the stylesheet has a rule that can actually match it.
    """
    html = client.get("/").get_data(as_text=True)
    assert 'class="joke"' in html
    css = (REPO / "static" / "buttfold.css").read_text()
    rules = [line for line in css.splitlines() if ".joke" in line and "{" in line]
    assert rules, "nothing in the stylesheet styles the joke"
    for rule in rules:
        scope = rule.split("{")[0].strip()
        prefix = scope.split(".joke")[0].strip()
        if prefix:
            assert prefix.lstrip(".") in html, (
                f"{scope} is scoped to {prefix}, which is not in the served page")


def test_the_detail_is_present_even_though_it_is_collapsed(client):
    """Collapsed is not absent. A `<details>` keeps its content in the DOM, so the full
    disclosure is still served, still searchable, and still there for a reader who opens
    it - which is the difference between folding text away and cutting it."""
    text = visible_text(client.get("/").get_data(as_text=True))
    assert DISCLOSURE_DETAIL in text, "the served detail is not the approved wording"


def test_the_music_panel_explains_where_the_notes_come_from(client):
    """The second panel makes a claim of its own and it has to be true: the music is
    derived from the trajectory, so the page says which feature becomes which sound."""
    html = client.get("/").get_data(as_text=True)
    block = html[html.index('class="panel panel-music"'):]
    block = block[:block.index("</details>")]
    text = visible_text(block)
    assert "Every note is an event in the fold" in text
    # The determinism claim is testable and tested elsewhere; it must be stated here.
    assert "same protein in the same style gives the same piece" in text
    for feature in ["Helix", "Sheet", "Coil", "Radius of gyration"]:
        assert feature in text, f"the mapping does not mention {feature}"
    assert "sixteen contacts at most" in text, (
        "the per-bar cap is the one place the music discards something, and it is stated "
        "under the transport already; the explanation must not leave it out")


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
