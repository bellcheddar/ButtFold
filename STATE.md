# ButtFold: state

Current phase: **Phase 0, measurement**

The task list below is the execution contract from PLAN.md section 11. Status is one of
`todo` / `doing` / `blocked` / `done`. Phases advance on machine-verifiable gates only;
anything marked **HUMAN** halts for Marc and is never marked met by the agent.

---

## Decisions taken from measurement

These are written here the moment the corresponding METRICS.md row exists, and not before.

| Decision | Value | Set by |
|---|---|---|
| B residue cap | *not yet measured* | P0-1 decision rule, PLAN section 3 |
| B on-demand or cache-warmer only | *not yet measured* | P0-1 decision rule |
| Phone live-fold policy | *not yet measured* | P0-2 decision rule |
| Desktop Safari live-fold support | *not yet measured* | P0-2 decision rule |
| Launch gallery payload budget | 4 MB (working budget) | P0-4, revisit on measurement |

---

## Phase 0: measurement

| # | Task | Status |
|---|---|---|
| 0.1 | Repo skeleton, ledger files, git init | done |
| 0.2 | Vendor `go_model_fold.c` with provenance header | done |
| 0.3 | Vendor the six native structures into `data/natives/` | done |
| 0.4 | `tools/coil.py`: self-avoiding coil + xyz writer, ported with provenance | done |
| 0.5 | **P0-1** droplet native fold speed (trp-cage, ubiquitin) + M1 Max comparator | doing |
| 0.6 | **P0-2** WASM fold speed, 3 desktop browsers + mobile Safari | todo |
| 0.7 | **P0-3** WASM parity: forces to 1e-9, endpoint Q and RMSD | todo |
| 0.8 | **P0-4** baked 3D payload size for the six-fold gallery | todo |
| 0.9 | Decision rules applied; the table above filled in from METRICS.md | todo |

**Exit gate (machine):** METRICS.md contains droplet times for trp-cage and ubiquitin,
WASM times for trp-cage and protein G in at least two desktop browsers plus mobile Safari,
the parity result, and the baked payload size. The B residue cap and the phone live-fold
policy are written into the decisions table above.

## Phase 1: baked gallery, silent

todo. Gate: the page plays a real collapse.

## Phase 2: sound

todo. Gate: note-for-note parity. **HUMAN** gate at the end.

## Phase 3: WASM live fold

todo. Gate: a browser folds trp-cage.

## Phase 4: the queue

todo. Gate: caps hold and the cache converges.

## Phase 5: shop window, honesty, polish

todo. Gate: the strings are live. **HUMAN** gates at the end (wording, resemblance).

## Phase 6: deploy and list

todo. Gate: live and verified from outside.
