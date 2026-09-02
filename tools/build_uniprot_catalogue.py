#!/usr/bin/env python3
"""Build the catalogue the ESMFold engine offers, by predicting every candidate.

    python3 tools/build_uniprot_catalogue.py [--limit N] [--keep N]

**The filter is a measurement, not a name.** The obvious way to pick small proteins from
UniProt is to take reviewed entries of 40 to 80 residues that have a PDB structure and rank
them by how well studied they are. Doing exactly that returned twenty-five ribosomal proteins
in the top twenty-five, and a ribosomal protein is only folded INSIDE the ribosome: ESMFold
predicts them as extended spaghetti, and the Go model would then animate a chain collapsing
toward a shape that is not a domain. Cytochrome oxidase subunits, hirudin and the PKA
inhibitor peptide came next, and all fail for the same reason in different ways - they are
folded against a partner, or not folded at all.

So every candidate is actually predicted, and kept only if it comes back looking like an
autonomous domain:

  * mean pLDDT >= 0.70. ESMFold's own confidence, and it is honest about disorder: hirudin
    came back at 0.45 and the PKA inhibitor at 0.47.
  * radius of gyration within 1.20x of 2.2 N^0.38, the Dima and Thirumalai scaling for a
    folded globule that the sonifier already uses. Cytochrome c oxidase subunit 6C predicts
    at 2.68x - an 80 residue rod, not a ball.

Both bars were set from the measured distribution rather than chosen, and the second one was
moved once, by a fold that failed: see MAX_RG_RATIO below for how the number found three
oligomers the name filter could not. The file prints every candidate with both numbers so
the next person can see where the line falls.

The catalogue is written to `data/uniprot_catalogue.json` and committed, because a pulldown
backed by a live query is a pulldown that is sometimes empty, and because the web process
enforces the residue cap and must not make a network call to decide whether to accept a job.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from buttfold import uniprot                                          # noqa: E402
from buttfold.paths import PREDICTION_CACHE                            # noqa: E402
from buttfold.queue import RESIDUE_CAP                                # noqa: E402

# 40 at the bottom: below that ESMFold has very little to work with and the Go model has
# almost no contacts to form, so the animation is a wiggle rather than a fold.
MIN_RESIDUES = 40

# Families that are only folded in a complex, or not folded at all. This is a cheap first
# pass to save requests, NOT the filter: the measurement below is the filter, and it rejects
# plenty that this misses.
COMPLEX_ONLY = re.compile(
    r"ribosomal|RNA polymerase|Guanine nucleotide-binding|photosystem|ATP synthase|"
    r"cytochrome b|cytochrome c oxidase|NADH|ubiquinone|translocase|transcription|"
    r"elongation factor|histone|thylakoid|proteasome|spliceosom",
    re.I)

MIN_MEAN_PLDDT = 0.70
# 1.20, tightened from 1.35 after a fold failed the bake gate. Cro repressor predicted at
# 1.29x and its trajectory went Rg 16.5 -> 13.7, a collapse ratio of 0.83 against the 0.80
# bar: the Go model reached its target perfectly well, but the target was not compact, so
# there was no collapse to watch. Ranking the catalogue by this number put three entries
# above 1.20 and they are Cro (a dimer), TRAP (an 11-mer ring) and dodecin (a dodecamer, as
# the name says). Everything at 1.15 and below is a monomer.
#
# So this is the ribosomal-protein error one step subtler. Those proteins are not folded at
# all outside their complex; these ARE folded alone but are only COMPACT as an assembly, and
# a monomer prediction of one comes back loose. Same fix: measure, and let the number find
# the family rather than the other way round.
MAX_RG_RATIO = 1.20

QUERY = (f"(reviewed:true) AND (length:[{MIN_RESIDUES} TO {RESIDUE_CAP}]) "
         "AND (database:pdb)")
FIELDS = "accession,id,protein_name,length,organism_name,xref_pdb,sequence"


def fetch_candidates(limit: int) -> list[dict]:
    url = ("https://rest.uniprot.org/uniprotkb/search?"
           + urllib.parse.urlencode({"query": QUERY, "fields": FIELDS,
                                     "format": "tsv", "size": min(limit, 500)}))
    with urllib.request.urlopen(url, timeout=120) as response:
        text = response.read().decode()
    return list(csv.DictReader(io.StringIO(text), delimiter="\t"))


def radius_of_gyration(ca: list[list[float]]) -> float:
    n = len(ca)
    cx = sum(p[0] for p in ca) / n
    cy = sum(p[1] for p in ca) / n
    cz = sum(p[2] for p in ca) / n
    return (sum((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2
                for p in ca) / n) ** 0.5


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=500,
                        help="candidates to pull from UniProt")
    parser.add_argument("--keep", type=int, default=24,
                        help="how many survivors to write out")
    parser.add_argument("--pause", type=float, default=1.5,
                        help="seconds between predictions; the endpoint is free and starts "
                             "returning 504 when pushed")
    args = parser.parse_args()

    rows = fetch_candidates(args.limit)
    candidates = []
    for row in rows:
        if COMPLEX_ONLY.search(row["Protein names"]):
            continue
        pdbs = [p for p in (row.get("PDB") or "").split(";") if p]
        candidates.append((len(pdbs), row, pdbs))
    # Most studied first, so that when two proteins are equally good domains the one people
    # have actually solved wins. It is a tie break, never the filter - ranking on it was
    # what produced a top twenty-five of ribosomal proteins.
    candidates.sort(key=lambda t: -t[0])
    print(f"{len(rows)} candidates, {len(candidates)} after the family filter", file=sys.stderr)

    kept: list[dict] = []
    for pdb_count, row, pdbs in candidates:
        if len(kept) >= args.keep:
            break
        sequence = row["Sequence"]
        name = row["Protein names"].split("(")[0].strip()
        try:
            # Through the cache the worker uses. ESMFold is deterministic for a sequence, so
            # re-running this screen after a bar moves costs Meta's free endpoint nothing.
            prediction = uniprot.cached_prediction(
                row["Entry"], sequence, PREDICTION_CACHE)
        except uniprot.PredictionFailed as err:
            print(f"       {row['Entry']:<8} {str(err)[:60]}", file=sys.stderr)
            continue
        ca, plddt = prediction["ca"], prediction["plddt"]
        n = len(ca)
        mean_plddt = sum(plddt) / n
        observed = radius_of_gyration(ca)
        expected = 2.2 * n ** 0.38
        ratio = observed / expected
        ok = mean_plddt >= MIN_MEAN_PLDDT and ratio <= MAX_RG_RATIO
        print(f"  {'KEEP' if ok else '    '} {row['Entry']:<8} {n:>3}aa  "
              f"pLDDT {mean_plddt:.2f}  Rg {observed:5.1f} vs {expected:4.1f} (x{ratio:.2f})  "
              f"{pdb_count:>4} PDBs  {name[:44]}", file=sys.stderr)
        if ok:
            kept.append({
                "accession": row["Entry"],
                "entryName": row["Entry Name"],
                "name": name,
                "organism": row["Organism"].split("(")[0].strip(),
                "residueCount": n,
                "sequence": sequence,
                "pdbs": pdbs[:4],
                "pdbCount": pdb_count,
                "meanPlddt": round(mean_plddt, 3),
                "predictedRg": round(observed, 2),
                "expectedRg": round(expected, 2),
            })
        if not (PREDICTION_CACHE / f"{row['Entry']}.json").exists():
            time.sleep(args.pause)          # only when something was actually asked for

    kept.sort(key=lambda e: (e["residueCount"], e["accession"]))
    uniprot.CATALOGUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    uniprot.CATALOGUE_PATH.write_text(json.dumps({
        "generated": time.strftime("%Y-%m-%d"),
        "source": "UniProtKB reviewed, with an experimental structure in the PDB",
        "screen": {
            "query": QUERY,
            "minMeanPlddt": MIN_MEAN_PLDDT,
            "maxRgRatio": MAX_RG_RATIO,
            "note": "Every entry was predicted and measured; see "
                    "tools/build_uniprot_catalogue.py for why a name filter was not enough.",
        },
        "entries": kept,
    }, indent=1) + "\n")
    print(f"\nwrote {len(kept)} entries to {uniprot.CATALOGUE_PATH}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
