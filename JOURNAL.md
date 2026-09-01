# ButtFold: journal

Append only. One entry per work session. Newest last.

## 2026-09-01, session 1: Phase 0 begins

Repo created at `~/Documents/Vibe_Coding/ButtFold`, `git init`, skeleton per PLAN.md
section 5.1. `PLAN.md` is `BUTTFOLD_PLAN.md` copied to the root as the read-only reference.

Vendored, each with a provenance header naming the source repo and commit
`6f44c8a1ac7684da93668a580b29cbe9a67cfc5e`:

- `native/go_model_fold.c`, the 298-line Gō model, unedited below the header.
- `static/styles/*.json`, the five style profiles, byte-identical.
- `data/natives/*.json`, the six launch proteins' native CA traces and sequences,
  extracted by `tools/extract_natives.py` from the **final** readout of each `.pftraj`.
  The ESMFold trajectory itself is deliberately not taken; only its endpoint, as the Gō
  potential's global minimum.

`tools/coil.py` ports `random_coil` and `_place` behaviourally rather than importing them,
per the no-cross-repo-paths rule. First check that it ports correctly: ubiquitin's coil at
seed 1 has Rg 21.3 Å, which is exactly the `radiusOfGyrationStart` PhoneFold recorded for
the same protein and seed. Trp-cage 9.5 Å, ubiquitin 21.3 Å, against the Kohn denatured
scaling of 12.1 Å and 24.4 Å: below it, as a self-avoiding walk with a hard clash radius
should be at these chain lengths.

P0-1 launched on both machines with identical commands, so the droplet ratio is measured
and not assumed. Steps are `100000 * n` (the app's real setting), not the flat 2,000,000
in PLAN section 3, because the M1 Max reference times being compared against were taken at
`100000 * n`; comparing 2 M droplet steps against 7.6 M Mac steps would have produced a
speed ratio that was wrong by a factor of four and looked entirely plausible.

### Phase 0 measurements

**P0-1 answered the only architecture with a kill condition, and B lives.** trp-cage folds
on the droplet in 16.6 s and ubiquitin in 7 min 07 s, against 5.2 s and 143.8 s for the
identical command on the M1 Max: a measured ratio of 3.17x and 2.97x, inside the 2.5 to 4x
that PLAN section 3 guessed. Both are inside the decision rule's thresholds, so B ships on
demand with the residue cap at 76. Peak RSS was 2.4 MB, so the 3.9 GB box is not the
constraint; CPU time is, and one `nice -n 19` worker bounds it.

The steps were `100000 * n`, not the flat 2,000,000 PLAN section 3 wrote, because the M1 Max
reference times being compared against were taken at `100000 * n`. Comparing 2 M droplet
steps against 7.6 M Mac steps would have given a speed ratio wrong by a factor of four and
entirely plausible-looking.

**P0-3 passes, and the RMSD half of its bar turned out to be unmeetable by anything.** The
forces agree bitwise on trp-cage and to 2.9e-15 relative on protein G, six orders inside the
1e-9 bar. Q agrees to 0.007 against a bar of 0.02. RMSD came out 0.123 Å apart on protein G
against a bar of 0.1 Å, so before touching the bar, P0-3b measured what RMSD does when
nothing is wrong: same build, same coil, five random-force seeds, RMSD from 0.84 to 1.16 Å,
sd 0.14 Å, while Q was 0.993 on all five. The 0.1 Å bar is narrower than the measurement's
own noise floor. Q is the endpoint metric that means something for a chaotic trajectory in a
funnel; RMSD is not. Bar restated on measurement, logged in BLOCKERS.md.

**Two bugs found, both by artefacts rather than by tests.**

The first: `emcc -s MODULARIZE=1` emits a UMD factory with no ES `export default`, so
`import createGoModel from ...` throws in a browser. The node test did not catch it, because
node loaded the same file as CommonJS and found the factory on `module.exports`. One
artefact, two loaders, one of them lying. Found only when a real browser loaded it. Fixed
with `EXPORT_ES6=1` and a `.mjs`.

The second is not a bug in ButtFold but a fact about browsers that changes the design.
**A browser suspends a fold it cannot see.** The first P0-2 harness folded on the main
thread and yielded with `setTimeout`. Safari then sat at 0% CPU in every WebContent process
and never finished, which from outside is indistinguishable from "Safari cannot run the
module" - one of the two answers P0-2 exists to choose between, and the wrong one. Chrome
does a weaker version: 7.33 s foreground, 13.85 s background, same fold, same browser,
minutes apart. Moving the fold into a Web Worker fixed Chrome and did **not** fix Safari,
which suspends the worker too. Phase 3 has to handle a visitor switching tabs.

`tests/module_parity.test.mjs` came out of that: the streaming API in `native/wasm_api.c`
reproduces the CLI's trajectory bitwise, all 101 frames and 6,060 coordinate components, so
the two frame sources the player will accept are provably the same program.

Phase 0 is complete except for two rows that need Marc: Safari's protein G number (this Mac
was at the login window, which is why Safari suspended everything) and mobile Safari on his
iPhone. Neither blocks Phase 1, so Phase 1 starts.

