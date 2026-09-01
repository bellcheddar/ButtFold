# ButtFold: blockers

Questions that need Marc. Each one is dated, states the options, and gives a recommendation
so that answering it is a yes or a no wherever possible. Resolved entries stay, struck
through, so the reasoning survives.

---

## OPEN, 2026-09-01: two P0-2 rows need you, and they are the last of Phase 0

Everything else in Phase 0 is measured and in METRICS.md. These two cannot be taken without
you, and neither blocks Phase 1, which is being built meanwhile.

### 1. Safari's protein G number (5 minutes, your Mac)

Safari runs the module fine: trp-cage folded in 20.35 s, 3.89x the native build, well
inside the 5x bar. Protein G could not be measured because **Safari suspends the fold when
its window is not visible**, and this machine sat at the login window for the long runs.
Every WebContent process reported 0% CPU. Chrome does a weaker version of the same thing
(1.9x penalty in a background tab), and moving the fold into a Web Worker fixed Chrome but
not Safari.

Either of these gets the row:

- **Recommended, no settings changed.** Unlock the Mac, then:
  ```
  cd ~/Documents/Vibe_Coding/ButtFold && python3 tools/bench/serve.py
  ```
  open `http://127.0.0.1:8099/tools/bench/index.html?auto=1` in Safari and leave that window
  in front for about five minutes. The result files itself under `build/p0/p02/`.
- Or turn on Safari Settings, Advanced, "Show features for web developers", then Develop,
  "Allow Remote Automation", once. After that I can drive Safari with `safaridriver` and
  take this and any future Safari measurement without you.

### 2. Mobile Safari on your iPhone (5 minutes, your phone)

The one measurement no machine here can take, and the one that decides the phone policy: it
sets whether phones fold live at all, and if so up to what size. With the bench server
running on the Mac and the phone on the same wifi, open on the phone:

```
http://192.168.1.99:8099/tools/bench/index.html?auto=1
```

and keep it in the foreground. It posts back to the Mac by itself. If it is slow, use
`...?auto=1&proteins=trp_cage` for the short version; trp-cage alone answers most of the
question.

**What the answer decides**, from PLAN section 3: if mobile Safari cannot finish trp-cage
in under 2 minutes, the default live protein on phones drops to trp-cage only, and anything
larger routes to the droplet queue.

### Also, for the record, not a question

**Firefox is not installed on this Mac**, so its row is absent rather than pending. The gate
asks for "at least two desktop browsers" and Chrome plus Safari meets it. Say the word if
you want Firefox installed and measured.

---

## DECISION TAKEN, 2026-09-01: the P0-3 RMSD bar is measured, not fixed

Not blocking, and it is recorded here rather than only in METRICS.md because it changes a
number written in PLAN.md and you should be able to overturn it.

PLAN section 3 asks a WASM fold to land "within 0.1 Å" of the native fold's RMSD. On
protein G it lands 0.123 Å away and would fail. Before touching the bar, P0-3b measured
what that number does when nothing is wrong: the **same** build, folding the **same** coil,
with only the random-force seed changed, lands anywhere from 0.84 to 1.16 Å across five
runs. A 0.1 Å bar is narrower than the measurement's own noise, so no correct
implementation can meet it, including the reference one.

Over those same five seeds, final Q was 0.993 every time, to three decimals.

So the bar is restated: forces to 1e-9 (unchanged, met at 2.9e-15), Q to 0.02 (unchanged,
met at 0.007), and RMSD inside the native build's own measured seed range (replaces the
fixed 0.1 Å, met at 0.88 Å inside 0.84 to 1.16 Å). Say if you would rather keep the fixed
bar and treat protein G as a known failure.

---

## Coming in Phase 5: the disclosure paragraph wording

PLAN.md section 7 proposes this text, to sit between the gallery and the shop window, as
body text and not behind a link:

> ButtFold shows a simple physics model relaxing a chain into a structure it already knows,
> and what a generative network's inventions look and sound like. It is not a prediction of
> an unknown structure, it is not a physical folding pathway, and no protein folds this way.
> The music is a faithful map of the simulation's events, and nothing more.

Needs your approval verbatim before launch, because the Phase 5 gate greps the served page
for it.

## Coming in Phase 5: the side-by-side resemblance

"Looks like the Apple app" is a requirement, and it is human-verified: a ButtFold screenshot
next to a PhoneFold screenshot, judged by you. The agent never marks this met.

## Coming in Phase 2: the sound

Note-for-note parity with the Swift fixture is machine-checkable and will be checked. What
it *sounds* like is not. You listen to ubiquitin in two styles against the phone app.
