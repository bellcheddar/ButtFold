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
| 6.6 | README to the house standard | todo |

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

- [ ] **Cartoon secondary structure.** The ribbon is a plain tube along the CA trace, so a
      helix reads as a coiled tube and a strand as a straight one. The app draws a proper
      cartoon: a flat helical ribbon and an arrowed strand. This is the biggest visual gap.
- [ ] **The helix and strand colours are not reading as the app's.** Worth noting that the
      default fold, trp-cage, is helix and coil only and has **no sheet at all**, so the
      cyan never appears on first load. Protein G and ubiquitin show both. Whether the fix
      is the default protein, the palette or the geometry is Marc's call.
- [ ] Flip the launcher entry from `building` to `live` once Marc is happy.
- [ ] The two P0-2 browser rows, deferred: Safari's protein G time and mobile Safari.
- [ ] Genie 2 gallery entries: 2 to 4 backbones baked on the Mac, generative labels on the
      card and the stage.
- [ ] README to the house standard, via the `marcs-vibe-coding` skill.
- [ ] Flip PhoneFold's `app_store_url` in `static/links.json` when it clears review, and
      verify the badge in the served page.
