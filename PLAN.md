# ButtFold: Build Plan v1

**A Flask web app that folds a protein in the browser, turns the trajectory into music, and sends people to the App Store for the real thing.**

Author: Marc C. Deller, D.Phil. (marc@marcdeller.com)
Plan version: v1, 1 September 2026
Intended runner: Claude Code, autonomous, in the style of PhoneFold's PLAN.md
Repo: new, `~/Documents/Vibe_Coding/ButtFold/` (private until the honesty and licence sections are in place, then public). Independent of the PhoneFold repo: files are vendored with a provenance header, never referenced by path.

The name is a joke about an accidental butt-dial. The page can say so once, in the footer, and never again.

---

## 1. What ButtFold is

ButtFold has two jobs of equal weight:

1. **A working, honest, playable web version of PhoneFold.** A protein folds in the visitor's browser and the trajectory becomes music: contacts forming are note onsets, hydropathy sets pitch, secondary structure sets texture (helix a sustained pad, sheet a staccato figure, coil an arpeggio), compaction drives a tempo map, five switchable style profiles, and spatial placement of each note where its residue sits.
2. **A front page and advertisement for the Apple apps.** PhoneFold is on App Store Connect awaiting review. ButtFold links out to it the moment it is live, and later to PhoneFold Studio, BOFFIN, JUMPjet, HAWKER and PfamIE. Someone who plays with ButtFold and then downloads PhoneFold must recognise it immediately, so ButtFold looks and feels as close to the Apple app as a web page can. That is a requirement, not a preference.

It runs on the DigitalOcean droplet (3.8 GB RAM, 62 GB disk, nginx in front) at **buttfold.mdeller.com, port 8007** (8003 to 8006 are taken by the existing apps), with one entry in the mdeller.com launcher's `apps.json`.

Marc's standing rule applies throughout: heavy structural compute runs on the Mac and ships a JSON artefact, never on the droplet. The one deliberate exception is architecture B below, which is small, capped, queued and cached, and whose viability is measured before it is built.

---

## 2. The three architectures and how they compose

All three are wanted. They are not alternatives; they are one pipeline with three frame sources.

| | What | Compute | Role |
|---|---|---|---|
| **A. Baked gallery** | Mac precomputes trajectories, bakes them to compact JSON, Flask serves them, the browser draws and sonifies | Zero droplet, zero visitor | The always-works foundation and the instant first paint. Every visitor gets this, including phones, old browsers and crawlers |
| **C. WASM live fold** | `go_model_fold.c` (298 lines, no dependencies) compiled with Emscripten, run in a Web Worker on the visitor's machine | Zero droplet, visitor's CPU | The primary interactive path: a genuinely live fold, streamed frame by frame into the same player |
| **B. Droplet queue** | The same C compiled natively on the droplet, one job at a time, hard-capped by residue count, progress page, result cache | Droplet CPU, bounded | The fallback for browsers that cannot run the WASM module, and the path for anything too heavy for a phone browser |

**The composition.** The page loads and the baked gallery plays immediately: no wait, no capability check, no compute. A "Fold it live" control feature-detects `WebAssembly` plus `Worker` plus `AudioContext`; if present, C runs in a worker and streams frames. If absent, or if the chosen protein exceeds the browser cap, the same button submits to B, shows a queue-position and progress page, and the finished trajectory lands in the server cache and plays through the identical player. A protein B has folded once is baked into the cache forever, so B converges towards A over time.

**One player.** Everything downstream of "a stream of CA frames" is shared: `ContactTracker.js` (8.0 Å formation, 8.5 Å break, minimum separation 3), `PSEA.js` (helix/sheet/coil from CA geometry), `Sonifier.js`, the Web Audio engine, the 3D stage, the readouts and the charts. Baked artefacts additionally carry precomputed contacts and secondary structure per frame (the Watch lesson: the client does no geometry it does not have to), so path A never touches the geometry code; paths B and C compute geometry in the worker as frames arrive.

**What does not port.** Genie 2 needs Core ML or 2 GB of torch and a GPU; the droplet has neither (measured on the Mac: 15 s per 1000-step trajectory on GPU via Core ML, 116 s on CPU via PyTorch). So generated backbones are precomputed on the Mac and served as gallery entries under A, labelled with the generative disclosures. Haptics do not exist in iOS Safari and are dropped. The synthesiser is a reimplementation in Web Audio, not a port. Spatial audio ports well: `AVAudioEnvironmentNode` with HRTF maps directly to Web Audio's `PannerNode` with `panningModel: 'HRTF'`.

---