### Phase 1 and Phase 2

Phase 1 shipped the baked gallery: six Gō folds, every assertion green, 150 frames each,
Flask serving them with the Cache-Control gotcha handled in code, and a three.js ribbon
coloured helix magenta and sheet cyan. The two bugs it turned up are both worth keeping:

`emcc -s MODULARIZE=1` emits a UMD factory with no ES `export default`, so the browser
import threw while the node test passed by loading the same file as CommonJS. One artefact,
two loaders, one of them lying, and only a real browser found it.

Then a `CatmullRomCurve3` built from coincident control points has zero length, so
`TubeGeometry`'s Frenet frames come out NaN, the bounding sphere computed from them is NaN,
and three.js frustum-culls the mesh for the rest of its life. The page rendered perfectly:
header, title, amber disclosure line, live readouts showing Rg 7.1 and helix 35%, and an
entirely empty stage. Found by the screenshot gate asserting non-uniformity, which is the
whole reason that rule exists.

Phase 2 is the one that mattered. `tools/swift_score_dump/` is a throwaway SwiftPM package
that depends on PhoneFoldKit **by path** and runs the shipped `FoldAudio.Sonifier` over
ButtFold's own committed gallery. Its output is the fixture. `Sonifier.js` then reproduces
it note for note: 15,536 notes, two folds, all five styles, zero differences in voice,
pitch, velocity, residue, partner, beat offset or duration. A JS sonifier tested against a
JS fixture would have proved only that it had not changed.

Getting there needed one thing that is easy to dismiss as pedantry and is not: **Float32 is
emulated with `Math.fround` wherever the Swift uses `Float`.** Mean confidence accumulates
over 76 residues in single precision on the phone, and computing the same mean in a double
reaches the output through `velocity` (30 + 90q, truncated) and through the plateau
detector's tolerance, where a few ulps decide whether the piece cadences on this bar or the
next. The same applies to the radius of gyration: the dumper was changed to hand the
Sonifier the artefact's *recorded* Rg rather than recomputing it from rescaled coordinates,
because the round trip lands a few ulps away and `compaction` is sensitive enough for that
to reach the tempo.

Two honest numbers came out of it. Ubiquitin loses 1,697 of its 3,050 contact formations to
the sixteen-per-moment cap, which is the shipped app's behaviour and therefore what parity
means; the page states it in a line under the transport rather than just sounding thin. And
`tests/audio_smoke.mjs` exists because the parity test proves the score is right and says
nothing about whether it reaches an AudioContext - a sonifier wired to nothing is silent and
passes every unit test. It drives the real page, clicks Play as a genuine gesture, and
measures the context running, the clock advancing 2.45 s in 2.5 s, the animation following
that clock rather than its own, and a style switch keeping its place instead of restarting.

Phase 2's machine gate is met. Its human gate - does it sound right - is Marc's and is left
open.

### Phase 3: the live fold

