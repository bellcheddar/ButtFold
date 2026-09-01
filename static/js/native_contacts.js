/* The native contact map, and how much of it a frame has formed.
 *
 * This lived inside `fold_worker.js` until the droplet queue learned to stream, because
 * only the live fold needed it. Now two paths do: the worker folds in this tab, and the
 * main thread turns the droplet's raw coordinates into frames as they are written. Both
 * have to answer "how folded is residue 34" the same way or the two engines would report
 * different confidences for the same trajectory, and the confidence colour mode would mean
 * something different depending on which button you pressed.
 *
 * That is the same rule `frames.js` exists for, one level down: one frame builder, and now
 * one definition of the contacts it scores against.
 */

/** Native contact pairs and their reference distances, from the native structure.
 *
 * The same definition the C uses when it builds the model: |i-j| >= minSep and a native
 * CA-CA distance under the cutoff. Recomputed here rather than asked of the module, because
 * the module reports only the chain-wide fraction and the sonifier needs it per residue. */
export function nativeContacts(native, cutoff, minSep) {
  const n = native.length / 3;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + minSep; j < n; j++) {
      const dx = native[3 * j] - native[3 * i];
      const dy = native[3 * j + 1] - native[3 * i + 1];
      const dz = native[3 * j + 2] - native[3 * i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < cutoff) pairs.push([i, j, d]);
    }
  }
  return pairs;
}

/**
 * Per-residue native fraction, on a 0 to 100 scale: the confidence the sonifier reads.
 *
 * A residue with no native contacts of its own takes the chain's overall value, because
 * 0/0 is not 0. A flexible terminus or a residue on a convex surface can have no long-range
 * partners at all, and scoring those zero would paint them as permanently unfolded even in
 * the native structure. Measured on the launch gallery: 5 of ubiquitin's 76 residues take
 * that branch, so it is not dead code.
 */
export function perResidueNativeFraction(points, pairs, n, tolerance = 1.2) {
  const formed = new Float64Array(n);
  const total = new Float64Array(n);
  let close = 0;
  for (const [i, j, sigma] of pairs) {
    total[i]++; total[j]++;
    const dx = points[3 * j] - points[3 * i];
    const dy = points[3 * j + 1] - points[3 * i + 1];
    const dz = points[3 * j + 2] - points[3 * i + 2];
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < tolerance * sigma) {
      formed[i]++; formed[j]++; close++;
    }
  }
  const overall = pairs.length ? close / pairs.length : 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (total[i] > 0 ? formed[i] / total[i] : overall) * 100;
  return { confidence: out, q: overall };
}
