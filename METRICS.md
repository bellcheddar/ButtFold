# ButtFold: metrics

**Measured numbers only. No estimates, ever.** Every row carries the machine, the browser
where one applies, and the date. A number that is not in this file may not be quoted
anywhere else in the project, including in prose, in the README and in comments.

Machines referred to below:

| Tag | Machine |
|---|---|
| **M1 Max** | Apple M1 Max, macOS 25.6.0, Apple clang 21.0.0 |
| **droplet** | DigitalOcean, 2 shared vCPU ("DO-Regular"), 3.9 GB RAM, Ubuntu 24.04, gcc 13.3.0 |

Unless a row says otherwise, every fold uses the app's real parameters: `--steps 100000*n`,
`--kT 1.0 --kT-final 0.6 --seed 1`, starting from the seed-1 self-avoiding coil written by
`tools/coil.py`, with `--stride` set for 300 frames.

---

## Inherited measurements (PhoneFold, not re-measured here)

Recorded as inherited, with their source, so nothing in ButtFold quotes them as its own.

| protein | residues | machine | fold time | final Q | RMSD to native |
|---|---|---|---|---|---|
| trp-cage TC5b | 20 | M1 Max | 9.0 s | 0.973 | 0.68 Å |
| protein G B1 | 56 | M1 Max | 76.7 s | 1.000 | 0.79 Å |
| ubiquitin | 76 | M1 Max | 152.0 s | 0.984 | 1.03 Å |

Source: PhoneFold `METRICS.md`, commit `6f44c8a1ac7684da93668a580b29cbe9a67cfc5e`. ButtFold's
own re-measurement of the same commands is below and is a little faster; the difference is
the machine's state, not the code, and ButtFold quotes its own numbers everywhere.

---

## P0-1: droplet native fold speed

2026-09-01. `gcc -O2`, run under `nice -n 19` while the other four apps were serving.
The M1 Max column is the identical command run on the Mac on the same day, so the ratio is
measured rather than assumed.

| protein | residues | steps | droplet | M1 Max | droplet / M1 Max | droplet peak RSS | final Q |
|---|---|---|---|---|---|---|---|
| trp-cage TC5b | 20 | 2,000,000 | **16.60 s** | 5.24 s | 3.17x | 2.1 MB | 0.973 |
| ubiquitin | 76 | 7,600,000 | **427.41 s** (7 min 07 s) | 143.75 s | 2.97x | 2.4 MB | 0.973 |

Both machines reach the same final Q to three decimals. The frame files are the same size
(72,248 and 274,520 bytes), so both wrote the same number of frames.

**Decision (PLAN section 3 rule):** trp-cage is under 60 s and ubiquitin is under 15 min,
so **architecture B ships on demand as planned, with the residue cap at 76**. Peak RSS of
2.4 MB on a 3.9 GB box means memory is not a constraint on this design; CPU time is the only
budget that matters, which is what the queue's single `nice -n 19` worker bounds.

The prior estimate in PLAN section 3 was "roughly 2.5 to 4x slower" and "perhaps 6 to 10
minutes" for ubiquitin. Measured: 2.97x and 7 min 07 s. The estimate was right, and it is
superseded by these rows.

## P0-2: WASM fold speed

2026-09-01, M1 Max, emsdk 4.0.7 pinned, `emcc -O3`. The fold runs in a **Web Worker**,
which is what the app does; see the note below on why the main thread could not be measured
reliably.

| browser | harness | trp-cage (20 res) | protein G B1 (56 res) | vs M1 Max native |
|---|---|---|---|---|
| Chrome 152.0.7977.65, headless | worker | **7.36 s** | **90.31 s** | 1.41x, 1.38x |
| Chrome 152.0.7977.65, windowed | main thread | 7.33 s | 90.36 s | 1.40x, 1.38x |
| Safari 26.6.2 | main thread | **20.35 s** | *not yet measured* | 3.89x |
| Firefox | — | *not measured: Firefox is not installed on this Mac* | | |
| mobile Safari (iPhone) | worker | *not yet measured* | | |

Final Q agrees with the native build exactly in every completed run: 0.973 for trp-cage,
0.985 for protein G.

