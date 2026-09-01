/* P-SEA secondary structure from CA positions alone.
 *
 * Labesse, Colloc'h, Pothier & Mornan, CABIOS 1997, 13(3):291-295.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldGeometry/PSEA.swift`, commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, and tested against `tools/psea.py`'s reference
 * fixtures rather than against itself. Two implementations agreeing because one was written
 * from the other is not evidence; agreeing on a reference output is.
 *
 * P-SEA rather than DSSP because DSSP needs amide and carbonyl geometry to find hydrogen
 * bonds, and a Go model has nothing but CA. Not a compromise, the only option.
 *
 * Two details that are easy to get wrong and are preserved deliberately:
 *
 *  - **d2 plays no part in the helix test.** It is in the paper's table but not in the
 *    algorithm, and requiring it costs real helices.
 *  - **The dihedral is negated**, which is the IUPAC sign convention under which a
 *    right-handed alpha helix reads near +50 degrees. Without the minus it reads -50, the
 *    helix criterion of 50 +/- 20 never fires, and helix detection silently falls back to
 *    distances alone. On myoglobin that was 2 residues out of 153 passing the angle test,
 *    in a protein that is 118 residues of helix.
 *
 * The baked path never calls this: gallery frames arrive with their secondary structure
 * already assigned. It runs in the worker on the live and queued paths.
 */

export const HELIX = 'H', SHEET = 'E', COIL = 'C';

const window_ = (centre, tolerance) => ({ centre, tolerance });
const contains = (w, v) => v >= w.centre - w.tolerance && v <= w.centre + w.tolerance;
const score = (w, v) => (w.tolerance > 0
  ? Math.max(0, 1 - Math.abs(v - w.centre) / w.tolerance)
  : (contains(w, v) ? 1 : 0));

// Published P-SEA parameters. Distances in angstroms, angles in degrees.
export const HELIX_D3 = window_(5.3, 0.5);
export const HELIX_D4 = window_(6.4, 0.6);
export const HELIX_THETA = window_(89, 12);
export const HELIX_ALPHA = window_(50, 20);

export const SHEET_D2 = window_(6.7, 0.6);
export const SHEET_D3 = window_(9.9, 0.9);
export const SHEET_D4 = window_(12.4, 1.1);
export const SHEET_THETA = window_(124, 14);

