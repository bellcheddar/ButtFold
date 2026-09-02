"""The ESMFold engine: a UniProt entry in, a predicted native state out.

PLAN section 5.2 gave the queue one job, folding a committed protein toward its crystal
structure. This adds the other half: pick a real protein from UniProt, have ESMFold predict
where it ends up, and let the Go model fold a chain toward THAT. Everything downstream is
unchanged - the same C binary, the same frame builder, the same sonifier - because the only
thing that differs is where the native state came from.

**The prediction does not happen here and the page says so.** `facebook/esmfold_v1` is an
8.44 GB checkpoint; this droplet has 3.9 GB of RAM, no swap, and nine other apps on it, so
running it locally is not slow but impossible. Meta's ESM Atlas endpoint returns a 76 residue
prediction in about a second, measured, so that is what is used - which makes the honest
badge "predicted by ESMFold at Meta, folded here" rather than anything that implies this
server did the prediction.

**Two claims are separated on purpose.** ESMFold predicts a structure, and the Go model
animates a chain collapsing toward it. The second is not a physical folding pathway and never
was; the first is a prediction that can be wrong. The catalogue only offers proteins with an
experimental structure in the PDB, so the prediction is at least checkable rather than taken
on faith.

The catalogue itself is committed rather than queried live: a pulldown backed by a network
call is a pulldown that is sometimes empty, and the residue cap has to be enforced in the web
process, which must not make network calls to decide whether to accept a job.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CATALOGUE_PATH = REPO / "data" / "uniprot_catalogue.json"

# Meta's ESM Metagenomic Atlas. No key, no account, and measured at 0.5 to 1.2 s for 76
# residues. It is a third party with no promise to us, so every failure here is reported as
# what it is rather than dressed up as a fold that went wrong.
ESM_ATLAS_URL = "https://api.esmatlas.com/foldSequence/v1/pdb/"
ESM_TIMEOUT_SECONDS = 90

# The prefix that marks a queue job as a prediction rather than a committed native. It is
# part of the cache key, so a UniProt fold and a gallery fold can never collide.
PREFIX = "uniprot:"


class PredictionFailed(RuntimeError):
    """ESM Atlas did not return a structure. Distinct from a fold that failed."""


def is_uniprot(protein_id: str) -> bool:
    return protein_id.startswith(PREFIX)


def accession_of(protein_id: str) -> str:
    return protein_id[len(PREFIX):]


def catalogue() -> dict[str, dict]:
    """The proteins the ESMFold engine offers, keyed by queue id.

    Committed, screened, and deliberately small. `tools/build_uniprot_catalogue.py` builds
    it by predicting every candidate and keeping the ones that come back as confident,
    compact domains - see that file for why a name-based filter was not enough.
    """
    if not CATALOGUE_PATH.exists():
        return {}
    entries = json.loads(CATALOGUE_PATH.read_text())["entries"]
    return {f"{PREFIX}{e['accession']}": e for e in entries}


def parse_prediction(pdb_text: str) -> tuple[list[list[float]], list[float]]:
    """Alpha carbons and their pLDDT out of an ESMFold PDB.

    Split on whitespace rather than by column for the record type: `line[:6]` drops every
    ATOM whose serial number has run into the field, which is the mmCIF trap in a different
    costume. The coordinates themselves ARE column-defined by the PDB format, so those are
    sliced.
    """
    ca: list[list[float]] = []
    plddt: list[float] = []
    for line in pdb_text.splitlines():
        if not line.startswith(("ATOM", "HETATM")):
            continue
        if line[12:16].strip() != "CA":
            continue
        ca.append([float(line[30:38]), float(line[38:46]), float(line[46:54])])
        # ESMFold writes pLDDT into the B factor. The Atlas returns it on a 0 to 1 scale,
        # not the 0 to 100 the AlphaFold files use, so it is normalised here and asserted
        # rather than assumed: a silent factor of 100 would paint every residue as certain.
        plddt.append(float(line[60:66]))
    if plddt and max(plddt) > 1.5:
        plddt = [v / 100.0 for v in plddt]
    return ca, plddt


# Measured while screening the catalogue: a run of back-to-back requests starts returning
# 504 Gateway Timeout after a couple of dozen. It is a free endpoint with no published rate
# limit, so the only responsible read of a 504 is "you are asking too fast" - hence a retry
# with a widening gap rather than a failed fold. Three tries covers every transient seen.
RETRIES = 3
RETRY_BACKOFF_SECONDS = 4.0


def predict(sequence: str) -> dict:
    """Fold one sequence at ESM Atlas. Raises `PredictionFailed`, never returns nonsense."""
    request = urllib.request.Request(
        ESM_ATLAS_URL, data=sequence.encode("ascii"), method="POST",
        headers={"Content-Type": "text/plain"})
    last: Exception | None = None
    for attempt in range(RETRIES):
        if attempt:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
        try:
            with urllib.request.urlopen(request, timeout=ESM_TIMEOUT_SECONDS) as response:
                pdb_text = response.read().decode("utf-8", "replace")
            break
        except (urllib.error.URLError, OSError, TimeoutError) as err:
            last = err
    else:
        raise PredictionFailed(f"ESM Atlas did not answer after {RETRIES} tries: {last}")

    ca, plddt = parse_prediction(pdb_text)
    if len(ca) != len(sequence):
        raise PredictionFailed(
            f"ESM Atlas returned {len(ca)} alpha carbons for a {len(sequence)} residue "
            "sequence")
    return {"ca": ca, "plddt": plddt, "pdb": pdb_text}


def cached_prediction(accession: str, sequence: str, cache_dir: Path) -> dict:
    """A prediction, from disk if it is there.

    ESMFold is deterministic for a given sequence, so this is a pure cache rather than a
    reuse of something that might have changed. It also means a protein folded twice costs
    Meta one request, which is the least this can do given the endpoint is free.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"{accession}.json"
    if path.exists():
        try:
            record = json.loads(path.read_text())
            if len(record.get("ca", [])) == len(sequence):
                return record
        except (json.JSONDecodeError, OSError):
            pass          # a truncated cache file is not a reason to fail the fold
    record = predict(sequence)
    path.write_text(json.dumps(record, separators=(",", ":")))
    return record