## 3. Phase 0: measurement first

The whole design rests on two numbers that are currently estimates, and Marc's rule is that estimates are labelled and then measured. **Nothing else is built until these rows exist in METRICS.md.**

What is measured (all existing numbers below are real, from the M1 Max, in C, 2,000,000 steps):

| protein | residues | M1 Max fold time | final Q | RMSD |
|---|---|---|---|---|
| trp-cage TC5b | 20 | 9.0 s | 0.973 | 0.68 Å |
| protein G B1 | 56 | 76.7 s | 1.000 | 0.79 Å |
| ubiquitin | 76 | 152.0 s | 0.984 | 1.03 Å |

### Experiment P0-1: droplet native speed

`scp` the vendored `go_model_fold.c` to the droplet, `gcc -O2 -o go_fold go_model_fold.c -lm`, run trp-cage and ubiquitin with the app's parameters (`--steps 2000000 --kT 1.0 --kT-final 0.6 --seed 1`), under `nice -n 19`, while the other apps are serving. Record wall seconds and peak RSS. The prior estimate, which is an estimate and is superseded by this experiment, is that a shared vCPU is roughly 2.5 to 4x slower than the M1 Max for scalar float work, putting ubiquitin at perhaps 6 to 10 minutes of pinned CPU.

**Decision rule:** if trp-cage completes in under 60 s and ubiquitin in under 15 min, B ships as planned with the residue cap at 76. If ubiquitin exceeds 15 min, the B cap drops to the largest protein that finishes inside 15 min. If even trp-cage exceeds 5 min, B is demoted to a nightly cache-warmer with no on-demand jobs at all, and the fallback for non-WASM browsers becomes the baked gallery alone.

### Experiment P0-2: WASM speed

`emcc -O3 go_model_fold.c -o go_model.js` (details in §5.4), run trp-cage and protein G in Chrome, Safari and Firefox on the M1 Max, and in mobile Safari on Marc's iPhone. Record wall seconds per browser. The prior estimate, again an estimate and superseded by this experiment, is 1.5 to 2x native, so trp-cage at perhaps 15 to 20 s in a laptop tab.

**Decision rule:** the fold is the show, so a slow fold that streams frames is content, not a wait. But: if WASM comes out worse than 5x native, or mobile Safari cannot complete trp-cage in under 2 min, the default live protein on phones drops to trp-cage only and the pill for larger proteins routes to B. If Safari (desktop) fails to run the module at all, C is desktop-Chrome/Firefox-only and B carries the rest, which materially raises the stakes on P0-1.

### Experiment P0-3: WASM parity

The C is already validated against the Swift port to better than 1e-9 in forces. Repeat that bar for the WASM build: `--forces` output at step 0 agrees with the native binary to 1e-9, and a full same-seed trp-cage fold lands within 0.02 of the native build's Q and within 0.1 Å of its RMSD. (Bitwise trajectory identity across compilers is not required and not expected; endpoint agreement is.)

### Experiment P0-4: baked payload size

Bake the six Watch proteins in the 3D web format (§5.3) and weigh the file. The Watch reference points: six 2D folds in 232 kB; the bundled gallery is 12 trajectories in 2.4 MB. The 3D format with per-frame contacts and secondary structure is expected to be larger; the number goes in METRICS.md and the budget is 4 MB for the launch gallery, revisited if measurement says otherwise.

Every result goes in `METRICS.md` with the machine, browser and date. No number from this section may be quoted anywhere else in the project until it is a measured row there.

---

## 4. Ledger files and execution contract

Same contract as PhoneFold, because it works:

| File | Purpose |
|---|---|
| `PLAN.md` | This document, copied into the repo root. Read-only reference |
| `STATE.md` | Current phase, ordered task list, status `todo` / `doing` / `blocked` / `done` |
| `METRICS.md` | Measured numbers only. No estimates, ever |
| `BLOCKERS.md` | Questions needing Marc, dated, with options and a recommendation |
| `JOURNAL.md` | Append-only, one entry per work session |

Phases advance on machine-verifiable gates (§11). Human-verifiable criteria (does it sound right, does it look like the app) halt for Marc; the agent never marks them met. Per the house rule: finishing a phase is not a question - commit, push, deploy where the phase says so, and start the next.

---

## 5. Architecture

### 5.1 Repo layout

