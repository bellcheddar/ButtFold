/* Drawing the in-between: a pose between two frames that the model never computed.
 *
 * `FRAME_CAP = 150` in the baker has carried the comment "interpolated in the browser"
 * since it was written, and until now nothing interpolated anything. A trajectory is 150
 * frames and the music is about forty seconds, so the structure changed four times a second
 * while the page redrew sixty: every pose was held for fifteen frames and then replaced,
 * which is what Marc saw as jumping.
 *
 * **This is a morph, not physics, and the numbers say why it has to be.** Measured across
 * the whole gallery, an alpha carbon moves up to 30 A between adjacent frames - further than
 * the protein is wide - because 50,000 integration steps separate them. Three things follow:
 *
 *  1. Nothing drawn between two frames is a state the model passed through. The page says so
 *     in the disclosure paragraph rather than leaving it implied.
 *  2. A straight lerp is not merely inexact, it is broken: the chord between two points 30 A
 *     apart cuts the corner, and measured at the midpoint the mean CA-CA bond came out at 86
 *     to 94% of its true length with the worst bond 97% short - a chain drawn with residues
 *     sitting on top of each other.
 *  3. Superposing each frame onto the one before it, which is what a molecular viewer does
 *     to stop a trajectory tumbling, recovers almost none of that: it took the largest step
 *     from 30.1 A to 26.6 A. The motion between these frames is genuinely conformational and
 *     not the molecule turning, so the whole Kabsch apparatus was measured and dropped.
 *
 * So the lerp is followed by a bond projection: sweep the chain restoring every CA-CA
 * distance to what it should be at this point between the two frames. Measured over every
 * adjacent pair in the gallery at t = 0.25, 0.5 and 0.75: no passes leaves a mean error of
 * 8.4% and a worst of 97%, four passes leaves 0.07% and 11.5%, and sixteen leaves 0.00% and
 * 0.7%. Sixteen it is, at about 75 bonds a pass - a rounding error next to the 4.7 ms the
 * cartoon sweep itself costs.
 *
 * What comes out is a chain that writhes rather than teleports. It is an animation between
 * two computed states, and the two computed states are the only physics in it.
 */

/** Bond projection passes. 16 leaves the worst CA-CA bond 0.7% off its target length, which
 *  is a twentieth of a pixel on screen; see the measurements in the header. */
export const RELAX_PASSES = 16;

/** CA-CA distances along the chain, written into `out`. */
export function bondLengths(points, n, out) {
  for (let i = 0; i < n - 1; i++) {
    const a = 3 * i;
    const dx = points[a + 3] - points[a];
    const dy = points[a + 4] - points[a + 1];
    const dz = points[a + 5] - points[a + 2];
    out[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return out;
}

/**
 * Push every bond back to its target length, in place.
 *
 * Gauss-Seidel, alternating direction each pass: a sweep that always ran from the N terminus
 * would leave the accumulated correction piled up at the C terminus, and the chain would
 * appear to be dragged by one end.
 */
export function relaxBonds(points, target, n, passes = RELAX_PASSES) {
  for (let pass = 0; pass < passes; pass++) {
    const forward = (pass & 1) === 0;
    for (let k = 0; k < n - 1; k++) {
      const i = forward ? k : n - 2 - k;
      const a = 3 * i, b = a + 3;
      let dx = points[b] - points[a];
      let dy = points[b + 1] - points[a + 1];
      let dz = points[b + 2] - points[a + 2];
      // The floor matters: a lerp can put two residues almost exactly on top of each other,
      // and the direction to separate them in is then whatever the noise says. Any direction
      // is better than a division by zero, and the next pass corrects it.
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      const scale = 0.5 * (length - target[i]) / length;
      dx *= scale; dy *= scale; dz *= scale;
      points[a] += dx; points[a + 1] += dy; points[a + 2] += dz;
      points[b] -= dx; points[b + 1] -= dy; points[b + 2] -= dz;
    }
  }
  return points;
}

/** Reusable buffers for one residue count, so the render loop allocates nothing. */
export function newMorphScratch(n) {
  return {
    n,
    points: new Float32Array(n * 3),
    confidence: new Float32Array(n),
    ssConfidence: new Float32Array(n),
    lengthsA: new Float64Array(Math.max(n - 1, 1)),
    lengthsB: new Float64Array(Math.max(n - 1, 1)),
    target: new Float64Array(Math.max(n - 1, 1)),
    ss: new Array(n),
  };
}

/**
 * A pose `t` of the way from frame `a` to frame `b`, in the shape the stage renders.
 *
 * `t` is expected in (0, 1); the caller renders the frame itself at the ends rather than
 * paying for a morph that would return a copy of it.
 */
export function morphFrames(a, b, t, scratch, passes = RELAX_PASSES) {
  const n = scratch.n;
  const points = scratch.points;
  for (let i = 0; i < points.length; i++) {
    points[i] = a.points[i] + (b.points[i] - a.points[i]) * t;
  }

  // The bond lengths the chain should have at this point between the two frames, which is
  // itself an interpolation: the chain is not rigid, and forcing it to frame a's geometry
  // would fight frame b for the whole transition.
  bondLengths(a.points, n, scratch.lengthsA);
  bondLengths(b.points, n, scratch.lengthsB);
  for (let i = 0; i < n - 1; i++) {
    scratch.target[i] = scratch.lengthsA[i] + (scratch.lengthsB[i] - scratch.lengthsA[i]) * t;
  }
  relaxBonds(points, scratch.target, n, passes);

  // Secondary structure is a letter per residue and cannot be averaged, so a residue that
  // changes has its ribbon narrowed to a cord and grown back as the other kind: the width
  // the cartoon sweeps comes from `ssConfidence`, so taking that through zero at the halfway
  // point is a morph between two cross sections rather than one becoming the other in a
  // single redraw. A residue that does not change simply crossfades its certainty.
  const sameSS = a.ss === b.ss;
  const ss = sameSS ? a.ss : scratch.ss;
  const confA = a.confidence, confB = b.confidence;
  const ssA = a.ssConfidence, ssB = b.ssConfidence;
  const dip = t < 0.5 ? 1 - 2 * t : 2 * t - 1;
  for (let i = 0; i < n; i++) {
    if (!sameSS) ss[i] = a.ss[i] === b.ss[i] ? a.ss[i] : (t < 0.5 ? a.ss[i] : b.ss[i]);
    if (confA && confB) scratch.confidence[i] = confA[i] + (confB[i] - confA[i]) * t;
    if (ssA && ssB) {
      scratch.ssConfidence[i] = a.ss[i] === b.ss[i]
        ? ssA[i] + (ssB[i] - ssA[i]) * t
        : (t < 0.5 ? ssA[i] : ssB[i]) * dip;
    }
  }

  return {
    points,
    ss: sameSS ? ss : ss.join(''),
    confidence: (confA && confB) ? scratch.confidence : (confA ?? confB ?? null),
    ssConfidence: (ssA && ssB) ? scratch.ssConfidence : (ssA ?? ssB ?? null),
  };
}
