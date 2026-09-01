#!/usr/bin/env python3
"""P-SEA secondary structure from CA positions alone, and the fixtures `PSEA.js` is tested against.

Labesse, Colloc'h, Pothier & Mornon, CABIOS 1997, 13(3):291-295.

Ported from PhoneFold's `PhoneFoldKit/Sources/FoldGeometry/PSEA.swift`, commit
6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, behaviour for behaviour. This file has two jobs:

1. The baker calls it, so a baked gallery frame carries its secondary structure and the
   browser never assigns it for path A.
2. It generates `tests/fixtures/psea/*.json`, which the Node test runs `PSEA.js` against.
   The JS port is tested against *this*, not against itself. Two implementations agreeing
   with each other because one was written from the other is not evidence; agreeing on a
   reference output is.

P-SEA rather than DSSP because DSSP needs amide and carbonyl geometry to find hydrogen
bonds, and a Gō model has nothing but CA. It is not a compromise here, it is the only
option.

Two details in the Swift that are easy to get wrong and are preserved here deliberately:

- **`d2` plays no part in the helix test.** It is in the paper's table but not in the
  algorithm, and requiring it costs real helices.
- **The dihedral is negated**, which is the IUPAC sign convention under which a right-handed
  alpha helix reads near +50 degrees. Without the minus it reads -50, the helix criterion of
  50 +/- 20 never fires, and helix detection silently falls back to distances alone. On
  myoglobin that was 2 residues out of 153 passing the angle test, in a protein that is 118
  residues of helix.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent

HELIX, SHEET, COIL = "H", "E", "C"


@dataclass(frozen=True)
class Window:
    """A distance or angle criterion: a target with a tolerance either side."""

    centre: float
    tolerance: float

    def contains(self, value: float) -> bool:
        return self.centre - self.tolerance <= value <= self.centre + self.tolerance

    def score(self, value: float) -> float:
        """1 at the centre, falling to 0 at the edges. Drives the renderer's morph."""
        if self.tolerance <= 0:
            return 1.0 if self.contains(value) else 0.0
        return max(0.0, 1.0 - abs(value - self.centre) / self.tolerance)


# Published P-SEA parameters. Distances in angstroms, angles in degrees.
HELIX_D2 = Window(5.5, 0.5)
HELIX_D3 = Window(5.3, 0.5)
HELIX_D4 = Window(6.4, 0.6)
HELIX_THETA = Window(89, 12)
HELIX_ALPHA = Window(50, 20)

SHEET_D2 = Window(6.7, 0.6)
SHEET_D3 = Window(9.9, 0.9)
SHEET_D4 = Window(12.4, 1.1)
SHEET_THETA = Window(124, 14)
SHEET_ALPHA = Window(180, 45)  # tested as two intervals; see below


def angle(a, b, c) -> float:
    """Angle at `b`, in degrees."""
    u, v = a - b, c - b
    lengths = float(np.linalg.norm(u) * np.linalg.norm(v))
    if lengths <= 1e-6:
        return 0.0
    return math.degrees(math.acos(min(max(float(np.dot(u, v)) / lengths, -1.0), 1.0)))


def dihedral(a, b, c, d) -> float:
    """Dihedral about the b-c bond, in degrees, in -180...180, IUPAC sign."""
    b1, b2, b3 = b - a, c - b, d - c
    n1, n2 = np.cross(b1, b2), np.cross(b2, b3)
    lb2 = float(np.linalg.norm(b2))
    if lb2 <= 1e-9:
        return 0.0
    m = np.cross(n1, b2 / lb2)
    x, y = float(np.dot(n1, n2)), float(np.dot(m, n2))
    if not (math.isfinite(x) and math.isfinite(y)):
        return 0.0
    return -math.degrees(math.atan2(y, x))


def _mask_consecutive(mask: list[bool], count: int) -> list[bool]:
    """True for every element of any run of at least `count` consecutive true values."""
    out = [False] * len(mask)
    if count <= 0 or len(mask) < count:
        return out
    run = 0
    for i, value in enumerate(mask):
        run = run + 1 if value else 0
        if run >= count:
            for k in range(i - run + 1, i + 1):
                out[k] = True
    return out


def _extend_regions(base: list[bool], permitted: list[bool]) -> list[bool]:
    """Grow each true region by at most one element on each side, where `permitted` allows."""
    out = list(base)
    for i, value in enumerate(base):
        if not value:
            continue
        if i > 0 and not base[i - 1] and permitted[i - 1]:
            out[i - 1] = True
        if i < len(base) - 1 and not base[i + 1] and permitted[i + 1]:
            out[i + 1] = True
    return out


