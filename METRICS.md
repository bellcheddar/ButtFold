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

## Phase 2: note-for-note parity with the shipped app

2026-09-01, M1 Max. `tests/fixtures/score/*.json` was produced by PhoneFold's own
`FoldAudio.Sonifier`, compiled from PhoneFoldKit at commit
`6f44c8a1ac7684da93668a580b29cbe9a67cfc5e` and run over ButtFold's committed baked gallery
(`tools/swift_score_dump/run.sh`). `tests/sonifier_parity.test.mjs` then runs `Sonifier.js`
over the same artefact and compares every note.

| | |
|---|---|
| reference scores | 10 (2 folds x 5 styles) |
| notes compared | **15,536** |
| fields compared per note | voice, pitch, velocity, residue, partner, beat offset, duration |
| differences | **0** |

Per-moment fields (degree, cadence, modulation, dropped and established contact counts) are
compared exactly; the continuous ones (tempo, compaction, cutoff, detune, reverb) to 1e-4
relative, because the Swift computes them in `Float` and JS in double.

| fold | style | moments | readouts per moment | beats per moment | duration | notes | dropped | established |
|---|---|---|---|---|---|---|---|---|
| trp_cage | fantasy | 75 | 2 | 0.99 | 36 s | **1,149** | 37 | 44 |
| trp_cage | jazz | 75 | 2 | 1.20 | 37 s | **1,148** | 37 | 44 |
| trp_cage | pop | 75 | 2 | 1.09 | 40 s | **1,156** | 37 | 44 |
| trp_cage | rock | 75 | 2 | 1.32 | 38 s | **1,129** | 37 | 44 |
| trp_cage | surf | 150 | 1 | 0.69 | 38 s | **1,563** | 9 | 19 |
| ubiquitin | fantasy | 75 | 2 | 0.99 | 38 s | **1,629** | 1,697 | 186 |
| ubiquitin | jazz | 75 | 2 | 1.20 | 38 s | **1,635** | 1,697 | 186 |
| ubiquitin | pop | 75 | 2 | 1.09 | 41 s | **1,647** | 1,697 | 186 |
| ubiquitin | rock | 75 | 2 | 1.32 | 39 s | **1,603** | 1,697 | 186 |
| ubiquitin | surf | 150 | 1 | 0.69 | 40 s | **2,877** | 962 | 107 |