A browser now folds a real protein. Headless Chrome reaches Q 1.000 on trp-cage in 7.6 s
and streams 152 frames into the same player the gallery uses; the stage badge says "in your
browser" while it does, so a visitor can tell where the computation happened.

The piece of design that mattered is `static/js/frames.js`: **one** frame builder, shared by
every source. Without it the baker, the worker and the queue would each have their own
notion of what a frame is, and the gate - byte-identical frame objects from the same
trajectory - would have had nothing to compare. Getting to zero differences turned up three
cross-language traps, all invisible in the artefact and all fatal to a byte comparison:
JavaScript's `Math.round(-0.2)` is `-0` where Python's is `0`; NumPy breaks ties to even
where `Math.round` breaks them upward, which showed up as 238 against 239 on a coordinate
that landed on exactly 238.5; and `angstromsPerUnit` had been written rounded to six decimal
places, which is a relative error of 3e-5 and quite enough to move a coordinate one unit. A
ruler rounded for tidiness is not a ruler.

The one thing the two paths do NOT agree on is the contact count: 806 live against 858
baked. They sample the trajectory at slightly different times, and a contact that forms and
breaks between two sampled frames is invisible to whichever path did not look then. Neither
number is the true one, because "how many contacts formed" is a property of how often you
look. Recorded in METRICS rather than smoothed over.

`tools/audit_wiring.py` earned its keep twice in this phase. Its self-expiring allowance for
`ContactTracker.js` lapsed by itself the moment `fold_worker.js` was written, exactly as
designed. Then it correctly reported the entire live path as unreachable, because a worker
is loaded by URL rather than imported and the import graph never reaches it - so the audit
now treats `new Worker('...')` as an entry point too.

The starting coil is committed alongside each native structure rather than computed. The
browser cannot build it without a second implementation of the self-avoiding walk, and the
droplet must not build it, because that would put numpy in the web layer's requirements for
the sake of a few kilobytes of constants.

### Phase 4: the queue

Architecture B is the only one with a kill condition, and P0-1 measured its way past that
back in Phase 0, so this was building rather than deciding. The whole design is bounds: one
worker at nice 19, a residue cap of 76 from measurement, a depth cap of 5, one pending job
per IP, and a timeout of three times the measured 427.4 s worst case rather than a round
number. Every cap lives in `buttfold/queue.py` so the routes, the worker and the tests
cannot drift apart.

The worker is a separate process from Flask for one concrete reason: the bake needs numpy
and the web layer must not have it. On a 3.9 GB box shared with four other apps the
difference between "the page imports numpy" and "a worker does" is real memory, so
`requirements.txt` stays two lines and `requirements-queue.txt` is the worker's. A
consequence nobody would guess: no interpreter on this Mac could run the whole test suite,
because the PhoneFold venv has numpy and no Flask and the system Python has Flask and no
numpy. ButtFold now has its own venv and a `requirements-dev.txt` that says why.

The worker bakes through `bake_frames`, split out of the gallery baker, so a queued fold
faces the identical collapse and first-frame-contact assertions. A queued fold that did not
collapse fails there rather than being served as an animation of nothing happening, and it
fails through *that* code rather than through a second implementation that might not.

Two things I got wrong and the tests caught. The per-IP cap keys on `X-Forwarded-For`,
because behind nginx every `remote_addr` is 127.0.0.1 and without it the cap becomes a
global cap of one - a queue that looks like it works and only ever serves one person. And
`json.loads("3")` is the integer 3, so `.get` on a scalar body is an AttributeError and a
500 where a 400 belongs.

The worst mistake of the session was mine and not the code's: patching `player.js` by
slicing between two string indices, which silently swallowed four methods between them. The
page then failed to boot at all, and the queue smoke test reported the *gallery's* numbers
as though the queued fold had loaded - 150 frames, Q 1.000 - because the player was still
showing the fold it already had. A test that reads plausible numbers off the wrong object
is worse than one that fails. Restored from the last commit and reapplied the change with
anchored replacements that assert their own anchor exists.