```
ButtFold/
├── app.py                     # Flask app, all routes
├── buttfold/
│   ├── queue.py               # job queue for architecture B
│   └── store.py               # baked-artefact and result-cache access
├── native/
│   └── go_model_fold.c        # vendored from PhoneFold with provenance header
│                              #   (source repo + commit SHA); never edited except
│                              #   the additive WASM wrapper in wasm_api.c
│   └── wasm_api.c             # ~40 lines: init/step-block/frame-pointer exports
├── tools/
│   ├── bake_gallery.py        # the Mac-side baker (adapted from PhoneFold's
│   │                          #   Tools/make_fold_of_the_day.py, see §5.3)
│   ├── psea.py                # Python PSEA, used by the baker AND as the
│   │                          #   fixture generator for PSEA.js
│   ├── build_wasm.sh          # emcc invocation, pinned emsdk version
│   └── audit_wiring.py        # the "who calls this" check, §10
├── static/
│   ├── buttfold.css
│   ├── js/                    # ContactTracker.js, PSEA.js, Sonifier.js,
│   │                          #   MusicalScale.js, audio.js, stage.js, player.js
│   ├── wasm/go_model.{js,wasm}
│   ├── styles/*.json          # the five profiles, copied verbatim
│   ├── baked/gallery.json     # the baked artefact (generated, committed)
│   └── links.json             # App Store links + live flags, §8
├── templates/index.html
├── tests/                     # pytest + node parity tests
├── deploy.sh
├── nginx/buttfold.conf
├── PLAN.md  STATE.md  METRICS.md  BLOCKERS.md  JOURNAL.md  README.md
```

Flask is correct here despite the vibe-coding skill's "never Flask" line: that rule governs single-file browser apps, and ButtFold is a droplet-hosted service with a queue, like AlphaFraud and FlexAppeal. The skill's other conventions (header, typography, launcher, deploy hygiene) all apply and are taken up in §6 and §9.

### 5.2 Endpoints

| Route | Method | Serves |
|---|---|---|
| `/` | GET | The one page. `Cache-Control: no-cache, must-revalidate` set explicitly in Flask, because Flask sends no Cache-Control on templates and heuristic caching otherwise pins the old `?v=` asset URLs and makes CSS/JS deploys invisible |
| `/api/gallery` | GET | Index of baked folds: id, name, residues, organism, provenance, engine, quality summary |
| `/api/fold/<id>` | GET | One baked artefact (§5.3). Immutable per content hash, long cache |
| `/api/queue` | POST | Submit a B job: `{protein_id, seed}`. Returns 202 `{job_id}` or 429 when full. Whitelisted proteins only, no arbitrary uploads at launch |
| `/api/queue/<job_id>` | GET | `{state, position, frames_done, frames_total}`. Progress read from the growing binary frame file's size: the stream format is two little-endian int32 (n, frames) then float32 xyz triples, so bytes map to frames exactly |
| `/api/queue/<job_id>/result` | GET | The finished trajectory, baked into the same artefact format on completion |
| `/healthz` | GET | 200 + version string, for the launcher's health check |
| `/static/...` | GET | Assets, all referenced with `?v=<hash>`, long cache via nginx |

### 5.3 The baked artefact

`tools/bake_gallery.py` adapts `make_fold_of_the_day.py`, whose hard-won decisions carry over verbatim:

- **Bake from the Gō model, never from the bundled ESMFold trajectories.** The first Watch bake was thrown away because those trajectories are already folded: 137 of protein G's 210 contacts formed on frame 1 and the width changed by one part in a thousand. Every upstream check passed; only the end-to-end one failed. The baker therefore **asserts collapse**: `Rg_end / Rg_start ≤ 0.8` (measured folds range 0.47 to 0.73) and first-frame contacts below 25% of the trajectory total. A bake that fails either assertion aborts loudly.
- **One scale per trajectory, from the widest frame.** Per-frame normalisation draws a coil and a folded core the same size and deletes the subject.
- **Translate per frame (each frame centred on its own centroid), scale once.** Centring on the folded centroid drifts the coil off-frame; centring on the trajectory bounding box breaks the ending.
- **Quantise to integers in a ±1000 box**: a tenth of a per cent of the structure's width.
- **Compute contacts at bake time with the app's exact hysteresis** (8.0 in, 8.5 out, separation ≥ 3) so gallery playback does no geometry.
- Cooling, not more steps: kT 1.0 → 0.6 (measured: took a fold from 0.86 Å to 0.23 Å for free). And never fewer steps as a shortcut: 200,000 steps stops at Q = 0.49, a chain that has collapsed but not packed.

Differences from the Watch format: coordinates are **3D** (the browser stage orbits), and each frame carries the sonifier's inputs.

