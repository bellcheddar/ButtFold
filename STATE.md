# ButtFold: state

Current phase: **live at https://buttfold.mdeller.com**. Phases 0 to 6 done. Marc has approved the sound, the disclosure wording and the resemblance for now; the rendering work he flagged is the open roadmap at the bottom.

The task list below is the execution contract from PLAN.md section 11. Status is one of
`todo` / `doing` / `blocked` / `done`. Phases advance on machine-verifiable gates only;
anything marked **HUMAN** halts for Marc and is never marked met by the agent.

---

## Decisions taken from measurement

These are written here the moment the corresponding METRICS.md row exists, and not before.

| Decision | Value | Set by |
|---|---|---|
| B residue cap | **76 residues** (ubiquitin) | P0-1: 7 min 07 s, inside the 15 min rule |
| B on-demand or cache-warmer only | **on demand, as planned** | P0-1: trp-cage 16.6 s, inside the 60 s rule |
| Phone live-fold policy | *awaiting the mobile Safari row* | P0-2 decision rule |
| Desktop Safari live-fold support | **supported**, 3.89x native on trp-cage | P0-2: inside the 5x bar |
| Desktop Chrome live-fold support | **supported**, 1.41x native | P0-2 |
| Live fold when the tab is hidden | **must be handled in Phase 3** | P0-2: Safari suspends the worker; Chrome costs 1.9x |
| P0-3 RMSD parity bar | the native build's measured seed range, not a fixed 0.1 Å | P0-3b: the build's own spread is 0.32 Å |
| Launch gallery payload budget | 4 MB; **measured at 0.67 MB** | P0-4 |

---

## Phase 0: measurement

| # | Task | Status |
|---|---|---|
| 0.1 | Repo skeleton, ledger files, git init | done |
| 0.2 | Vendor `go_model_fold.c` with provenance header | done |
| 0.3 | Vendor the six native structures into `data/natives/` | done |
| 0.4 | `tools/coil.py`: self-avoiding coil + xyz writer, ported with provenance | done |
| 0.5 | **P0-1** droplet native fold speed (trp-cage, ubiquitin) + M1 Max comparator | done |
| 0.6 | **P0-2** WASM fold speed: Chrome and Safari done, Firefox absent from this Mac | **blocked** on Marc: Safari's protein G row and mobile Safari |
| 0.7 | **P0-3** WASM parity: forces to 1e-9, endpoint Q and RMSD | done |
| 0.8 | **P0-4** baked 3D payload size for the six-fold gallery | done |
| 0.9 | Decision rules applied; the table above filled in from METRICS.md | done, bar the phone policy |
| 0.10 | **P0-3c** (added) the streaming module reproduces the CLI bitwise | done |

**Exit gate (machine):** met except for two rows that need Marc and are written up in
BLOCKERS.md: Safari's protein G time (this Mac sat at the login window, and Safari suspends
a fold it cannot see) and mobile Safari on Marc's iPhone. Neither blocks anything else, so
Phase 1 went ahead.

## Phase 1: baked gallery, silent

**done.** Gate: the page plays a real collapse.

| # | Task | Status |
|---|---|---|
| 1.1 | `tools/psea.py`, `tools/contacts.py`, ported with provenance | done |
| 1.2 | `tools/bake_gallery.py` with the collapse and first-frame assertions | done |
| 1.3 | Six Gō folds baked, all assertions green, 686 kB | done |
| 1.4 | Flask: `/`, `/api/gallery`, `/api/fold/<id>`, `/healthz`, explicit Cache-Control | done |
| 1.5 | Stage: three.js tube, SS colours, orbit, engine badge | done |
| 1.6 | Readouts, two sparklines, gallery cards, transport | done |
| 1.7 | `PSEA.js` and `ContactTracker.js`, parity green against the Python | done |
| 1.8 | `tools/audit_wiring.py`, wired into the gate | done |
| 1.9 | `tools/check_all.sh`: every machine gate in one command | done |

**Exit gate (machine): all met.**

- bake assertions pass for all six: loosest collapse ratio 0.72 against the 0.80 bar,
  worst first-frame contact fraction 4% against the 25% bar;