The page asks the server for a random seed each time, deliberately: "fold it again" should
be a different trajectory rather than a cache hit that looks like a very fast fold. That
costs exactly the spread P0-3b measured, and the queued trp-cage finished at Q 0.892 against
the gallery's 1.000. Both are good folds, and the smoke test's bar is set from that
measurement rather than from the gallery's number.

### Phase 5, and where this stops

The shop window is built from `links.json` with the honest state as the default: an app with
no store URL shows an "In review at the App Store" tag that is deliberately not dimmed, and
Apple's badge wording is not used at all until there is a real store URL behind it. Flipping
one field flips the card, verified by diffing two GETs.

The bug worth recording is the confidence colour ramp. It was handed `null` for per-residue
confidence and painted every residue the same "below 50" orange. The module was imported,
the button was wired, the function was called, the colours visibly changed when you pressed
it, and `audit_wiring.py` could see nothing wrong - because nothing was structurally wrong.
It was found by asking a question no existing check asked: do the three colour modes render
*differently*? They now must, on pixels, and the screenshot gate fails if any two match.

The mobile pass turned up something smaller and the same shape: PLAN section 8's shop-link
wording is right on a desktop and wraps to three lines at 390 px, pushing the protein name,
the disclosure and the stage below the fold. Two labels, one anchor.

**This is where the build stops for input.** Phases 0 to 5 are done and every
machine-verifiable gate is green: 50 Python tests, 15 JavaScript tests, the wiring audit,
and four browser gates (the stage renders, the sound reaches an audio device, a browser
folds trp-cage live, the droplet queue returns a fold and then serves it from cache in
0.5 s instead of 6.0). Five things need Marc, and they are in BLOCKERS.md. Only one of them
blocks further building: Phase 6 is the deploy, and it creates a public subdomain, a
certificate and a launcher entry that points mdeller.com's front page at this. That is his
call, not mine.

### Live

Marc approved the sound, the disclosure wording and the resemblance for now, cut the shop
window back to PhoneFold alone, asked for the controls to give the structure more of the
screen with the Play bar visible, and said to deploy.

The controls went from three stacked rows to one wrapping row, which is about 110 px of
vertical space, and the stage is now sized from what is left rather than from a fixed
clamp. The arithmetic was five pixels short at 1280x800 and 1366x768 on the first try -
exactly the sort of sum that is right when written and wrong three commits later - so the
screenshot gate now measures the Play button's bottom edge against the fold at four common
sizes and fails if a visitor would have to scroll to press Play.

Deployed to `buttfold.mdeller.com`: two systemd units, an nginx vhost with the 1.24
`listen 443 ssl http2` form, `application/wasm`, per-location Cache-Control and its own
access log so the launcher's counter stays clean. State lives in `/var/lib/buttfold` rather
than in the deployed tree, which a deploy rsyncs over.

The http2 patch is the small lesson. A loose `sed s/listen 443 ssl;/.../` rewrote the
comment in the vhost that explains the patch, because the comment quotes the string it
matches. Anchored to the start of the line now.

`deploy.sh` ends by fetching the live site back and asserting the NEW version string, a
route added in this deploy, the disclosure paragraph, Cache-Control by plain GET on both
the HTML and an asset, the wasm MIME type and HTTP/2. Then all four browser gates were run
against the live site rather than against localhost.

One production measurement worth keeping: the droplet folds trp-cage in **25.7 s** live
against P0-1's 16.6 s. The difference is the systemd `CPUQuota=60%` on top of `nice -n 19`,
which is deliberate - a fold must never starve nginx or the other six apps - and 1.55x is
what it costs. Ubiquitin at the residue cap scales to about 11 minutes against a 21-minute
timeout, so both bounds still hold.

What is left is the rendering, and it is the real gap: the ribbon is a plain tube, so a
helix reads as a coiled tube rather than as the app's flat helical ribbon and arrowed
strand. Noted alongside it, because it may be half of what Marc saw: the default fold is
trp-cage, which is helix and coil only and has **no sheet at all**, so the cyan never
appears until you pick protein G or ubiquitin.