```jsonc
{
  "version": 1,
  "generated": "...",
  "quantisedRange": 1000,
  "folds": [{
    "id": "ubiquitin",
    "name": "Ubiquitin",
    "organism": "Homo sapiens",
    "residueCount": 76,
    "sequence": "MQIFVK...",            // hydropathy → pitch needs it, once
    "engine": "go",                     // "go" | "generative" (baked Genie 2)
    "provenance": "structure-based-go",
    "quality": { "nativeFraction": 0.984, "rmsdToNative": 1.03,
                 "radiusOfGyrationStart": 21.3, "radiusOfGyrationEnd": 11.5,
                 "seconds": 152.0 },
    "frames": [{
      "points": [x0,y0,z0, ...],        // int, ±1000
      "newContacts": [[i,j], ...],      // pairs, because |i-j| sets register
      "ss": "18C9H4C...",               // run-length H/E/C
      "rg": 213,                        // Å × 10, int
      "q": 984                          // native fraction × 1000, int
    }]
  }]
}
```

Launch gallery: the six measured Gō folds (trp-cage, WW domain, villin HP36, protein G B1, alpha-3D, ubiquitin) plus 2 to 4 precomputed Genie 2 backbones baked on the Mac. Frame cap ~150 per fold, interpolated in the browser. The Gō runs are cached on the Mac exactly as `make_fold_of_the_day.py` caches them, keyed on every parameter, because the folds cost minutes and the projection/format work is what gets iterated.

### 5.4 The WASM module boundary

Two milestones, deliberately in this order:

1. **Compile the CLI untouched.** Emscripten runs `main()` against MEMFS: write `--native` input in, read the binary frame stream out. This proves the toolchain and feeds experiment P0-3 with zero new C.
2. **Add `native/wasm_api.c`**, roughly 40 lines that `#include` nothing new and call the existing force/integrate routines: `bf_init(native_ptr, n, kT, kT_final, dt, gamma, seed)`, `bf_step(steps)`, `bf_positions() -> float*`, `bf_free()`. The physics in `go_model_fold.c` is not edited; the wrapper is additive. Build with `-O3 -s MODULARIZE=1 -s EXPORTED_FUNCTIONS=...` via `tools/build_wasm.sh`, emsdk version pinned in the script.

Runtime shape: the module runs in a **Web Worker**; the main thread posts `{protein, seed}` and receives frames by `postMessage` (a copied `Float32Array` every N steps, N chosen so frames arrive at ~15 to 30 per second of playback). No SharedArrayBuffer, so no COOP/COEP header burden. The worker also runs `ContactTracker.js` and `PSEA.js` so the main thread receives ready-to-score frames identical in shape to a baked frame. nginx must serve `.wasm` as `application/wasm` or streaming compilation silently degrades.

### 5.5 The B queue

- The **native binary** on the droplet (compiled once by `deploy.sh`), never Python: 298 lines of C, no torch, no numpy, RAM measured in P0-1 and expected trivial.
- **One worker process, one job at a time**, `nice -n 19`, spawned by a small queue runner inside the Flask app's process group (systemd unit owns both). Queue depth cap 5, one pending job per IP, 429 beyond either cap.
- **Residue cap set by P0-1**, placeholder 76 (ubiquitin) until measured.
- **Job timeout**: 3x the measured time for the largest permitted protein; a timed-out job is killed and reported honestly.
- **Result cache**: key = SHA-256 of (protein id, steps, kT, kT_final, seed); finished jobs are baked server-side into the §5.3 format and stored under `static/cache/`. Since inputs are whitelisted, the cache converges to a finite set and B stops costing CPU.
- Progress is read from the output file's byte count against the expected frame count. No progress-parsing of stdout.

### 5.6 Caching

- HTML: `no-cache, must-revalidate` from Flask (the gotcha above).
- Static assets and baked JSON: `?v=<content hash>` in the template plus a long `Cache-Control` from nginx. Remember the nginx trap already bitten elsewhere: **headers set in a `location` block replace those set outside it**, so `Cache-Control` goes in every location that needs it, not once at server level.
- `/api/queue/*`: `no-store`.

---

## 6. Visual specification

This section must be built exactly, because "looks like the Apple app" is a requirement. All hex values are taken from the live app by frequency of use, and the stage colour was measured from a render, not computed.

### 6.1 Palette (CSS custom properties)