**Contacts past the per-bar cap are reported, not hidden.** Ubiquitin loses 1,697 of its
3,050 contact formations to the sixteen-per-moment limit at four of the five styles. That is
the shipped app's behaviour, not a ButtFold defect - parity means inheriting it - and the
page states it in a line under the transport rather than just sounding thin. Surf groups one
readout per moment rather than two, so it keeps far more of them (962 dropped, and 2,877
notes against fantasy's 1,629).

### The sound actually reaches an audio device

The parity test proves the score is right and says nothing about whether it reaches an
`AudioContext`. A sonifier with perfect note-for-note parity that is wired to nothing
produces silence and passes every unit test, which is precisely the failure mode PLAN
section 10 exists for. `tests/audio_smoke.mjs` therefore drives the real page in headless
Chrome, clicks Play as a genuine user gesture, and measures:

| check | measured |
|---|---|
| AudioContext state after the click | **running** |
| audio clock advance in 2.5 s of wall time | 2.45 s |
| animation frame reached | 9, driven by the audio clock |
| moments scheduled by the lookahead | 5 |
| style switch keeps its place | 2.45 s -> 3.66 s, no restart |

## Phase 3: a browser folds a protein

2026-09-01, M1 Max, headless Chrome 152. `tests/live_fold.mjs` clicks "Fold it live" on the
real page and measures what comes back.

| | measured | gate |
|---|---|---|
| frames streamed | **152** | >= 100 |
| final Q | **1.000** | >= 0.95 |
| wall clock in the browser | 7.6 s | (native 5.2 s, so 1.46x) |
| radius of gyration | 9.5 -> 6.9 Å, ratio 0.73 | <= 0.80, the baker's own bar |
| contacts formed | 806, of which 19 on frame 1 (2%) | < 25% on frame 1 |
| notes scored from the live fold | 1,084 | non-empty |
| stage badge while it plays | "in your browser" | says where it was computed |

The live fold forms 806 contacts against the baked gallery's 858 for the same protein. That
is **not** a disagreement between the two paths: they sample the trajectory at slightly
different times. The baker runs at stride `steps/300` and then subsamples 150 of those 301
frames, so its frames land at 0, 13332, 26664 steps; the live path runs at stride
`steps/150` directly, so its frames land at 0, 13333, 26666. A contact that forms and breaks
between two sampled frames is invisible to whichever path did not look at that moment. Both
are honest readings of the same physics; neither is the true count, because "the number of
contacts" is a property of how often you look.

What the two paths ARE identical on is the frame *object*, which is the thing the gate
asked for:

| check | result |
|---|---|
| frames rebuilt by `static/js/frames.js` from the baker's own coordinates | 300 (trp-cage, protein G) |
| fields compared per frame | points, newContacts, ss, conf, rg |
| differences | **0** |

Three cross-language differences had to be found and fixed to get there, and every one of
them was invisible in the artefact and fatal to a byte comparison:

1. **Negative zero.** `Math.round(-0.2)` is `-0` in JavaScript and `0` in Python. Both write
   `0` to JSON, so the committed file is identical either way.
2. **Tie-breaking.** NumPy rounds half to even; `Math.round` rounds half up. Measured on
   trp-cage frame 8, one coordinate landed on exactly 238.5, where the baker wrote 238 and
   JavaScript produced 239.
3. **A ruler rounded for tidiness.** `angstromsPerUnit` was written to six decimal places,
   a relative error of about 3e-5. Invisible in every length it produces, and enough to move
   a coordinate sitting near a rounding boundary by one unit.

## Phase 4: the queue's caps and its cache

2026-09-01. The caps are not round numbers; each is a measured figure or a stated policy.

| bound | value | where it comes from |
|---|---|---|
| residue cap | **76** | P0-1: ubiquitin folds on the droplet in 7 min 07 s, inside the 15 min rule |
| job timeout | **1,282 s** | 3 x the measured 427.4 s worst case for that protein |
| queue depth | 5 | policy: a burst answers 429 rather than accumulating work |
| pending jobs per IP | 1 | policy: one visitor cannot fill the queue alone |
| worker concurrency | 1, at `nice -n 19` | policy: a fold can never starve nginx or the other four apps |
| peak RSS of a fold | 2.4 MB | P0-1, on a 3.9 GB box |

42 Python tests cover the caps, the cache, the worker's claim/finish/requeue and the HTTP
layer. The end-to-end one runs the real binary and the real baker.

Measured end to end through the page, headless Chrome against a live worker:

| | measured |
|---|---|
| states a visitor sees | queued (with position) -> folding on the server (with %) -> folded |
| fold time, trp-cage, on this Mac | 5.3 s |
| result | 150 frames, Rg 9.5 -> 7.0 Å (ratio 0.73), 2% of contacts on frame 1 |
| final Q at a random seed | 0.892, against the gallery's 1.000 at seed 1 |
| notes scored from it | 1,061 |
| stage badge | "on the server" |

**The page asks for a random seed every time, on purpose.** "Fold it again" should be a
different trajectory, not a cache hit that looks like a very fast fold. What that costs is
the seed-to-seed spread P0-3b measured: the same build, folding the same coil, lands
somewhere different depending only on the random force. The queued fold above finished at
Q 0.892 where the gallery's seed-1 fold finished at 1.000, and both are good folds.

Progress is read from the growing frame file's **byte count**: the stream format is two
little-endian int32 then float32 xyz triples, so bytes map to frames exactly. Parsing the
binary's stdout would be a second and lossier source of the same fact.

## P0-4: baked payload size

2026-09-01, M1 Max. `tools/bake_gallery.py`, six Gō folds, 150 frames each, 3D coordinates
quantised to integers in a ±1000 box, with per-frame contacts, run-length secondary
structure, Rg and Q.

| | |
|---|---|
| `static/baked/gallery.json` | **842 kB** (0.82 MB) |
| budget (PLAN section 3) | 4 MB |
| per fold | 140 kB average |
| Watch reference (2D, 6 folds, 90 frames) | 232 kB |

Comfortably inside the budget, so the 4 MB figure stays and there is room for the 2 to 4
generative entries and for more frames if the animation wants them. The figure grew from
686 kB to the number above when Phase 2 added per-residue confidence to every frame, which
the sonifier needs for note velocity; that is 156 kB for the thing that makes a fold sound
like a fold rather than like a sequence. Served gzipped by nginx
this will be smaller again; the number above is the file on disk, which is the honest one to
budget against.

### What the bake asserted, per fold

Both assertions are the ones PhoneFold's thrown-away Watch bake would have failed. Every
fold passes with room to spare: the loosest collapse ratio is 0.72 against a 0.80 bar, and
the worst first-frame contact fraction is 4% against a 25% bar.

| protein | residues | frames | Rg | collapse ratio | contacts | on frame 1 | final Q | RMSD | fold time | H/E/C |
|---|---|---|---|---|---|---|---|---|---|---|
| Trp-cage TC5b | 20 | 150 | 9.5 to 6.9 Å | **0.72** | 858 | **2%** | 1.0 | 0.71 Å | 5.2 s | 8/0/12 |
| Pin1 WW domain | 34 | 150 | 12.8 to 9.2 Å | **0.72** | 1240 | **3%** | 0.957 | 0.83 Å | 18.6 s | 0/11/23 |
| Villin headpiece subdomain HP36 | 36 | 150 | 13.9 to 9.9 Å | **0.71** | 1435 | **2%** | 0.957 | 1.97 Å | 21.2 s | 18/0/18 |
| Protein G B1 domain | 56 | 150 | 22.0 to 10.3 Å | **0.47** | 2086 | **3%** | 0.993 | 1.0 Å | 64.7 s | 14/21/21 |
| Alpha-3D, a de novo three-helix bundle | 73 | 150 | 21.4 to 13.2 Å | **0.62** | 3110 | **3%** | 0.945 | 2.21 Å | 126.6 s | 57/0/16 |
| Ubiquitin | 76 | 150 | 21.3 to 11.5 Å | **0.54** | 3050 | **4%** | 0.973 | 1.0 Å | 141.9 s | 10/17/49 |

Secondary structure is P-SEA on the final frame, after three frames of temporal hysteresis.
The assignments are the expected ones for each fold: trp-cage one short helix, the WW domain
all sheet, villin and alpha-3D all helix, protein G and ubiquitin the mixed alpha/beta
folds. A baker that had the SS code wired to the wrong frame, or not wired at all, would
show up here as a column of zeros or a column of identical values.