const at = (p, i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                         a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.sqrt(dot(a, a));
const distance = (p, i, j) => norm(sub(at(p, i), at(p, j)));

/** Angle at `b`, in degrees. */
export function angle(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const lengths = norm(u) * norm(v);
  if (lengths <= 1e-6) return 0;
  return Math.acos(Math.min(Math.max(dot(u, v) / lengths, -1), 1)) * 180 / Math.PI;
}

/** Dihedral about the b-c bond, in degrees, in -180...180, IUPAC sign. */
export function dihedral(a, b, c, d) {
  const b1 = sub(b, a), b2 = sub(c, b), b3 = sub(d, c);
  const n1 = cross(b1, b2), n2 = cross(b2, b3);
  const lb2 = norm(b2);
  if (lb2 <= 1e-9) return 0;
  const m = cross(n1, [b2[0] / lb2, b2[1] / lb2, b2[2] / lb2]);
  const x = dot(n1, n2), y = dot(m, n2);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return -Math.atan2(y, x) * 180 / Math.PI;
}

/** True for every element of any run of at least `count` consecutive true values. */
function maskConsecutive(mask, count) {
  const out = new Array(mask.length).fill(false);
  if (count <= 0 || mask.length < count) return out;
  let run = 0;
  for (let i = 0; i < mask.length; i++) {
    run = mask[i] ? run + 1 : 0;
    if (run >= count) for (let k = i - run + 1; k <= i; k++) out[k] = true;
  }
  return out;
}

/** Grow each true region by at most one element on each side, where `permitted` allows. */
function extendRegions(base, permitted) {
  const out = base.slice();
  for (let i = 0; i < base.length; i++) {
    if (!base[i]) continue;
    if (i > 0 && !base[i - 1] && permitted[i - 1]) out[i - 1] = true;
    if (i < base.length - 1 && !base[i + 1] && permitted[i + 1]) out[i + 1] = true;
  }
  return out;
}

/* Keep only candidate runs that make enough CA contacts in a distance shell.
 *
 * A beta strand pairs with another strand. The 4.2 to 5.2 A shell deliberately excludes the
 * 3.8 A bond to a neighbour and the ~6.7 A span to i+2, so what it counts is contact
 * *between* strands rather than along one. */
function regionsWithContacts(candidates, positions, n, minimumContacts,
                             minimumDistance, maximumDistance) {
  const out = new Array(candidates.length).fill(false);
  let i = 0;
  while (i < candidates.length) {
    if (!candidates[i]) { i++; continue; }
    let end = i;
    while (end + 1 < candidates.length && candidates[end + 1]) end++;
    let contacts = 0;
    for (let a = i; a <= end; a++) {
      for (let b = 0; b < n; b++) {
        if (Math.abs(b - a) <= 2) continue;
        const d = distance(positions, a, b);
        if (d >= minimumDistance && d <= maximumDistance) contacts++;
      }
    }
    if (contacts >= minimumContacts) for (let k = i; k <= end; k++) out[k] = true;
    i = end + 1;
  }
  return out;
}

function confidence(i, strict, values, windows) {
  if (!strict[i]) return 0.35;
  let lowest = 1;
  for (let k = 0; k < values.length; k++) {
    if (Number.isFinite(values[k])) lowest = Math.min(lowest, score(windows[k], values[k]));
  }
  return Math.max(0.4, Math.min(1, 0.4 + 0.6 * lowest));
}

/**
 * Assign three-state secondary structure to a flat xyz CA trace.
 * @returns {{ss: string, confidence: number[]}}
 *
 * Residues too close to a terminus for the window are coil with zero confidence, which is
 * honest: there is no evidence either way.
 */
export function assign(positions) {
  const n = positions.length / 3;
  if (n <= 5) return { ss: COIL.repeat(n), confidence: new Array(n).fill(0) };

  const NaN_ = Number.NaN;
  const d2 = new Array(n).fill(NaN_), d3 = new Array(n).fill(NaN_);
  const d4 = new Array(n).fill(NaN_), theta = new Array(n).fill(NaN_);
  const alpha = new Array(n).fill(NaN_);

  for (let i = 1; i < n - 1; i++) {
    d2[i] = distance(positions, i - 1, i + 1);
    theta[i] = angle(at(positions, i - 1), at(positions, i), at(positions, i + 1));
  }
  for (let i = 1; i < n - 2; i++) {
    d3[i] = distance(positions, i - 1, i + 2);
    alpha[i] = dihedral(at(positions, i - 1), at(positions, i),
                        at(positions, i + 1), at(positions, i + 2));
  }
  for (let i = 1; i < n - 3; i++) d4[i] = distance(positions, i - 1, i + 3);

  const inRange = (v, w) => Number.isFinite(v) && contains(w, v);

  const strictHelix = new Array(n).fill(false), relaxedHelix = new Array(n).fill(false);
  const strictSheet = new Array(n).fill(false), relaxedSheet = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    relaxedHelix[i] = inRange(d3[i], HELIX_D3) || inRange(theta[i], HELIX_THETA);
    strictHelix[i] = (inRange(d3[i], HELIX_D3) && inRange(d4[i], HELIX_D4))
      || (inRange(theta[i], HELIX_THETA) && inRange(alpha[i], HELIX_ALPHA));

    relaxedSheet[i] = inRange(d3[i], SHEET_D3);
    const byDistance = inRange(d2[i], SHEET_D2) && inRange(d3[i], SHEET_D3)
      && inRange(d4[i], SHEET_D4);
    // The strand dihedral straddles +/-180 degrees, so it is two intervals.
    const dihedralOK = Number.isFinite(alpha[i])
      && ((alpha[i] >= -180 && alpha[i] <= -125) || (alpha[i] >= 145 && alpha[i] <= 180));
    const byAngle = inRange(theta[i], SHEET_THETA) && dihedralOK;
    strictSheet[i] = byDistance || byAngle;
  }

  const helixMask = extendRegions(maskConsecutive(strictHelix, 5), relaxedHelix);
  const longStrands = maskConsecutive(strictSheet, 4);
  const shortStrands = regionsWithContacts(maskConsecutive(strictSheet, 3), positions, n,
                                           5, 4.2, 5.2);
  const sheetMask = extendRegions(longStrands.map((v, i) => v || shortStrands[i]),
                                  relaxedSheet);

  let ss = '';
  const confidences = new Array(n);
  for (let i = 0; i < n; i++) {
    if (helixMask[i]) {
      ss += HELIX;
      confidences[i] = confidence(i, strictHelix, [d3[i], d4[i]], [HELIX_D3, HELIX_D4]);
    } else if (sheetMask[i]) {
      ss += SHEET;
      confidences[i] = confidence(i, strictSheet, [d2[i], d3[i], d4[i]],
                                  [SHEET_D2, SHEET_D3, SHEET_D4]);
    } else {
      ss += COIL;
      confidences[i] = 0;
    }
  }
  return { ss, confidence: confidences };
}

