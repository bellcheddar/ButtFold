# ButtFold: state

Current phase: **Phase 3, WASM live fold** (Phase 2's machine gate is met; its HUMAN gate awaits Marc, as do two Phase 0 rows)

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

**doing.** Gate: a browser folds trp-cage.

Already done in Phase 0, ahead of schedule:

- `native/wasm_api.c` and the streaming module build (`tools/build_wasm.sh module`);
- **P0-3c: the module reproduces the CLI bitwise**, all 101 frames and 6,060 coordinate
  components, which is one of this phase's exit criteria met early;
- forces agree with the native build to 2.9e-15 relative, against a 1e-9 bar.

Still to do: the worker, the live path through the same player, feature detection, and the
handling that P0-2 forced into scope - **a browser suspends a fold it cannot see**, so a
visitor who switches tabs must not silently stop folding.

## Phase 3: WASM live fold

todo. Gate: a browser folds trp-cage.

## Phase 4: the queue

todo. Gate: caps hold and the cache converges.

## Phase 5: shop window, honesty, polish

todo. Gate: the strings are live. **HUMAN** gates at the end (wording, resemblance).

## Phase 6: deploy and list

todo. Gate: live and verified from outside.