- `/api/gallery` lists 6;
- `audit_wiring.py` green;
- a headless screenshot of the stage mid-fold is non-uniform: 1.3% of stage pixels differ
  from the modal colour, 246 distinct colours, against a blank stage's 0.0% and 1;
- frame 1 versus final frame of the **served** artefact differ in Rg by the asserted ratio,
  checked in the browser against the JSON the page actually fetched.

Two real bugs the gates caught, both invisible to everything else: `emcc MODULARIZE` emits
no ES default export so the browser import threw while the node test passed, and a
degenerate initial spline gave the tube a NaN bounding sphere, which frustum-culled the
ribbon forever behind a page that otherwise looked perfect.

## Phase 2: sound

**machine gate met. HUMAN gate open.**

| # | Task | Status |
|---|---|---|
| 2.1 | Per-residue confidence added to the baked artefact (the sonifier's velocity input) | done |
| 2.2 | `tools/swift_score_dump/`: PhoneFold's own Sonifier over ButtFold's gallery | done |
| 2.3 | `MusicalScale.js`: modes, scale arithmetic, FNV-1a seed, SplitMix64, pitch layer | done |
| 2.4 | `Sonifier.js`: the whole mapping, Float32 emulated where the Swift uses `Float` | done |
| 2.5 | `audio.js`: Web Audio engine, all five style profiles unchanged, HRTF panning | done |
| 2.6 | Style pill, volume, score summary line, audio clock driving the animation | done |
| 2.7 | `tests/sonifier_parity.test.mjs`, `tests/audio_smoke.mjs`, both in the gate | done |

**Exit gate (machine): all met.**

- `Sonifier.js` matches the Swift fixture note for note: **15,536 notes across 2 folds and
  all 5 styles, zero differences** in voice, pitch, velocity, residue, partner, beat offset
  and duration;
- the score hash is stable: two runs of the same fold produce byte-identical moments;
- all five styles produce a non-empty score, and the reference dump covers every one;
- and, beyond the plan's wording, the sound is shown to reach a real `AudioContext` from a
  real click, because a correct score wired to nothing is silent and passes every unit test.

**HUMAN gate, open:** Marc listens to ubiquitin in two styles against the phone app. The
agent does not mark this met. Run the app (`python3 app.py`, then
`http://127.0.0.1:8007/`), pick Ubiquitin, press Play, and switch between Fantasy and Jazz.

## Phase 3: WASM live fold

**done.** Gate: a browser folds trp-cage.

| # | Task | Status |
|---|---|---|
| 3.1 | `native/wasm_api.c`, the streaming module, pinned emsdk build | done (Phase 0) |
| 3.2 | `static/js/frames.js`: one frame builder, shared by every source | done |
| 3.3 | `static/js/fold_worker.js`: the module in a worker, with contacts and P-SEA | done |
| 3.4 | `/api/native/<id>`: native state and starting coil as committed data | done |
| 3.5 | Live path through the same player, stage badge, streaming as it folds | done |
| 3.6 | Feature detection; the pill says why when it cannot run | done |
| 3.7 | Tab-visibility handling for the P0-2 suspension finding | done |
| 3.8 | `tests/live_parity.test.mjs`, `tests/live_fold.mjs`, both in the gate | done |

**Exit gate (machine): all met.**

- headless Chrome folds trp-cage live to **Q 1.000** (bar 0.95) and streams **152 frames**
  (bar 100), collapsing Rg 9.5 to 6.9 Å;
- step-0 forces match the native build to 2.9e-15 relative, against a 1e-9 bar (P0-3);
- the live path and the baked path produce **byte-identical frame objects** for the same
  trajectory input: 300 frames, five fields each, zero differences.

The live fold is not required to produce the same contact COUNT as the bake and does not:
806 against 858, because the two sample the trajectory at slightly different times. That is
a property of how often you look, not a disagreement, and METRICS says so.

## Phase 3: WASM live fold

todo. Gate: a browser folds trp-cage.

## Phase 4: the queue

**done.** Gate: caps hold and the cache converges. The residue cap is **76**, set by P0-1.

| # | Task | Status |
|---|---|---|
| 4.1 | `buttfold/queue.py`: SQLite job queue, every cap in one place | done |
| 4.2 | `buttfold/worker.py`: one worker, `nice -n 19`, timeout kills the process group | done |
| 4.3 | `buttfold/paths.py`: state outside the deployed tree, overridable by environment | done |
| 4.4 | `/api/queue`, `/api/queue/<id>`, `/api/queue/<id>/result` | done |
| 4.5 | The worker bakes through `bake_frames`, assertions included | done |
| 4.6 | "Fold on the server" in the page, with position and progress | done |
| 4.7 | `tests/test_queue.py` (22 tests) and `tests/queue_smoke.mjs`, both in the gate | done |

**Exit gate (machine): all met.** pytest proves each clause of PLAN section 11:

- a job completes and its result plays through the player (the real binary, the real baker,
  loaded back through the same store the gallery uses);
- a second identical request is a **cache hit** and spawns nothing, and an identical request
  still in flight joins the existing job rather than duplicating it;
- the **6th** queued job gets a 429, with a `Retry-After`, and writes no row;
- an **oversized** protein gets a 400 whose message says the cap is 76 and why;
- a **timeout** is recorded as a timeout rather than a failure, and is 3x the measured worst
  case rather than a round number.

Plus, in a browser against a live worker: queued (with position) to folding (with progress)
to a finished fold adopted by the player, badge reading "on the server".

## Phase 5: shop window, honesty, polish

**machine gate met. Two HUMAN gates open.**

| # | Task | Status |
|---|---|---|
| 5.1 | Per-residue confidence wired to the stage; the confidence ramp works | done |
| 5.2 | Colour-blind-safe palette (Okabe-Ito) and the confidence ramp, both live | done |
| 5.3 | Shop window from `links.json`: featured card plus More from Marc | done |
| 5.4 | The honest state is the default; Apple's badge only with a real store URL | done |
| 5.5 | Mobile pass at 390 x 844 | done |
| 5.6 | `tests/test_honesty.py`; colour-mode and mobile checks in the screenshot gate | done |

**Exit gate (machine): met.** The verbatim strings and the approved paragraph are in the
served page; flipping one `links.json` field flips the card, verified by diffing two GETs.

**HUMAN gates: both cleared by Marc, 2026-09-01.**

1. ~~The disclosure paragraph wording~~ - **approved as written.**
2. ~~The side-by-side resemblance~~ - **approved for now**, with the rendering work in the
   roadmap below called out as the next thing. Marc will guide it.

Settled the same day: the sound is right (Phase 2's human gate), and the shop window is cut
back to PhoneFold alone.

## Phase 6: deploy and list

**done.** Live at **https://buttfold.mdeller.com**.

| # | Task | Status |
|---|---|---|
| 6.1 | `deploy/nginx.conf`, two systemd units, `deploy/gunicorn.conf.py` | done |
| 6.2 | `deploy.sh`, whose last act is a live GET rather than a restart | done |
| 6.3 | Certbot certificate, and the nginx 1.24 http2 listen-line patch | done |
| 6.4 | Launcher entry at the top of `apps.json`, status `building` | done |
| 6.5 | `LICENSE` (MIT) and `THIRD-PARTY.md` | done |
| 6.6 | README to the house standard, Elementor pages, public repo | done |

**Exit gate (machine): met.** Verified from outside: the deployed version string, a route
added in this deploy, the disclosure paragraph in the live HTML, `no-cache` on the HTML and
a long cache on assets (both by plain GET, never HEAD), `application/wasm`, and HTTP/2. All
four browser gates pass against the live site, including a real fold on the real droplet.

State lives in `/var/lib/buttfold`, outside the deployed tree, because a deploy rsyncs over
`/opt/buttfold` and anything the app wrote there would be destroyed or survive as a stale
file nobody expects.

---

## Open roadmap

Marc's, 2026-09-01, after seeing it live. He will guide the first item.

- [x] **The repo is public**, at `github.com/bellcheddar/ButtFold`, with the README to the
      house standard, the Elementor pages forged and `THIRD-PARTY.md` carrying the
      provenance. Sixteen badges, every one fetched back and checked for what it actually
      rendered, with versions read off the droplet rather than the `>=` floors.
- [x] **The launcher entry is `live`**, at the top, with the same green bullet and undimmed
      text as the rest.
- [x] **Drag to rotate**, fixed by porting `StageCamera.swift`. The old yaw/pitch camera had
      the same clamp PhoneFold's once did, which kills a vertical drag mid-gesture. Scroll
      zoom, pinch and double-click-to-reframe came with it.
- [x] **The charts sit beside the viewer**, which keeps about 60% of the width, and the Play
      bar is above the fold at four common screen sizes.
- [x] **Cartoon secondary structure**, ported from `TubeGeometry.swift`: flat helical
      ribbons, flat-edged arrowed strands, a thin round cord for coil, swept along a
      circular-arc spline rather than Catmull-Rom (which cuts 17% off a helix's radius and
      is why they read as rounded triangles). Two bugs found on the way, both of which
      showed only as "the strands look thin": P-SEA's confidence is a quality score rather
      than a probability, and the hysteresis was holding a structure without holding its
      certainty.
- [x] **Ubiquitin is first in the gallery and the default on load.** It was trp-cage, which
      is helix and coil only with no sheet at all, so the cyan never appeared until a
      visitor clicked something. Ubiquitin is the beta-grasp fold: both, and it collapses
      from Rg 21.3 to 11.5 Å.
- [x] **The front end is versioned by URL path**, `/static/v-<build>/...`, after a returning
      visitor was served a year-old renderer: an ES module's relative imports do not inherit
      a query string on the entry point. `tests/cache_staleness.mjs` is the only gate that
      runs with a warm cache, which is the only way to see it.
- [x] **The launcher beacon points at a path the page actually fetches.** It named
      `gallery.json`, which is read server-side and never requested by a browser.
- [x] **Both computed engines are watched as they fold.** The live path streamed frames but
      built its chart history once, from its single first frame, and found it non-empty ever
      after: the two charts drew the same two points for the whole fold. It also dropped
      `conf` and `ssConf` on the way in, so the cartoon had no certainty to sweep and every
      residue drew as coil until the finished trajectory was adopted and the ribbons appeared
      all at once. The server path streamed nothing at all - a percentage over a still
      picture - and now serves the coordinate file it is still writing, which the browser
      turns into frames with the same builder. Three things had to be right for the handoff
      to the finished artefact to be invisible: the preview keeps the same frames the baker
      keeps (`np.linspace(0, 300, 150).round()`, ported and tested against numpy), the camera
      frames what the trajectory occupies rather than the quantised box, and a batch of
      frames arriving together is drawn once.
- [x] **`static/js/package.json` declares what those modules already are.** Without it node
      infers CommonJS from the file extension and refuses the first `export` it meets, so the
      whole JS suite passed or failed depending on which node was first on PATH - and the
      only one on this Mac's PATH is CCP4's v16. Scoped to that directory rather than the
      repo root, where it would also reclassify emscripten's generated CommonJS CLI.
- [x] **The transport is inside the viewer.** Play, the seek bar and the frame count sit as
      an overlay on the top of the stage, and the volume is a vertical slider on its inside
      right with no label; "drag to orbit" and the score-summary line are gone, the latter
      surviving as the transport's own tooltip so PLAN section 5.3 still holds. The stage
      takes 63 to 69% of the viewport now, up from about 45. Two things found while
      measuring it: the phone's `.stage-wrap` height had been dead since it was written -
      same specificity, three hundred lines above the rule it meant to override, so a phone
      was using the desktop calculation - and the subtrahend in that calculation has now
      been five pixels short twice, so the gate measures where the readouts actually end.
- [x] **The Play panel matches the control panel** at 34 px and 12 px in both, compared as
      measured boxes rather than as matching declarations; the volume carries a speaker mark
      above it; and there is an eighth readout, the end-to-end distance, so one desktop row
      is also a 4x2 grid on a phone. The charts were never hidden on a phone: a canvas
      flexes into its row and off the stage's row there was no row height to flex into, so
      both drew a title and a legend with a hairline between them.
- [!] **This Mac's headless Chrome has no audio clock**, as of 2026-09-01. A bare
      `AudioContext` with no page of ours loaded reports state "running" and advances 0.005 s
      in 1.5 s, which is one render quantum: the render thread is created and never driven.
      It is not ButtFold - the same gate fails identically against the previously deployed
      build - so `tests/audio_smoke.mjs` now probes for it and skips only the clock
      assertions, naming the cause. The score, the scheduling and the transport are still
      checked. **The sonifier is unverified on this machine until that clears.**
- [x] **The animation is interpolated**, which `FRAME_CAP = 150  # interpolated in the
      browser` had promised since it was written and nothing had done. 150 frames across
      forty seconds of music is four frames a second against sixty redraws, so each pose was
      held fifteen times and then replaced. Measured over 59 consecutive redraws: 3 of them
      moved anything and the largest single jump was 14.9 A; now all 59 move, median 0.87 A,
      largest 3.97 A. Three measurements shaped it. A plain lerp is not merely inexact but
      broken - an alpha carbon moves up to 30 A between adjacent frames, so the midpoint's
      mean CA-CA bond came out at 86 to 94% of true with the worst 97% short. Superposing
      each frame onto the one before, which is what a viewer does to stop a trajectory
      tumbling, took the largest step only from 30.1 to 26.6 A, so the whole Kabsch
      apparatus was measured and dropped: the motion is conformational, not rotational. What
      works is a bond projection after the lerp, and 16 passes leaves the worst bond 0.7%
      off. The disclosure paragraph now says the in-between is drawn rather than computed,
      and `test_honesty` pins that sentence - the two test files that each kept their own
      copy of the approved wording now share one.
- [x] **The ESMFold engine replaces "On the server".** Pick one of 24 UniProt proteins,
      ESMFold predicts it at Meta in about a second, and the Gō model folds a chain toward
      that prediction here; everything downstream is untouched, because the only thing that
      differs is where the native state came from. Measured live: 134 s for the 40-residue
      entry on the droplet under its CPU quota, 36 distinct frame counts streamed while it
      ran, and a repeat of the same seed back in 0.4 s from cache. Four bugs found on the
      way, three of them older than this work: `bake_frames` raised its "this did not
      collapse" diagnosis using a name that only existed in its caller, so the one path
      designed to fail loudly raised `NameError` instead - and only ever for a queued fold,
      where nobody was watching a console. `_job_stream` read `data/natives/<id>.json`
      directly, so an ESMFold job 404ed its frames route and showed a flat zero for progress.
      `.uniprot-row { display: flex }` beat the browser's own `[hidden] { display: none }`
      and pushed the readouts below the fold in every mode. And the coil seed used Python's
      `hash()`, which is randomised per process, so the same protein would have started from
      a different chain after every worker restart while the cache key said otherwise.
- [ ] The two P0-2 browser rows, deferred by Marc: Safari's protein G time and mobile Safari.
- [x] **Genie 2 gallery entries**, three of them: an all-alpha 64-mer, a mixed alpha/beta
      72-mer and an 80-residue helical bundle, each a backbone that has never existed. Baked
      rather than served live because 1000 denoising steps is 2.2 min on the Mac and 10.2 on
      the droplet with no speed-up from more cores. The trajectory runs the other way and
      three things followed: both bake gates fail correctly and are mirrored (expand
      fourfold, start as noise, end at CA-CA 3.80 A, end structured); the contact rule has to
      be two-sided, because in the opening ball every pair is under any distance bar and the
      Go rule reports the whole map as formed on frame one; and the tempo cannot come from
      compaction, which clamps to 1 on the first frame and stays there. `build_frames` was
      extracted so both regimes share ONE frame builder - the rule that makes live_parity
      possible - and the readouts, the chart legend and the card are all engine-aware now,
      because "NATIVE 100%" beside a structure that never existed is a quiet false claim.
- [ ] Flip PhoneFold's `app_store_url` in `static/links.json` when it clears review, and
      verify the badge in the served page.