/** `HHHHCCCEE` -> `4H3C2E`. What a baked frame stores; PLAN section 5.3. */
export function runLengthEncode(labels) {
  if (!labels) return '';
  let out = '', current = labels[0], count = 1;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === current) { count++; continue; }
    out += `${count}${current}`;
    current = labels[i];
    count = 1;
  }
  return out + `${count}${current}`;
}

export function runLengthDecode(encoded) {
  let out = '', digits = '';
  for (const ch of encoded) {
    if (ch >= '0' && ch <= '9') { digits += ch; continue; }
    out += ch.repeat(parseInt(digits || '1', 10));
    digits = '';
  }
  return out;
}

/* Temporal smoothing across a trajectory: a residue must hold a new state for `window`
 * consecutive frames before it changes. Without it the ribbon strobes, one frame's helix
 * becoming the next frame's coil. PLAN asks for roughly three frames.
 *
 * **The certainty is held with the state, not taken from the incoming frame.** A held
 * residue keeps the certainty its own structure last had; taking the raw frame's number
 * instead reads a score computed for a DIFFERENT structure. Measured on ubiquitin's final
 * frame, its third beta strand (residues 64 to 69) was held as sheet while the raw
 * assignment had lost it, so all six residues carried the coil score of 0 and the cartoon
 * drew that strand as a bare cord. A state held without its certainty is not smoothed, it
 * is contradicted.
 */
export class Hysteresis {
  constructor(residueCount, window = 3) {
    this.window = Math.max(1, window);
    this.current = new Array(residueCount).fill(COIL);
    this.confidence = new Array(residueCount).fill(0);
    this.candidate = new Array(residueCount).fill(COIL);
    this.streak = new Array(residueCount).fill(0);
  }

  /** @returns {{ss: string, confidence: number[]}} */
  smooth(raw, confidence = null) {
    const conf = confidence ? Array.from(confidence) : new Array(raw.length).fill(0);
    if (raw.length !== this.current.length) {
      this.current = raw.split('');
      this.confidence = conf;
      this.candidate = raw.split('');
      this.streak = new Array(raw.length).fill(this.window);
      return { ss: raw, confidence: this.confidence.slice() };
    }
    for (let i = 0; i < raw.length; i++) {
      const incoming = raw[i];
      if (incoming === this.current[i]) {
        this.streak[i] = 0;
        this.confidence[i] = conf[i];
        continue;
      }
      if (incoming === this.candidate[i]) {
        this.streak[i]++;
      } else {
        this.candidate[i] = incoming;
        this.streak[i] = 1;
      }
      if (this.streak[i] >= this.window) {
        this.current[i] = incoming;
        this.confidence[i] = conf[i];
        this.streak[i] = 0;
      }
      // else: the state is held, and so is its certainty.
    }
    return { ss: this.current.join(''), confidence: this.confidence.slice() };
  }
}
