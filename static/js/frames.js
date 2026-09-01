/* Turning CA coordinates into the frame object the player consumes.
 *
 * There is exactly one of these, and that is the point. PLAN.md section 2: the baked
 * gallery, the live WASM fold and the droplet queue are three frame SOURCES and one player.
 * If each source built its own frames, the same trajectory would arrive in three subtly
 * different shapes and the Phase 3 gate - "the live path and the baked path produce
 * byte-identical frame objects for the same trajectory input" - would be untestable
 * because there would be nothing to compare.
 *
 * `tools/bake_gallery.py` is the Python half of this and the two are held together by
 * tests/live_parity.test.mjs, which runs this over the coordinates the baker used and
 * asserts the result is byte for byte what the baker committed.
 *
 * **The scale is the only thing the two paths cannot share directly.** The baker takes it
 * once from the widest frame of the whole trajectory, which it has; a live fold does not
 * know its widest frame until it is over. `LiveScale` below is the live answer, and it is
 * built to fail in the one direction that is not visible: it grows and never shrinks, so a
 * structure can briefly approach the edge of the box, and can never appear to jump smaller
 * halfway through a fold. Per-frame normalisation - the obvious alternative - draws a coil
 * and a folded core at the same size and deletes the only thing the animation is about.
 */

import { assign, runLengthEncode, Hysteresis } from './PSEA.js';
import { ContactTracker } from './ContactTracker.js';

export const QUANTISED_RANGE = 1000;

/**
 * Round half to even, which is what NumPy's `round` and Python's built-in `round` both do,
 * and what `Math.round` does not: Math.round breaks ties upward.
 *
 * It matters here and only here. Measured on trp-cage frame 8, one coordinate landed on
 * exactly 238.5: the baker committed 238 and `Math.round` produced 239. One unit is a
 * tenth of a per cent of the structure's width and nobody could see it, but the Phase 3
 * gate is byte identity between the baked and live paths, and a rule that disagrees on ties
 * disagrees on roughly one coordinate in a few thousand forever.
 *
 * Half-to-even is also the less biased rule and the IEEE-754 default, so matching the
 * Python was the right direction to resolve it.
 */
export function roundHalfToEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Centroid-centred copy of a flat xyz frame. Each frame on its own centroid, always:
 *  centring on the folded structure's centroid drifts the coil off frame, and centring on
 *  the trajectory's bounding box breaks the ending. */
export function centre(points) {
  const n = points.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += points[3 * i]; cy += points[3 * i + 1]; cz += points[3 * i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const out = new Float64Array(points.length);
  for (let i = 0; i < n; i++) {
    out[3 * i] = points[3 * i] - cx;
    out[3 * i + 1] = points[3 * i + 1] - cy;
    out[3 * i + 2] = points[3 * i + 2] - cz;
  }
  return out;
}

export function maxAbs(points) {
  let m = 0;
  for (let i = 0; i < points.length; i++) {
    const v = Math.abs(points[i]);
    if (v > m) m = v;
  }
  return m;
}

export function radiusOfGyration(points) {
  const centred = centre(points);
  const n = centred.length / 3;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += centred[3 * i] ** 2 + centred[3 * i + 1] ** 2 + centred[3 * i + 2] ** 2;
  }
  return Math.sqrt(sum / n);
}

/**
 * The live path's scale: from the first frame, then monotonically upward.
 *
 * Seeded at the starting coil's extent times `headroom`. Measured across the launch
 * gallery, the widest frame of a trajectory is 1.05 to 1.39 times the first frame, so 1.45
 * covers every one of them and the scale never has to move at all in the common case. When
 * it does have to move, it only ever grows: a structure that appears to shrink halfway
 * through a fold reads as a bug, and one that briefly fills more of the stage does not.
 */
export class LiveScale {
  constructor(firstFrameExtent, headroom = 1.45) {
    this.halfExtent = Math.max(firstFrameExtent * headroom, 1e-6);
    this.grewTimes = 0;
  }

  /** Accommodate a frame, growing if it does not fit. Returns units per Angstrom. */
  accommodate(extent) {
    if (extent > this.halfExtent) {
      this.halfExtent = extent;
      this.grewTimes++;
    }
    return QUANTISED_RANGE / this.halfExtent;
  }

  get angstromsPerUnit() { return this.halfExtent / QUANTISED_RANGE; }
}

/**
 * One frame object, in the shape `/api/fold/<id>` returns and the player consumes.
 *
 * @param caAngstroms flat xyz, length 3n, in Angstroms
 * @param scale       units per Angstrom
 * @param tracker     a ContactTracker carried across the whole trajectory
 * @param smoother    a PSEA Hysteresis carried across the whole trajectory
 * @param confidence  per-residue, 0..100, or null when there is nothing to report
 */
export function buildFrame(caAngstroms, scale, tracker, smoother, confidence) {
  // Contacts and secondary structure are computed on the ANGSTROM coordinates, never on
  // the quantised ones: the 8.0 and 8.5 cutoffs are lengths, and against a unitless box
  // they would mean whatever the scale happened to be.
  const newContacts = tracker.update(caAngstroms);
  const raw = assign(caAngstroms);
  const smoothed = smoother.smooth(raw.ss, raw.confidence);
  const ss = smoothed.ss;

  const centred = centre(caAngstroms);
  const points = new Array(centred.length);
  // `|| 0` normalises negative zero, which JSON writes as `0` but which is a distinct value
  // in JavaScript and would fail a strict comparison against the baked artefact.
  for (let i = 0; i < centred.length; i++) {
    points[i] = roundHalfToEven(centred[i] * scale) || 0;
  }

  return {
    points,
    newContacts,
    ss: runLengthEncode(ss),
    // Every integer here goes through the same rounding rule as the baker's, for the same
    // reason: these are compared for exact equality across the two paths.
    conf: confidence ? Array.from(confidence, c => roundHalfToEven(c)) : [],
    // Carried through the same hysteresis as the structure, so a held residue keeps its own
    // structure's certainty rather than borrowing a different one's. The cartoon sweeps its
    // cross section from this, so a live fold's ribbons grow in exactly as a baked fold's do.
    ssConf: Array.from(smoothed.confidence, c => roundHalfToEven(c * 100)),
    rg: roundHalfToEven(radiusOfGyration(caAngstroms) * 10),
    q: 0,     // filled in by the caller, which is the only place that knows the native state
  };
}

/** A tracker and a smoother for one trajectory, so a caller cannot forget to carry them. */
export function newTrajectoryState(residueCount) {
  return { tracker: new ContactTracker(), smoother: new Hysteresis(residueCount, 3) };
}