```css
:root {
  --bf-ground:        #0B0A1F;   /* page ground */
  --bf-ground-deep:   #05040E;   /* page gradient floor, footer */
  --bf-ground-raised: #181432;   /* cards, pills at rest */
  --bf-stage:         #0D0D26;   /* 3D stage clear colour: sRGB of the app's
                                    linear RGB (0.047, 0.039, 0.122), measured */
  --bf-action:        #2B5CE6;   /* primary blue: buttons, selected pills */
  --bf-text-2:        #6B7C93;   /* secondary text */
  --bf-text-3:        #B6BFD0;   /* dim text */
  --bf-text-4:        #8A93A8;   /* dimmer text */
  --bf-cyan:          #22E5FF;   /* accent; sheet on the ribbon */
  --bf-magenta:       #FF3D9A;   /* accent + error text; helix on the ribbon */
  --bf-amber:         #FCB900;   /* amber: disclosure line, logo dot */
  --bf-pale-blue:     #8FB4FF;
}
```

Ribbon colouring, the thing a viewer actually sees: **helix magenta `#FF3D9A`, sheet cyan `#22E5FF`, coil slate** (use `#6B7C93`). Also implemented, switchable exactly as in the app: the colour-blind-safe alternative palette, and the confidence ramp (orange below 50, amber below 70, green above 70).

### 6.2 The house header, reconciled

The `marcs-vibe-coding` skill's header **structure** is mandatory: amber logo dot, "Marc C. Deller, D.Phil." linking to marcdeller.com, the contact link, sticky, never overlapping content. The same skill says the header is styled from the app's own palette, not the default blue, so **ButtFold's header sits on `--bf-ground` with `--bf-action` link accents**, and the logo dot stays `#FCB900`, which happens to be both the skill's amber and PhoneFold's amber. Register the direction in the skill's table as: ButtFold, "PhoneFold indigo: near-black ground, `#2B5CE6` / `#22E5FF` / `#FF3D9A`".

### 6.3 Typography

The app uses the system font; the closest web equivalent under the house rules is **Inter** for UI and **Roboto Mono** for readouts and numbers, loaded from Google Fonts with real fallback stacks. British English, no em dashes, anywhere.

### 6.4 Layout, from the app's screenshots

Top to bottom, one column, max-width ~1100 px, phone-first:

1. **House header** (§6.2).
2. **Title block**: the protein name as a large title, and directly beneath it, in `--bf-amber`, the engine disclosure line (§7). Exactly as the phone app places it.
3. **Pill rows**: small rounded segmented controls, `--bf-ground-raised` at rest, `--bf-action` fill with white text when selected, for: **colour mode** (structure / colour-blind-safe / confidence), **engine** (Gallery / Live fold / Queued), **style** (Fantasy / Jazz / Pop / Rock / Surf), and **protein-size gate** where the engine pill needs it.
4. **The stage**: a large dark panel clearing to `--bf-stage`, occupying roughly the lower half of the viewport on a phone, ribbon centred, orbitable by drag. Rendering: three.js (pinned CDN version) tube geometry along a Catmull-Rom spline through the CA trace, coloured per residue by SS. The stage carries a small persistent engine badge in one corner (§7).
5. **Live readouts row** beneath the stage, Roboto Mono: Rg, compactness, contacts, native %, helix/sheet/coil percentages. Values update per frame.
6. **Two small line charts**: secondary-structure content over time and radius of gyration over time. Plain canvas, no chart library needed for two sparklines.
7. **Transport**: play/pause, seek, volume, and the audio-start gesture (browsers refuse an AudioContext before a user gesture, so the fold does not auto-sound; the play button is the gesture).
8. **The gallery**: a horizontally scrolling row of protein cards, each with name and a "N residues · organism" subtitle (e.g. "76 residues · Homo sapiens"; designed proteins read "20 residues · designed"; generative entries read "a protein that has never existed"). Selected card gets the `--bf-action` outline.
9. **The shop window** (§8), then the house footer.

Human-verifiable gate at the end of Phase 5: Marc puts a ButtFold screenshot next to a PhoneFold screenshot and judges the resemblance. The agent never marks this one.

---

## 7. Honesty: what appears where

The disclosures survive the port verbatim and live in the frame, not in an About page. A web page reaches people with no context, so this matters more here, not less.

| Text (verbatim) | Where it appears |
|---|---|
| "Simulated on device toward a known structure — not a prediction" * | The amber line directly under the title whenever a Gō fold is on stage (gallery, live or queued) |
| "A smooth interpolation into the known structure. Not physics" | Same position, if and when a morph engine is added; not in scope for v1 |
| "Genie 2 invents a backbone from noise. Not a named protein" | Same position, whenever a generative gallery entry is on stage |
| "A protein that has never existed" | The generative entries' gallery-card subtitle |

