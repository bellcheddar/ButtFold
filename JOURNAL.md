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
