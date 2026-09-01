/* Which residue pairs come into contact, and on which frame. The note onsets.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldGeometry/ContactTracker.swift`, commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, and tested against `tools/contacts.py`'s
 * reference output rather than against itself.
 *
 * What matters is the **transition**, not the state: a pair that stays in contact for two
 * hundred frames is one note, not two hundred.
 *
 * Two details keep it musical, and both are preserved:
 *
 *  - **Hysteresis.** A pair forms at 8.0 A and only breaks once it exceeds 8.5 A. Without
 *    the gap, a pair sitting exactly on 8 A chatters in and out and machine-guns the
 *    sequencer.
 *  - **A stable order.** Events come back sorted by sequence separation and then by first
 *    residue, so the same trajectory always produces the same sequence of notes. Separation
 *    sets a note's register, so this is the order the music is written in.
 *
 * Never feed it interpolated frames. Only raw model readouts advance it; 60 fps of
 * interpolation would fire the same contact repeatedly as the spline wobbles across the
 * threshold. The baked path does not use this at all - its onsets are computed at bake
 * time - so this runs only on the live and queued paths, inside the worker.
 */

export const FORMATION_CUTOFF = 8.0;
export const BREAK_CUTOFF = 8.5;
export const MINIMUM_SEPARATION = 3;

export class ContactTracker {
  constructor({ formationCutoff = FORMATION_CUTOFF,
                breakCutoff = BREAK_CUTOFF,
                minimumSeparation = MINIMUM_SEPARATION } = {}) {
    if (breakCutoff < formationCutoff) {
      throw new Error('break cutoff must not be below the formation cutoff');
    }
    this.formationCutoff = formationCutoff;
    this.breakCutoff = breakCutoff;
    this.minimumSeparation = minimumSeparation;
    this.residueCount = 0;
    this.held = null;      // Uint8Array, n*n, upper triangle only
  }

  reset() { this.held?.fill(0); }

  get activeContactCount() {
    if (!this.held) return 0;
    let count = 0;
    for (let k = 0; k < this.held.length; k++) count += this.held[k];
    return count;
  }

  /** Feed one raw frame of flat xyz (Float32Array or number[]); get the pairs that formed. */
  update(positions) {
    const n = positions.length / 3;
    if (n !== this.residueCount) {
      this.residueCount = n;
      this.held = new Uint8Array(n * n);
    }
    if (n <= this.minimumSeparation) return [];

    const formed = [];
    const formSq = this.formationCutoff * this.formationCutoff;
    const breakSq = this.breakCutoff * this.breakCutoff;
    for (let i = 0; i < n - this.minimumSeparation; i++) {
      const xi = positions[3 * i], yi = positions[3 * i + 1], zi = positions[3 * i + 2];
      for (let j = i + this.minimumSeparation; j < n; j++) {
        const dx = positions[3 * j] - xi;
        const dy = positions[3 * j + 1] - yi;
        const dz = positions[3 * j + 2] - zi;
        // Compared squared, so no sqrt in the inner loop. The cutoffs are squared once
        // above; comparing d^2 to c^2 is the same predicate as comparing d to c for
        // non-negative values.
        const d2 = dx * dx + dy * dy + dz * dz;
        const slot = i * n + j;
        if (this.held[slot]) {
          if (d2 > breakSq) this.held[slot] = 0;
        } else if (d2 <= formSq) {
          this.held[slot] = 1;
          formed.push([i, j]);
        }
      }
    }
    formed.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]) || a[0] - b[0]);
    return formed;
  }
}

/** Every pair currently in contact, for a one-off map rather than a stream of events. */
export function contactMap(positions, cutoff = FORMATION_CUTOFF,
                           minimumSeparation = MINIMUM_SEPARATION) {
  const n = positions.length / 3;
  const pairs = [];
  if (n <= minimumSeparation) return pairs;
  const cutoffSq = cutoff * cutoff;
  for (let i = 0; i < n - minimumSeparation; i++) {
    const xi = positions[3 * i], yi = positions[3 * i + 1], zi = positions[3 * i + 2];
    for (let j = i + minimumSeparation; j < n; j++) {
      const dx = positions[3 * j] - xi;
      const dy = positions[3 * j + 1] - yi;
      const dz = positions[3 * j + 2] - zi;
      if (dx * dx + dy * dy + dz * dz <= cutoffSq) pairs.push([i, j]);
    }
  }
  return pairs;
}