def _regions_with_contacts(candidates: list[bool], ca: np.ndarray, minimum_contacts: int,
                           minimum_distance: float, maximum_distance: float) -> list[bool]:
    """Keep only candidate runs that make enough CA contacts in a distance shell.

    A beta strand pairs with another strand. The 4.2 to 5.2 A shell deliberately excludes
    the 3.8 A bond to a neighbour and the ~6.7 A span to i+2, so what it counts is contact
    *between* strands rather than along one.
    """
    out = [False] * len(candidates)
    distance = np.linalg.norm(ca[:, None, :] - ca[None, :, :], axis=-1)
    separation = np.abs(np.arange(len(ca))[:, None] - np.arange(len(ca))[None, :])
    shell = (distance >= minimum_distance) & (distance <= maximum_distance) & (separation > 2)
    i = 0
    while i < len(candidates):
        if not candidates[i]:
            i += 1
            continue
        end = i
        while end + 1 < len(candidates) and candidates[end + 1]:
            end += 1
        if int(shell[i:end + 1].sum()) >= minimum_contacts:
            for k in range(i, end + 1):
                out[k] = True
        i = end + 1
    return out


def _confidence(i: int, strict: list[bool], values: list[float],
                windows: list[Window]) -> float:
    if not strict[i]:
        return 0.35
    lowest = 1.0
    for value, window in zip(values, windows):
        if math.isfinite(value):
            lowest = min(lowest, window.score(value))
    return max(0.4, min(1.0, 0.4 + 0.6 * lowest))


def assign(ca: np.ndarray) -> tuple[str, list[float]]:
    """Three-state secondary structure and per-residue confidence for one CA trace.

    Returns (string of H/E/C, confidences). Residues too close to a terminus for the
    window are coil with zero confidence, which is honest: there is no evidence either way.
    """
    ca = np.asarray(ca, dtype=np.float64)
    n = len(ca)
    if n <= 5:
        return COIL * n, [0.0] * n

    nan = float("nan")
    d2 = [nan] * n
    d3 = [nan] * n
    d4 = [nan] * n
    theta = [nan] * n
    alpha = [nan] * n

    for i in range(1, n - 1):
        d2[i] = float(np.linalg.norm(ca[i - 1] - ca[i + 1]))
        theta[i] = angle(ca[i - 1], ca[i], ca[i + 1])
    for i in range(1, n - 2):
        d3[i] = float(np.linalg.norm(ca[i - 1] - ca[i + 2]))
        alpha[i] = dihedral(ca[i - 1], ca[i], ca[i + 1], ca[i + 2])
    for i in range(1, n - 3):
        d4[i] = float(np.linalg.norm(ca[i - 1] - ca[i + 3]))

    def in_range(v: float, w: Window) -> bool:
        return math.isfinite(v) and w.contains(v)

    strict_helix, relaxed_helix = [False] * n, [False] * n
    strict_sheet, relaxed_sheet = [False] * n, [False] * n
    for i in range(n):
        relaxed_helix[i] = in_range(d3[i], HELIX_D3) or in_range(theta[i], HELIX_THETA)
        strict_helix[i] = ((in_range(d3[i], HELIX_D3) and in_range(d4[i], HELIX_D4))
                           or (in_range(theta[i], HELIX_THETA)
                               and in_range(alpha[i], HELIX_ALPHA)))

        relaxed_sheet[i] = in_range(d3[i], SHEET_D3)
        by_distance = (in_range(d2[i], SHEET_D2) and in_range(d3[i], SHEET_D3)
                       and in_range(d4[i], SHEET_D4))
        # The strand dihedral straddles +/-180 degrees, so it is two intervals.
        dihedral_ok = math.isfinite(alpha[i]) and (
            (-180 <= alpha[i] <= -125) or (145 <= alpha[i] <= 180))
        by_angle = in_range(theta[i], SHEET_THETA) and dihedral_ok
        strict_sheet[i] = by_distance or by_angle

    helix_mask = _extend_regions(_mask_consecutive(strict_helix, 5), relaxed_helix)

    long_strands = _mask_consecutive(strict_sheet, 4)
    short_strands = _regions_with_contacts(_mask_consecutive(strict_sheet, 3), ca,
                                           minimum_contacts=5, minimum_distance=4.2,
                                           maximum_distance=5.2)
    sheet_mask = _extend_regions([a or b for a, b in zip(long_strands, short_strands)],
                                 relaxed_sheet)

    labels: list[str] = []
    confidences: list[float] = []
    for i in range(n):
        if helix_mask[i]:
            labels.append(HELIX)
            confidences.append(_confidence(i, strict_helix, [d3[i], d4[i]],
                                           [HELIX_D3, HELIX_D4]))
        elif sheet_mask[i]:
            labels.append(SHEET)
            confidences.append(_confidence(i, strict_sheet, [d2[i], d3[i], d4[i]],
                                           [SHEET_D2, SHEET_D3, SHEET_D4]))
        else:
            labels.append(COIL)
            confidences.append(0.0)
    return "".join(labels), confidences


