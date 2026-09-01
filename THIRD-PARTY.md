# Third-party software and data

ButtFold's own code is MIT (see `LICENSE`). This file lists what it leans on, with the
licence, what ButtFold uses it for, and what ButtFold changed. `LICENSE` is kept as the bare
MIT text with nothing appended, because GitHub's licence classifier matches the body and
trailing prose makes the repository show no licence at all.

Licences were read from each project's own repository on 2026-09-01 rather than recalled.

## Vendored from PhoneFold

Everything below was copied out of [PhoneFold](https://github.com/bellcheddar/PhoneFold)
(MIT, Marc C. Deller) at commit `6f44c8a1ac7684da93668a580b29cbe9a67cfc5e`. ButtFold does
not reference that repository at runtime or by path; the files are here, with provenance
headers, and are re-vendored rather than patched when the source changes.

| Here | From | What ButtFold does with it |
|---|---|---|
| `native/go_model_fold.c` | `Tools/go_model_fold.c` | The Gō model. **Unedited** below its provenance header. Compiled three ways: natively on the Mac for the baker, to WASM for the browser, and natively on the droplet for the queue. `native/wasm_api.c` is ButtFold's own and is additive: it `#include`s this file rather than editing it. |
| `static/styles/*.json` | `Apps/Shared/Resources/Styles/` | The five style profiles, byte-identical. Loaded unchanged by the Web Audio engine. |
| `data/natives/*.json` | `Apps/Shared/Resources/Trajectories/*.pftraj` | The **final readout only** of each ESMFold trajectory, used as the Gō potential's native state, plus a sequence and a committed starting coil. The trajectories themselves are deliberately not used; see `PLAN.md` section 5.3. |
| `tools/psea.py`, `tools/contacts.py`, `tools/coil.py` | `PhoneFoldKit/Sources/FoldGeometry/`, `Tools/go_model_fold.py` | Ported to Python, behaviour for behaviour. Tested against the Swift's own outputs. |
| `static/js/PSEA.js`, `ContactTracker.js`, `MusicalScale.js`, `Sonifier.js` | `PhoneFoldKit/Sources/FoldGeometry/`, `FoldAudio/` | Ported to JavaScript. `Sonifier.js` is held to **note-for-note** agreement with the shipped Swift by `tests/sonifier_parity.test.mjs`. |

`static/js/audio.js` is a **reimplementation**, not a port: AVAudioEngine and Web Audio are
different graphs. The parity test pins the notes; the timbre is as close as two synthesis
stacks get.

## Upstream of that

| Project | Licence | What it contributes |
|---|---|---|
| [ESMFold](https://huggingface.co/facebook/esmfold_v1) — Meta AI | MIT | The folded structures whose final readouts become the Gō model's native states. Not run by ButtFold; its outputs arrive vendored via PhoneFold. |
| [three.js](https://github.com/mrdoob/three.js) | MIT | The 3D stage. Loaded from cdnjs at a pinned version; not vendored. |
| [Emscripten](https://github.com/emscripten-core/emsdk) | MIT / University of Illinois NCSA | Compiles the Gō model to WebAssembly. Version 4.0.7, pinned in `tools/build_wasm.sh`. |
| [Inter](https://github.com/rsms/inter), [Roboto Mono](https://fonts.google.com/specimen/Roboto+Mono) | SIL Open Font License 1.1 | Typography, from Google Fonts. |

## Science

The model and the scales it is normalised against are published work, cited where they are
used rather than only here:

| | |
|---|---|
| Structure-based (Gō) model | Clementi, Nymeyer & Onuchic, *J. Mol. Biol.* **298**:937 (2000) |
| P-SEA secondary structure from CA alone | Labesse, Colloc'h, Pothier & Mornon, *CABIOS* **13**(3):291 (1997) |
| Kyte-Doolittle hydropathy | Kyte & Doolittle, *J. Mol. Biol.* **157**(1):105 (1982) |
| Denatured radius of gyration scaling | Kohn et al., *PNAS* **101**(34):12491 (2004) |
| Native globular Rg scaling | Dima & Thirumalai, *J. Phys. Chem. B* **108**(21):6564 (2004) |
| The pitch layer's approach | Tay et al., *Heliyon* **7**(9):e07933 (2021) |

## Trademarks

App Store and the Apple wordmarks are trademarks of Apple Inc. ButtFold does **not** use
Apple's "Download on the App Store" badge artwork, and its shop window shows a store link
only when `static/links.json` carries a real `apps.apple.com` URL for that app. Until then
it says the app is in review, which is true.