\* the string is preserved exactly, em dash included, because it is a quotation from the shipped app; ButtFold's own prose still uses no em dashes. For live browser folds the stage badge (below) carries the accurate location.

Two additions ButtFold needs because its readers arrive from search engines:

- **A persistent stage badge**, small, in the stage's corner, always visible while anything plays: `Gō model · toward a known structure` / `Genie 2 · invented from noise`, with `in your browser` / `precomputed` / `on the server` appended per path. It never scrolls away while the animation runs.
- **ButtFold's own one-paragraph equivalent of the README disclosure**, placed between the gallery and the shop window, styled as body text, not hidden behind a link. Proposed wording, for Marc to approve in BLOCKERS.md before launch: "ButtFold shows a simple physics model relaxing a chain into a structure it already knows, and what a generative network's inventions look and sound like. It is not a prediction of an unknown structure, it is not a physical folding pathway, and no protein folds this way. The music is a faithful map of the simulation's events, and nothing more."

Machine-verifiable: the Phase 5 gate greps the **served** HTML (a live GET, not the template file) for the verbatim strings.

---

## 8. The shop window

A full-width section between the disclosure paragraph and the footer, plus one compact line in the header area ("Get PhoneFold for iPhone, iPad, Mac, Watch and Vision Pro →" anchoring to the section).

- **PhoneFold card**: icon, one sentence, platform row, and the official Apple "Download on the App Store" badge artwork.
- **"More from Marc" row**: cards for BOFFIN, JUMPjet, HAWKER, PfamIE, and later PhoneFold Studio, each with a one-line description and its link.

**Before/after live is data, not code.** `static/links.json` holds per app: `{ "id", "name", "blurb", "app_store_url": null, "fallback_url": "https://github.com/bellcheddar/PhoneFold", "status": "in_review" }`. While `app_store_url` is null the card shows a non-dimmed "In review at the App Store" tag and links to the fallback (the GitHub repo, or the app's write-up). When PhoneFold goes live, editing one field and redeploying flips the card to the official badge and the store URL. No template edit, no code path change: which means the flip can be verified by diffing two GETs of the live page.

App Store links use the plain `https://apps.apple.com/app/id<N>` form. The App Store Connect app ids are known to Marc's account; they go into `links.json` when each record exists (HAWKER's is 6806223048).

---

## 9. Deployment

- **Port 8007**, gunicorn behind nginx, systemd unit `buttfold.service` owning gunicorn and the queue worker.
- **nginx vhost** `buttfold.mdeller.com`: its own server block and its **own certbot cert** (`certbot --nginx -d buttfold.mdeller.com`; the mdeller.com cert does not cover subdomains). The droplet runs nginx 1.24.0, so the http2 patch is `listen 443 ssl http2;` on the listen line, not the 1.25.1 `http2 on;` form; read an existing vhost first (`grep -h "listen 443" /etc/nginx/sites-available/*`). Own access log so the launcher's counters stay clean. `application/wasm` MIME confirmed. Long-cache `Cache-Control` in each static location (locations replace, not merge). The shared long-cache snippet and http2 patch that every vhost on this box gets.
- **Launcher entry**: one new entry at the **top** of `mdeller-landing/apps.json` (`"id": "buttfold"`, `"status": "building"` until live, then `"live"`), then `./deploy.sh` in that repo. ButtFold serves local assets, so the hit beacon can watch a real sub-resource; give the favicon a short max-age anyway.
- **`deploy.sh`** in ButtFold: rsync, remote `gcc` build of the queue binary, chown, restart. The remote block runs under `set -e`, and the known failure mode is an early abort skipping chown+restart while rsync looks fine, leaving the old build serving. So the script's last act is verification, not the restart: `systemctl is-active`, a GET of `/healthz` asserting the **new version string**, and a GET of a route added in this deploy. Deploying and then fetching the live page back is the definition of done; the script exiting 0 is not.
- The Cache-Control gotcha is handled in code (§5.6) and re-verified at deploy time **with a plain GET, not `curl -I`** (HEAD responses have lied about this before).
- Never link anything here through htmlpreview.github.io.

---

## 10. Testing: verify the artefact, not the intent

PhoneFold's recurring lesson, four times in two days: a feature split across two places, one half complete and authoritative-looking, the other never reached, invisible to build and tests alike. Three were found by asking "who calls this", the fourth by inspecting a real release artefact. ButtFold builds both habits in:

1. **`tools/audit_wiring.py`**, run in CI and by the phase gates: every Flask route is referenced by at least one template or JS file; every JS module shipped is imported by the page or a worker; every style JSON is listed in the style pill; every gallery id in `gallery.json` has a card; `links.json` ids match the shop-window cards. Anything declared and never reached fails the build.
2. **Bake-time assertions** (§5.3): collapse ratio and first-frame contact fraction. These are the checks that would have caught the thrown-away Watch bake before a human did.
3. **Parity fixtures.** The JS ports are tested against reference outputs, not against themselves: `psea.py` generates SS fixtures for `PSEA.js`; a one-off Swift dump from PhoneFoldKit's test target (run once on the Mac, committed to `tests/fixtures/`) provides Sonifier reference scores; the Node test runs `Sonifier.js` over a baked fold and asserts note-for-note identity (pitch, velocity, beat, voice) with the fixture. WASM parity per P0-3.
4. **A deterministic score hash.** `Sonifier.js` seeded on a baked fold must produce a stable event-list hash; the E2E test computes it in Node headlessly, so "the music generation works" is checkable without ears. What it *sounds* like remains human-verifiable.
5. **Live checks after every deploy** (§9), including grepping the served page for the three verbatim honesty strings and for the current asset hash.
6. **Screenshot non-uniformity check** (the house rule): any committed screenshot is asserted non-uniform before it is believed.

pytest for Flask routes, queue caps (submit 6, assert the 429), cache behaviour and the baker; `node --test` for the JS units.

---

## 11. Build phases and exit gates

Budgets are working estimates, not measurements, and say so. Each phase ends with commit, push, and where stated a deploy; the next phase starts in the same session.

### Phase 0: Measurement (gate: METRICS.md rows exist)
Repo skeleton, ledger files, vendor the C, run experiments P0-1 to P0-4.
**Exit gate (machine):** METRICS.md contains droplet times for trp-cage and ubiquitin, WASM times for trp-cage and protein G in at least two desktop browsers plus mobile Safari, the parity result, and the baked payload size. The B residue cap and the phone live-fold policy are written into STATE.md from the decision rules in §3.

### Phase 1: Baked gallery, silent (gate: the page plays a real collapse)
`bake_gallery.py` + `psea.py`, the six Gō entries baked with assertions green; Flask serving `/`, `/api/gallery`, `/api/fold/<id>`, `/healthz`; the stage, readouts, charts and gallery cards rendering and animating baked folds; palette and layout per §6.
**Exit gate (machine):** bake assertions pass for all six; `curl localhost:8007/api/gallery` lists ≥ 6; audit_wiring.py green; a headless screenshot of the stage mid-fold is non-uniform; frame 1 vs final frame of the served artefact differ in Rg by the asserted ratio.

### Phase 2: Sound (gate: note-for-note parity)
`ContactTracker.js`, `PSEA.js`, `MusicalScale.js`, `Sonifier.js`, the Web Audio engine (per-voice: `OscillatorNode`/`PeriodicWave` from the profile's `harmonics`, ADSR via gain envelopes, `WaveShaperNode` for `drive`, an LFO for `tremoloHz`/`tremoloDepth`, `detuneCents` as a second detuned oscillator, `PannerNode` HRTF placing each note at its residue's stage position; a lookahead scheduler, no AudioWorklet needed since notes are discrete events). All five style JSONs load unchanged.
**Exit gate (machine):** PSEA.js matches psea.py fixtures exactly; Sonifier.js matches the Swift fixture note-for-note on one fold; score hash stable across two runs; all five styles produce a non-empty score.
**Human gate:** Marc listens to ubiquitin in two styles against the phone app. HALT until cleared.

### Phase 3: WASM live fold (gate: a browser folds trp-cage)
Milestones 1 then 2 of §5.4, worker wiring, live path through the same player, feature detection and the phone policy from Phase 0.
**Exit gate (machine):** in headless Chrome, a seeded trp-cage live fold reaches Q ≥ 0.95 (native measured 0.973) and streams ≥ 100 frame messages; step-0 forces match native to 1e-9; the live path and the baked path produce byte-identical frame objects for the same trajectory input.

### Phase 4: The queue (gate: caps hold and the cache converges)
§5.5 built with the Phase 0 caps.
**Exit gate (machine):** pytest proves: job completes and result plays through the player; second identical request is a cache hit (no process spawned); 6th queued job gets 429; oversized protein gets 400 with an honest message; timeout kills and reports.

### Phase 5: Shop window, honesty, polish (gate: the strings are live)
§7 and §8 complete, links.json wired, colour-blind palette and confidence ramp, mobile pass, footer with the one butt-dial joke.
**Exit gate (machine):** the three verbatim disclosure strings and the approved disclosure paragraph appear in a live GET of `/`; flipping a links.json field flips the card between fallback and store badge in the served page.
**Human gates:** disclosure paragraph wording approved; side-by-side screenshot resemblance approved. HALT until cleared.