def run_length_encode(labels: str) -> str:
    """`HHHHCCCEE` -> `4H3C2E`. What a baked frame stores; PLAN section 5.3."""
    if not labels:
        return ""
    out: list[str] = []
    current, count = labels[0], 1
    for ch in labels[1:]:
        if ch == current:
            count += 1
        else:
            out.append(f"{count}{current}")
            current, count = ch, 1
    out.append(f"{count}{current}")
    return "".join(out)


def run_length_decode(encoded: str) -> str:
    out: list[str] = []
    digits = ""
    for ch in encoded:
        if ch.isdigit():
            digits += ch
        else:
            out.append(ch * int(digits or "1"))
            digits = ""
    return "".join(out)


class Hysteresis:
    """Temporal smoothing across a trajectory: a residue must hold a new state for
    `window` consecutive frames before it changes. Without it the ribbon strobes."""

    def __init__(self, residue_count: int, window: int = 3):
        self.window = max(1, window)
        self.current = [COIL] * residue_count
        self.candidate = [COIL] * residue_count
        self.streak = [0] * residue_count

    def smooth(self, raw: str) -> str:
        if len(raw) != len(self.current):
            self.current = list(raw)
            self.candidate = list(raw)
            self.streak = [self.window] * len(raw)
            return raw
        for i, incoming in enumerate(raw):
            if incoming == self.current[i]:
                self.streak[i] = 0
                continue
            if incoming == self.candidate[i]:
                self.streak[i] += 1
            else:
                self.candidate[i] = incoming
                self.streak[i] = 1
            if self.streak[i] >= self.window:
                self.current[i] = incoming
                self.streak[i] = 0
        return "".join(self.current)


def _write_fixtures() -> int:
    """Reference outputs for the Node test of PSEA.js.

    Cases are chosen to exercise every branch: a helix-only protein, a mixed alpha/beta
    protein, a short chain below the n > 5 guard, and an unfolded coil where nothing should
    be assigned. If PSEA.js only ever saw folded structures it could return "all helix"
    and pass.
    """
    from coil import native_ca, random_coil  # local import: only the fixture path needs it

    out = REPO / "tests" / "fixtures" / "psea"
    out.mkdir(parents=True, exist_ok=True)
    cases: list[tuple[str, np.ndarray]] = []
    for protein_id in ["trp_cage", "villin_hp36", "protein_g_b1", "ubiquitin", "alpha3d"]:
        cases.append((f"native-{protein_id}", native_ca(protein_id)))
    cases.append(("coil-ubiquitin-seed1", random_coil(76, np.random.default_rng(1))))
    cases.append(("short-4", native_ca("trp_cage")[:4]))

    index = []
    for name, ca in cases:
        labels, confidences = assign(ca)
        record = {
            "name": name,
            "residueCount": int(len(ca)),
            "ca": [[round(float(v), 6) for v in row] for row in np.asarray(ca)],
            "ss": labels,
            "ssRunLength": run_length_encode(labels),
            "confidence": [round(float(c), 6) for c in confidences],
        }
        (out / f"{name}.json").write_text(json.dumps(record, separators=(",", ":")))
        counts = {k: labels.count(k) for k in "HEC"}
        index.append({"name": name, "file": f"{name}.json", "counts": counts})
        print(f"{name:26s} n={len(ca):3d}  H {counts['H']:3d}  E {counts['E']:3d}  "
              f"C {counts['C']:3d}")
    (out / "index.json").write_text(json.dumps({"cases": index}, indent=1))
    print(f"\nwrote {len(cases)} fixtures to {out.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    import argparse
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    ap = argparse.ArgumentParser(description="P-SEA assignment and PSEA.js fixtures.")
    ap.add_argument("--fixtures", action="store_true", help="write tests/fixtures/psea/")
    args = ap.parse_args()
    if args.fixtures:
        raise SystemExit(_write_fixtures())
    ap.error("nothing to do: pass --fixtures")
