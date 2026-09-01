#!/usr/bin/env python3
"""Who calls this? Anything declared and never reached fails the build.

PLAN.md section 10, item 1. PhoneFold hit the same failure four times in two days: a
feature split across two places, one half complete and authoritative-looking, the other
never reached, invisible to the build and to every test. Three of the four were found by
asking "who calls this". So ButtFold asks automatically, in CI and at every phase gate.

What is checked:

1. Every Flask route in `app.py` is referenced by a template or a JS file (or is listed as
   deliberately unreferenced, with a reason).
2. Every JS module in `static/js/` is imported by the page, by a worker, or by another
   module that is itself reachable.
3. Every style JSON in `static/styles/` is offered by the style pill.
4. Every fold id in `gallery.json` has a card in the template's gallery loop.
5. Every app id in `links.json` is rendered by the shop window.
6. Every id the JS looks up with getElementById exists in the template.

Item 6 is the one that catches the most: a renamed element leaves the JS reading `null` and
failing silently at the first property access, which in a `requestAnimationFrame` loop is a
console message nobody sees.

    tools/audit_wiring.py            human output, exit 1 on any failure
    tools/audit_wiring.py --json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "app.py"
TEMPLATES = REPO / "templates"
JS_DIR = REPO / "static" / "js"
STYLES = REPO / "static" / "styles"
GALLERY = REPO / "static" / "baked" / "gallery.json"
LINKS = REPO / "static" / "links.json"

# Modules that exist and are tested before the thing that imports them is built. Each entry
# names the file that WILL import it, and the allowance holds only while that file does not
# exist yet: the moment its declared consumer lands, this stops excusing anything and the
# module must genuinely be imported. An allowlist that cannot expire is a place for things
# to hide forever, which is the failure this whole tool exists to catch.
#
# It has fired once already, correctly: ContactTracker.js sat here through Phase 2 and the
# entry lapsed by itself the moment static/js/fold_worker.js was written in Phase 3.
PENDING_CONSUMERS: dict[str, tuple[str, str]] = {}

# Routes that nothing links to on purpose, each with the reason it is still reachable.
# A route may only appear here with a justification; "unused" is not one.
DELIBERATELY_UNLINKED = {
    "/healthz": "the launcher's health check and deploy.sh call it; no page links to it",
    "/favicon.ico": "requested by the browser from the <link> the framework injects, not by us",
    "/api/gallery": "the JSON index; the page is server-rendered so only external callers "
                    "and the tests use it, and it is part of the documented API",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def all_text(*globs: tuple[Path, str]) -> str:
    chunks = []
    for root, pattern in globs:
        if root.exists():
            for path in sorted(root.rglob(pattern)):
                chunks.append(read(path))
    return "\n".join(chunks)


def check_routes(problems: list[str], report: dict) -> None:
    source = read(APP)
    routes = re.findall(r'@app\.route\(\s*["\']([^"\']+)["\']', source)
    haystack = all_text((TEMPLATES, "*.html"), (JS_DIR, "*.js"), (REPO / "tests", "*.mjs"))
    unreferenced = []
    for route in routes:
        # `/api/fold/<fold_id>` is referenced in JS as a template literal, so compare on the
        # static prefix before the first parameter rather than on the whole pattern.
        prefix = route.split("<")[0].rstrip("/") or "/"
        if prefix == "/":
            continue                      # the page itself; the server root is always reached
        if prefix in haystack:
            continue
        if route in DELIBERATELY_UNLINKED:
            continue
        unreferenced.append(route)
    report["routes"] = {"declared": routes, "unreferenced": unreferenced}
    for route in unreferenced:
        problems.append(f"route {route} is declared in app.py and referenced by nothing")


def check_js_modules(problems: list[str], report: dict) -> None:
    modules = sorted(p.name for p in JS_DIR.glob("*.js")) if JS_DIR.exists() else []
    entry_points = set()
    for template in TEMPLATES.glob("*.html"):
        # `/static/v-<build>/js/player.js` as well as the plain form: the front end is
        # versioned by a path segment so that an ES module's relative imports inherit the
        # version. Without the optional segment here the audit reported the entire module
        # graph as dead code the moment that landed.
        # The version segment is a Jinja placeholder in the template source
        # (`/static/v-{{ build }}/js/...`), not a rendered hash, so the pattern has to
        # accept anything up to the next slash. Matching only `[0-9a-f]+` here found
        # nothing and reported the whole module graph as dead code.
        for match in re.findall(r'/static/(?:v-[^/]+/)?js/([A-Za-z0-9_.-]+\.js)',
                                read(template)):
            entry_points.add(match)
    # A worker is a second entry point, and it is loaded by URL rather than imported, so the
    # import graph alone never reaches it. Missing this made the audit report the whole live
    # path - the worker and everything it pulls in - as dead code.
    for path in sorted(JS_DIR.glob("*.js")):
        # Backticks too: the worker's URL is a template literal now, because it carries the
        # build version. A regex that only knew about quotes reported the live fold's whole
        # module graph as unreachable.
        for match in re.findall(
                r"""new\s+Worker\(\s*[`'"][^`'"]*?/([A-Za-z0-9_.-]+\.js)[`'"]""",
                read(path)):
            entry_points.add(match)

    # Walk the import graph from the entry points, so a module imported only by another
    # module still counts as reached.
    reached, queue = set(), list(entry_points)
    while queue:
        name = queue.pop()
        if name in reached:
            continue
        reached.add(name)
        path = JS_DIR / name
        if not path.exists():
            problems.append(f"{name} is loaded by a template but does not exist in static/js/")
            continue
        for target in re.findall(r"""from\s+['"]\./([A-Za-z0-9_.-]+\.js)['"]""", read(path)):
            queue.append(target)

    orphans, waiting = [], []
    for module in modules:
        if module in reached:
            continue
        pending = PENDING_CONSUMERS.get(module)
        if pending and not (REPO / pending[0]).exists():
            waiting.append(f"{module} (awaiting {pending[0]}: {pending[1]})")
            continue
        orphans.append(module)
    report["js"] = {"modules": modules, "entryPoints": sorted(entry_points),
                    "reached": sorted(reached), "orphans": orphans, "waiting": waiting}
    for module in orphans:
        pending = PENDING_CONSUMERS.get(module)
        if pending:
            problems.append(
                f"static/js/{module} is shipped and imported by nothing, and its declared "
                f"consumer {pending[0]} now exists. Wire it up or remove the entry from "
                f"PENDING_CONSUMERS.")
        else:
            problems.append(f"static/js/{module} is shipped and imported by nothing")


def check_element_ids(problems: list[str], report: dict) -> None:
    template_ids = set()
    for template in TEMPLATES.glob("*.html"):
        template_ids |= set(re.findall(r'\bid="([A-Za-z0-9_-]+)"', read(template)))

    wanted: dict[str, str] = {}
    for path in sorted(JS_DIR.glob("*.js")):
        text = read(path)
        for element_id in re.findall(r"""getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]""", text):
            wanted[element_id] = path.name
        # `$('name')` is the file's own shorthand for getElementById.
        for element_id in re.findall(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""", text):
            wanted[element_id] = path.name

    missing = sorted(f"{i} (wanted by {src})" for i, src in wanted.items()
                     if i not in template_ids)
    report["elementIds"] = {"wanted": sorted(wanted), "inTemplate": sorted(template_ids),
                            "missing": missing}
    for entry in missing:
        problems.append(f"the JS looks up an element id that no template defines: {entry}")


def check_styles(problems: list[str], report: dict) -> None:
    styles = sorted(p.stem for p in STYLES.glob("*.json")) if STYLES.exists() else []
    haystack = all_text((TEMPLATES, "*.html"), (JS_DIR, "*.js"))
    # Phase 2 adds the style pill. Until it exists, an unreferenced style is expected and
    # is reported rather than failed: failing here would mean the audit could not be wired
    # into the Phase 1 gate at all, and an audit that is not run catches nothing.
    pill_exists = 'id="style-mode"' in haystack
    unreferenced = [s for s in styles if s not in haystack]
    report["styles"] = {"present": styles, "pillExists": pill_exists,
                        "unreferenced": unreferenced}
    if pill_exists:
        for style in unreferenced:
            problems.append(f"static/styles/{style}.json is shipped and the style pill "
                            f"does not offer it")


def check_gallery_cards(problems: list[str], report: dict) -> None:
    if not GALLERY.exists():
        problems.append("static/baked/gallery.json is missing: run tools/bake_gallery.py")
        return
    folds = [f["id"] for f in json.loads(read(GALLERY))["folds"]]
    template = read(TEMPLATES / "index.html")
    # The cards are generated by a Jinja loop over the server-rendered gallery, so what is
    # checked is that the loop exists and emits the id as data-fold-id, not that each id is
    # spelled out. A missing loop is the failure this catches.
    loop_present = ("data-fold-id=\"{{ fold.id }}\"" in template
                    and "for fold in gallery" in template)
    report["gallery"] = {"folds": folds, "cardLoopPresent": loop_present}
    if not loop_present:
        problems.append("the template has no gallery card loop emitting data-fold-id, so "
                        f"{len(folds)} baked folds are unreachable from the page")
    if not folds:
        problems.append("gallery.json contains no folds")


def check_links(problems: list[str], report: dict) -> None:
    if not LINKS.exists():
        problems.append("static/links.json is missing")
        return
    apps = [a["id"] for a in json.loads(read(LINKS))["apps"]]
    template = read(TEMPLATES / "index.html")
    loop_present = "for app in links.apps" in template
    report["links"] = {"apps": apps, "shopLoopPresent": loop_present}
    if not loop_present:
        problems.append("the template has no shop-window loop over links.apps, so "
                        f"{len(apps)} app cards are unreachable from the page")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    problems: list[str] = []
    report: dict = {}
    check_routes(problems, report)
    check_js_modules(problems, report)
    check_element_ids(problems, report)
    check_styles(problems, report)
    check_gallery_cards(problems, report)
    check_links(problems, report)

    if args.json:
        print(json.dumps({"problems": problems, "report": report}, indent=1))
        return 1 if problems else 0

    print(f"routes       {len(report['routes']['declared'])} declared, "
          f"{len(report['routes']['unreferenced'])} unreferenced")
    print(f"js modules   {len(report['js']['modules'])} shipped, "
          f"{len(report['js']['reached'])} reached from the page, "
          f"{len(report['js']['orphans'])} orphaned, "
          f"{len(report['js']['waiting'])} awaiting a declared consumer")
    for entry in report["js"]["waiting"]:
        print(f"             . {entry}")
    print(f"element ids  {len(report['elementIds']['wanted'])} wanted by JS, "
          f"{len(report['elementIds']['missing'])} missing from the template")
    print(f"styles       {len(report['styles']['present'])} present, pill "
          f"{'exists' if report['styles']['pillExists'] else 'not built yet (Phase 2)'}, "
          f"{len(report['styles']['unreferenced'])} unreferenced")
    print(f"gallery      {len(report['gallery'].get('folds', []))} folds, card loop "
          f"{'present' if report['gallery'].get('cardLoopPresent') else 'MISSING'}")
    print(f"links        {len(report['links'].get('apps', []))} apps, shop loop "
          f"{'present' if report['links'].get('shopLoopPresent') else 'MISSING'}")

    if problems:
        print("\nFAIL")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("\nPASS: everything declared is reached")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