### Phase 6: Deploy and list (gate: live and verified from outside)
§9 end to end: cert, vhost, systemd, deploy.sh with its verification tail, launcher entry to the top of apps.json, README to the house standard via the marcs-vibe-coding skill (screenshot included, To Do roadmap included).
**Exit gate (machine):** `https://buttfold.mdeller.com/healthz` returns the deployed version from an external fetch; the launcher shows a green dot; Cache-Control verified with GET on `/` (no-cache) and one asset (long); the wasm serves as `application/wasm`; audit_wiring.py green on the deployed tree.

---

## 12. To Do

- [ ] **Phase 0, measurement**: droplet native fold times (trp-cage, ubiquitin), WASM fold times in 3 browsers + mobile Safari, WASM parity vs native, baked 3D payload size; decisions written into STATE.md
- [ ] **Repo skeleton**: ledger files, vendored `go_model_fold.c` with provenance header, licence
- [ ] **Baker**: `bake_gallery.py` + `psea.py` with the collapse and first-frame assertions; six Gō entries baked
- [ ] **Flask core**: `/`, `/api/gallery`, `/api/fold/<id>`, `/healthz`, explicit Cache-Control
- [ ] **Stage and readouts**: three.js ribbon, SS colours (helix `#FF3D9A`, sheet `#22E5FF`, coil slate), readout row, two sparklines, gallery cards
- [ ] **JS geometry ports**: ContactTracker.js, PSEA.js, fixture parity green
- [ ] **Sonifier.js + MusicalScale.js**: note-for-note parity with the Swift fixture
- [ ] **Web Audio engine**: five profiles unchanged, HRTF panning, gesture-gated AudioContext
- [ ] **WASM build**: untouched-CLI milestone, then `wasm_api.c` streaming exports, worker wiring
- [ ] **Queue**: single worker, caps from Phase 0, result cache, progress by byte count
- [ ] **Honesty placements**: title-adjacent amber line, stage badge, disclosure paragraph (wording to Marc)
- [ ] **Shop window**: PhoneFold card + More-from-Marc row, `links.json` before/after mechanism
- [ ] **Genie 2 gallery entries**: 2 to 4 backbones baked on the Mac, generative labels on card and stage
- [ ] **audit_wiring.py**: routes/modules/styles/cards all reachable, wired into gates
- [ ] **Deploy**: cert, vhost (http2 on the listen line, wasm MIME, per-location Cache-Control), systemd, deploy.sh with live-fetch verification
- [ ] **Launcher**: apps.json entry at the top, beacon, green dot
- [ ] **README** via the marcs-vibe-coding skill: badges read from the droplet, screenshot, this To Do mirrored
- [ ] **Flip to live**: when PhoneFold clears review, set its `app_store_url`, redeploy, verify the badge in the served page

## 13. Risks, honestly

- **WASM performance is unmeasured.** If it lands worse than 5x native, phones cannot fold anything but trp-cage live and C stops being the primary path on mobile; the gallery and B absorb it. If Safari cannot run the module at all, C is partial and B's measured viability decides how much interactivity non-Chrome visitors get. This is why Phase 0 exists and why nothing is built before it.
- **Droplet folding is unmeasured and could be disqualifying.** The 6-to-10-minute ubiquitin figure is an estimate. If measurement says 30 minutes of pinned CPU on a 3.8 GB box that is already serving four apps, on-demand B dies (the decision rule demotes it to a cache-warmer) and the plan survives, because A and C carry the product. B is the only architecture with a kill condition.
- **Sound-alike is a judgement call.** The Web Audio engine is a reimplementation; parity tests guarantee the notes, not the timbre. Marc's ear is the gate, and a miss costs an iteration loop on the voice synthesis, not the architecture.
- **The resemblance requirement can silently fail.** Hex values and layout are specified, but "feels like the app" is human-verified, and Apple's SF font is not licensed for the web; Inter is close, not identical.
- **Queue abuse.** Caps, whitelisted inputs and per-IP limits bound it; the worst case is a full queue returning 429, never a saturated droplet, because there is exactly one worker at nice 19.
- **Trademark care in the shop window**: use Apple's official badge artwork under its usage rules, and never imply the apps are live before they are; `links.json` makes the honest state the default.
- **The name.** ButtFold is a deliberate joke and will look like one in a search index. Accepted; the page's substance and the disclosure paragraph carry the credibility.
