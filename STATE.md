# ButtFold: state

Current phase: **Phase 2, sound** (Phase 1 complete; two Phase 0 rows await Marc)

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

**doing.** Gate: note-for-note parity. **HUMAN** gate at the end.

## Phase 3: WASM live fold

todo. Gate: a browser folds trp-cage.

## Phase 4: the queue

todo. Gate: caps hold and the cache converges.

## Phase 5: shop window, honesty, polish

todo. Gate: the strings are live. **HUMAN** gates at the end (wording, resemblance).

## Phase 6: deploy and list

todo. Gate: live and verified from outside.