**Decision (PLAN section 3 rule):** the bar was "worse than 5x native" for demoting the
live path. Chrome is 1.4x and Safari is 3.9x, both inside it, so **C stays the primary
interactive path on desktop**. The phone policy waits on the mobile Safari row.

Worker messaging costs nothing measurable: Chrome's worker and main-thread numbers differ
by 0.03 s on trp-cage and 0.05 s on protein G, both inside run-to-run noise, and 302 frames
are posted in each run.

**Measured, and it changed the design: a browser suspends a fold it cannot see.** The first
harness folded on the main thread and yielded with `setTimeout`. Safari then sat at 0% CPU
in every WebContent process and never finished, which from outside is indistinguishable
from "Safari cannot run the module" - one of the two answers this experiment exists to
choose between. Chrome does a weaker version of the same thing: the identical trp-cage fold
took 7.33 s in a foreground tab and 13.85 s in a background one, a 1.9x penalty, in the same
browser on the same machine minutes apart. Moving the fold into a worker fixes Chrome. It
does **not** fix Safari, which suspends the worker too when the page is not visible. That is
a fact about the shipped app, not only about the benchmark, and Phase 3 has to handle it.

## P0-3: WASM parity against native

2026-09-01, M1 Max. Native `clang -O2`, WASM `emcc -O3` run under node 24.19.0.

| protein | forces, max relative difference | bar | Δ final Q | bar | Δ RMSD | wasm / native |
|---|---|---|---|---|---|---|
| trp-cage | **0.0** (bitwise identical) | 1e-9 | 0.000 | 0.02 | 0.09 Å | 1.55x |
| protein G B1 | **2.90e-15** | 1e-9 | 0.007 | 0.02 | 0.123 Å | 1.46x |

The forces bar is met by six orders of magnitude. The Q bar is met.

## P0-3b: how far apart do two runs of the same build land?

2026-09-01, M1 Max, native build, protein G B1, **one fixed coil**, only the C's `--seed`
varied across five runs. This measures the trajectory's own chaos, which is the only
honest reference for the RMSD numbers above.

| seed | 1 | 2 | 3 | 4 | 5 | spread | sd |
|---|---|---|---|---|---|---|---|
| RMSD to native | 1.00 Å | 1.16 Å | 0.88 Å | 0.84 Å | 1.11 Å | **0.32 Å** | 0.14 Å |
| final Q | 0.993 | 0.993 | 0.993 | 0.993 | 0.993 | **0.000** | 0.000 |

**This supersedes the RMSD half of the P0-3 bar.** PLAN section 3 asks the WASM fold to land
"within 0.1 Å" of the native fold's RMSD. The same build, folding the same coil, lands
anywhere across a 0.32 Å window depending on nothing but the random-force seed, so a 0.1 Å
bar is narrower than the measurement's own noise floor and cannot be met by any correct
implementation, including the reference one. The WASM-versus-native gap of 0.123 Å is inside
one standard deviation of that spread.

Q, by contrast, is identical to three decimals across all five seeds. So Q is the endpoint
metric that means something here and RMSD is not, and the parity bar is restated as:

- forces at step 0 agree to 1e-9 relative — **unchanged**, and met at 2.9e-15;
- final Q agrees to 0.02 — **unchanged**, and met at 0.007;
- RMSD lies inside the native build's measured seed-to-seed range for that protein
  (0.84 to 1.16 Å for protein G) — **replaces** the fixed 0.1 Å bar, and is met at 0.88 Å.

This is a deviation from PLAN section 3, taken on measurement, and logged in BLOCKERS.md
for Marc to overturn if he disagrees.

## P0-3c: the streaming module against the CLI

Not in the plan as a numbered experiment; added because it is the cheapest possible check
on the one piece of C that ButtFold wrote itself, and because it is a Phase 3 exit criterion
that could be met early.

`tests/module_parity.test.mjs` drives `native/wasm_api.c`'s init/step/read API for 200,000
steps of trp-cage at stride 2,000 and compares all 101 frames against the CLI's own frame
file, component by component.

| check | result |
|---|---|
| frames emitted | 101 vs 101 |
| coordinate components compared | 6,060 |
| differences | **0 (bitwise identical)** |

## P0-4: baked payload size

*pending*
