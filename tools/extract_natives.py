#!/usr/bin/env python3
"""Vendor the native structures ButtFold folds towards, once, into `data/natives/`.

ButtFold does not read PhoneFold's repo at runtime. It reads its own committed JSON.
This script is the vendoring step that produces that JSON, and it is run by hand on the
Mac when the set of proteins changes, never by the app and never by the droplet.

Each `.pftraj` in PhoneFold carries an ESMFold trajectory. Its **final** readout is the
folded structure, and that is the only thing taken: it becomes the Go model's native
state, the potential's global minimum. The ESMFold *trajectory* is deliberately not
taken, for the reason PLAN.md section 5.3 records at length: those frames are already
folded, and a bake made from them is an animation of a protein twitching.

Usage (needs PhoneFold's Tools venv for its `pftraj` reader and numpy):

    /Users/dellboy/Documents/Vibe_Coding/PhoneFold/Tools/.venv/bin/python \
        tools/extract_natives.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = REPO / "data" / "natives"

PHONEFOLD = Path("/Users/dellboy/Documents/Vibe_Coding/PhoneFold")
TRAJECTORIES = PHONEFOLD / "Apps/Shared/Resources/Trajectories"
PROTEINS = PHONEFOLD / "Tools/proteins.json"

# The launch gallery: the six short ones, and short is the criterion. A 314-residue
# receptor folded in a browser tab is a smudge and minutes of CPU; these are 20 to 76
# residues and every one of them has a measured fold time in PhoneFold's METRICS.md.
CHOSEN = ["trp_cage", "ww_domain", "villin_hp36", "protein_g_b1", "alpha3d", "ubiquitin"]


def main() -> int:
    if not TRAJECTORIES.exists():
        print(f"PhoneFold trajectories not found at {TRAJECTORIES}", file=sys.stderr)
        return 1
    sys.path.insert(0, str(PHONEFOLD / "Tools"))
    import pftraj  # noqa: E402  (needs the path above)

    catalogue = {p["id"]: p for p in json.loads(PROTEINS.read_text())["proteins"]}
    OUT.mkdir(parents=True, exist_ok=True)

    written = []
    for stem in CHOSEN:
        path = TRAJECTORIES / f"{stem}.pftraj"
        if not path.exists():
            print(f"missing: {path}", file=sys.stderr)
            return 1
        meta, readouts = pftraj.read(path)
        final = readouts[-1]
        # backbone is (residues, atoms, 3); CA is index 1 of N/CA/C/O, index 0 if CA-only.
        ca = final.backbone[:, 1 if final.backbone.shape[1] == 4 else 0, :]
        ca = np.asarray(ca, dtype=np.float64)

        entry = catalogue.get(stem, {})
        record = {
            "id": stem,
            "name": meta["name"],
            "sequence": meta["sequence"],
            "residueCount": int(len(ca)),
            "organism": entry.get("organism"),
            "referencePdb": entry.get("reference_pdb"),
            "listeningNote": entry.get("listening_note"),
            "provenance": {
                "sourceRepo": "https://github.com/bellcheddar/PhoneFold",
                "sourceFile": f"Apps/Shared/Resources/Trajectories/{stem}.pftraj",
                "commit": "6f44c8a1ac7684da93668a580b29cbe9a67cfc5e",
                "readout": "final",
                "model": "facebook/esmfold_v1",
                "note": "final ESMFold readout, used only as the Go model's native state",
            },
            # 3 decimals: a thousandth of an Angstrom, well inside the model's meaning.
            "ca": [[round(float(v), 3) for v in row] for row in ca],
        }
        if len(record["sequence"]) != record["residueCount"]:
            print(f"{stem}: sequence {len(record['sequence'])} != CA {record['residueCount']}",
                  file=sys.stderr)
            return 1

        dest = OUT / f"{stem}.json"
        dest.write_text(json.dumps(record, separators=(",", ":"), sort_keys=True))
        written.append((stem, record["residueCount"], dest.stat().st_size / 1024))
        print(f"{stem:16s} {record['residueCount']:3d} residues  "
              f"{dest.stat().st_size / 1024:5.1f} kB  {record['name']}")

    print(f"\nwrote {len(written)} natives to {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
