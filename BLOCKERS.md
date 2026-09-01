# ButtFold: blockers

Questions that need Marc. Each one is dated, states the options, and gives a recommendation
so that answering it is a yes or a no wherever possible. Resolved entries stay, struck
through, so the reasoning survives.

**Status, 2026-09-01: Phases 0 to 5 are built and every machine-verifiable gate is green.**
Five things need you. Number 1 is the only one that blocks further building.

---

## 1. OPEN: Phase 6 is the deploy, and it is outward-facing

Everything it needs is written and green locally. What it does is not like anything in
Phases 0 to 5:

- creates a **new public subdomain**, `buttfold.mdeller.com`;
- obtains its **own certbot certificate** (the mdeller.com cert does not cover subdomains);
- adds a systemd unit and an nginx vhost to the droplet;
- puts an entry at the **top of the launcher's `apps.json`**, which publishes ButtFold to
  everyone who visits mdeller.com.

That last step is the one worth a deliberate yes. The app is honest and the disclosures are
in place, but it is a joke name attached to your own front page, and the decision to point
the world at it is yours rather than mine.

**Recommendation:** deploy it, but list it in the launcher as `"status": "building"` until
you have looked at the live site, then flip to `"live"` in a second one-line change.

Say the word and I will do §9 end to end: cert, vhost with the nginx 1.24 `listen 443 ssl
http2` form and the `application/wasm` MIME type, systemd for gunicorn plus the queue
worker, `deploy.sh` whose last act is a live GET asserting the new version string, and the
launcher entry.

## 2. OPEN: does it sound right? (Phase 2's human gate)

The machine half is as strong as it can be: `Sonifier.js` reproduces PhoneFold's own
`FoldAudio.Sonifier` **note for note**, 15,536 notes across two folds and all five styles,
zero differences in voice, pitch, velocity, residue, partner, beat offset or duration. What
that guarantees is the notes. It does not guarantee the timbre, because the Web Audio engine
is a reimplementation rather than a port, and PLAN section 13 says as much.

Your ear is the gate. It is running right now:

```
cd ~/Documents/Vibe_Coding/ButtFold
./.venv/bin/python app.py                    # already running on 8007
```

Open `http://127.0.0.1:8007/`, pick **Ubiquitin**, press Play, and switch between
**Fantasy** and **Jazz** against the phone app.

## 3. OPEN: the disclosure paragraph wording (Phase 5's human gate)

This is live on the page now, exactly as PLAN section 7 proposed it:

> ButtFold shows a simple physics model relaxing a chain into a structure it already knows,
> and what a generative network's inventions look and sound like. It is not a prediction of
> an unknown structure, it is not a physical folding pathway, and no protein folds this way.
> The music is a faithful map of the simulation's events, and nothing more.

`tests/test_honesty.py` asserts that exact text against the served page, so changing a word
means changing the template and the test together. Approve it or rewrite it.

## 4. OPEN: the side-by-side resemblance (Phase 5's human gate)

"Looks like the Apple app" is a requirement and it is human-verified. Current screenshots:
`build/p0/stage.png` (desktop) and `build/p0/stage-mobile.png` (390 x 844). Put one next to
a PhoneFold screenshot. The agent never marks this met.

The known gap, stated in advance: Apple's SF is not licensed for the web, so the type is
Inter. Everything else - the palette, the amber disclosure line under the title, the pill
rows, the stage colour, helix magenta and sheet cyan - is the app's own.

## 5. OPEN: two P0-2 rows, about five minutes each

Neither blocks anything; they are the last two cells in the Phase 0 table.

### Safari's protein G number, on your Mac

Safari runs the module fine - trp-cage in 20.35 s, 3.89x native, inside the 5x bar. Protein
G could not be measured because **Safari suspends the fold when its window is not visible**,
and this Mac sat at the login window for the long runs. Every WebContent process reported
0% CPU. Unlock the Mac, then:

```
cd ~/Documents/Vibe_Coding/ButtFold && python3 tools/bench/serve.py
```

open `http://127.0.0.1:8099/tools/bench/index.html?auto=1` in Safari and leave that window
in front for about five minutes. The result files itself under `build/p0/p02/`.

Or turn on Safari Settings, Advanced, "Show features for web developers", then Develop,
"Allow Remote Automation", once - after which I can take this and any future Safari
measurement without you.

### Mobile Safari on your iPhone

The one measurement no machine here can take, and the one that decides the phone policy.
With the bench server running and the phone on the same wifi:

```
http://192.168.1.99:8099/tools/bench/index.html?auto=1
```

Keep it in the foreground; it posts back to the Mac by itself. `...&proteins=trp_cage` is
the short version and answers most of the question. **What it decides**, from PLAN section
3: if mobile Safari cannot finish trp-cage in under 2 minutes, phones default to trp-cage
only and anything larger routes to the queue.

For the record, not a question: **Firefox is not installed on this Mac**, so its row is
absent rather than pending. The gate asks for two desktop browsers and Chrome plus Safari
meets it.

---

## DECISION TAKEN, 2026-09-01: the P0-3 RMSD bar is measured, not fixed

Not blocking; recorded here rather than only in METRICS.md because it changes a number
written in PLAN.md and you should be able to overturn it.

PLAN section 3 asks a WASM fold to land "within 0.1 Å" of the native fold's RMSD. On protein
G it lands 0.123 Å away and would fail. Before touching the bar, P0-3b measured what that
number does when nothing is wrong: the **same** build, folding the **same** coil, with only
the random-force seed changed, lands anywhere from 0.84 to 1.16 Å across five runs. A 0.1 Å
bar is narrower than the measurement's own noise, so no correct implementation can meet it,
the reference one included. Over those same five seeds, final Q was 0.993 every time.

The bar is restated: forces to 1e-9 (unchanged, met at 2.9e-15), Q to 0.02 (unchanged, met
at 0.007), and RMSD inside the native build's own measured seed range (replaces the fixed
0.1 Å, met at 0.88 Å inside 0.84 to 1.16 Å). Say if you would rather keep the fixed bar and
treat protein G as a known failure.

## DECISION TAKEN, 2026-09-01: the queue asks for a random seed each time

"Fold it again" should be a different trajectory, not a cache hit that looks like a very
fast fold. The cost is the seed-to-seed spread P0-3b measured: a queued trp-cage finished at
Q 0.892 to 0.973 where the gallery's seed-1 fold finishes at 1.000. All are good folds. Say
if you would rather the button be reproducible and always return seed 1.
