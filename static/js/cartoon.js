/* The cartoon: flat helical ribbons, arrowed strands, a thin round cord for coil.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldRender/TubeGeometry.swift`, commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, including the reasoning for every number, which
 * is the valuable part: each one is there because something else looked wrong.
 *
 * ButtFold shipped a plain round tube swept along a Catmull-Rom spline through the alpha
 * carbons. That is what a tube renderer does and it is not what a cartoon does, and it fails
 * in four separate ways at once. This is the fix, and the four are worth naming because they
 * are what the code below is for:
 *
 *  1. **Helix and sheet are flat ribbons, not thicker tubes.** A round section swept along a
 *     helix reads as a coiled coil, which is a different thing entirely and one that means
 *     something else in this field.
 *  2. **A Catmull-Rom spline cannot draw a helix.** An alpha helix advances 100 degrees per
 *     residue, so a full turn is 3.6 alpha carbons; Catmull-Rom's midpoint between two
 *     points that far apart on a circle sits at 0.831 of the radius, nearly 17% inside the
 *     true curve. That is why the helices came out as rounded triangles, and no amount of
 *     tessellation fixes it, because the curve itself is the wrong shape. Blending the two
 *     circular arcs through each overlapping triple reproduces a circle exactly.
 *  3. **The ribbon's roll must come from the structure, not from the curve.** A
 *     parallel-transported frame carries an arbitrary starting rotation along the chain, so
 *     a flattened ribbon twists at angles that have nothing to do with the protein.
 *  4. **The surface normal of a squared-off section is the gradient of its implicit form**,
 *     not the radial direction. Getting that wrong lights a flat slab as though it were
 *     still round, which is most of what makes a section read as a sausage.
 *
 * Proportions are in ANGSTROMS, close to PyMOL's defaults, because that is the visual
 * language every structural biologist already reads. The stage works in the artefact's
 * quantised units, so `profileInUnits` converts them with the fold's own recorded ruler.
 */

/** Cartoon proportions, in angstroms. */
export const PROFILE = {
  /** Radius of the thin round cord used for coil. */
  coilRadius: 0.20,
  /** The helix ribbon: wide and flat, so a helix reads as a coiled band. */
  helixHalfWidth: 1.35,
  helixHalfThickness: 0.25,
  /** The strand ribbon. */
  sheetHalfWidth: 1.40,
  sheetHalfThickness: 0.22,
  /** Half-width at the base of a strand's arrowhead. */
  arrowHalfWidth: 1.95,
  /** Half-width at its point. Not zero: a true point degenerates the ring into a line and
   *  every triangle around it collapses. */
  arrowTipHalfWidth: 0.16,
  /** How many residues at the C-terminal end of a strand the arrowhead spans. */
  arrowResidues: 1.6,
  /** Over how many residues a ribbon narrows into the cord at its ends. One residue leaves a
   *  broad flat shoulder facing along the chain, which catches the light quite differently
   *  from the ribbon it belongs to and reads as something showing through. */
  boundaryFadeResidues: 1.5,
  /** How many times to average the ribbon's roll along the chain. Removes the per-residue
   *  alternation of a beta pleat, which otherwise corkscrews a strand that should lie flat.
   *  A steady roll, like a helix's, survives it. */
  frameSmoothingPasses: 3,
  /** How square the cross section is: |x/w|^k + |y/h|^k = 1. At k = 2 it is an ellipse,
   *  which is what a tube renderer sweeps. At 6 the faces are flat and the edges crisp, with
   *  just enough rounding to catch a highlight. Coil keeps 2, because a cord is round. */
  ribbonSharpness: 6,
  /** Spline samples per residue. */
  samplesPerResidue: 10,
  /** How hard to pull the guide path toward the axis. Strands only: smoothing a helix
   *  shrinks it, and one full [1,2,1] pass multiplies a helix's radius by 0.41. */
  smoothing: 1.0,
  smoothingPasses: 3,
  /** Vertices around the cross section. */
  radialSegments: 20,
};

export const COIL = 'C', HELIX = 'H', SHEET = 'E';

/** The same proportions in the artefact's quantised units. */
export function profileInUnits(angstromsPerUnit, profile = PROFILE) {
  const k = 1 / Math.max(angstromsPerUnit, 1e-9);
  const out = { ...profile };
  for (const key of ['coilRadius', 'helixHalfWidth', 'helixHalfThickness', 'sheetHalfWidth',
                     'sheetHalfThickness', 'arrowHalfWidth', 'arrowTipHalfWidth']) {
    out[key] = profile[key] * k;
  }
  return out;
}

/* ------------------------------------------------------------------ small vector maths -- */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                         a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const len = a => Math.sqrt(dot(a, a));
function unit(a, fallback = [0, 0, 1]) {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}
function perpendicular(v) {
  // Pick the axis least aligned with v, so the cross product is well conditioned.
  const [x, y, z] = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  const axis = x < y ? (x < z ? [1, 0, 0] : [0, 0, 1])
                     : (y < z ? [0, 1, 0] : [0, 0, 1]);
  const p = cross(v, axis);
  return len(p) > 1e-6 ? unit(p) : [1, 0, 0];
}

/* ------------------------------------------------------------------ confidence ---------- */

/**
 * P-SEA's certainty, remapped to "how far to grow the ribbon".
 *
 * **These are two different quantities, and conflating them draws thin strands.** PhoneFold's
 * default assigner is a trained classifier whose confidence is a probability, so a real
 * strand arrives at 1.0 and its ribbon is swept at full width. ButtFold uses P-SEA, whose
 * confidence is a *quality score within its distance windows*: 0.4 + 0.6 x how centrally the
 * measurements sit, floored at 0.35 for a residue picked up by seeding or extension rather
 * than by the strict test. A real beta strand scores low on that scale because P-SEA's d4
 * window (12.4 +/- 1.1 A) is tight, not because it is not a strand.
 *
 * Measured on ubiquitin's final frame, swept straight from the raw score: helix rings came
 * out at 68% of the intended ribbon width and sheet rings at **26%**, against a cord at
 * 100%. A strand drawn at a quarter width is not a ribbon, which is exactly the complaint.
 *
 * So the remap asks P-SEA's own question instead: was this residue assigned by the STRICT
 * criterion, or picked up by extension? The strict test starts at 0.4 and extension sits at
 * 0.35, so a smoothstep across that boundary separates them, and the result spans 0.5 to 1
 * rather than 0 to 1 - an extended residue is still part of the element and should be a
 * slightly narrower ribbon, not a cord.
 *
 * Done here, in the renderer, and NOT in the assigner or the artefact: `ssConf` stays exactly
 * what P-SEA reported, so the parity tests and the committed data remain a faithful record,
 * and this stays a presentation decision, which is what it is.
 */
export function ribbonConfidence(c) {
  if (!(c > 0)) return 0;                       // coil, which has no ribbon to grow
  const t = Math.min(Math.max((c - 0.30) / (0.42 - 0.30), 0), 1);
  return 0.5 + 0.5 * (t * t * (3 - 2 * t));     // smoothstep, so it arrives without a corner
}

/**
 * One confidence per secondary-structure element, not per residue.
 *
 * The cross section grows with confidence so structure appears rather than snaps, and
 * confidence is per residue, so a ribbon's width followed every wobble in the assigner's
 * certainty. Measured on protein G's second strand, the half-width ran 0.72, 0.92, 1.05,
 * 0.95, 0.83, 0.72: a 1.46-fold swing along a single strand, which on screen is a ribbon
 * pinching in and out like a squeezed tube. No cartoon draws that.
 */
export function levelledConfidence(ss, confidence) {
  const out = confidence.slice();
  let start = 0;
  while (start < ss.length) {
    let end = start;
    while (end + 1 < ss.length && ss[end + 1] === ss[start]) end++;
    if (ss[start] !== COIL) {
      let total = 0;
      for (let i = start; i <= end; i++) total += confidence[i];
      const mean = total / (end - start + 1);
      for (let i = start; i <= end; i++) out[i] = mean;
    }
    start = end + 1;
  }
  return out;
}

/** Ease each element's confidence down toward its ends, so the ribbon tapers into the cord
 *  over several residues rather than collapsing across one. Capped at a third of the
 *  element's length, so a short strand keeps a body. */
export function taperedConfidence(ss, confidence, profile) {
  if (!ss.length || !(profile.boundaryFadeResidues > 0)) return confidence.slice();
  const out = confidence.slice();
  let start = 0;
  while (start < ss.length) {
    let end = start;
    while (end + 1 < ss.length && ss[end + 1] === ss[start]) end++;
    if (ss[start] !== COIL) {
      const length = end - start + 1;
      const fade = Math.min(profile.boundaryFadeResidues, Math.max(length / 3, 0.5));
      for (let i = start; i <= end; i++) {
        const nearest = Math.min(i - start + 0.5, end - i + 0.5);
        const ease = Math.min(nearest / fade, 1);
        // Smoothstep, so the taper leaves and arrives without a corner.
        out[i] = confidence[i] * (ease * ease * (3 - 2 * ease));
      }
    }
    start = end + 1;
  }
  return out;
}

/**
 * Guide points: the alpha-carbon path, smoothed inside STRANDS only.
 *
 * A strand may curve; it may not zigzag, and those are separable. The alternating component,
 * how far each alpha carbon sits off the midpoint of its neighbours, is the pleat, and a
 * [1,2,1] pass attacks it directly while barely touching a smooth bend. Measured on protein
 * G's sheet, the zigzag ran 1.74 A untouched (about the ribbon's own half-width, which is
 * why the edges looked serrated) and 0.17 A after three full passes, keeping 1.75 A of real
 * curvature.
 *
 * Helices are deliberately untouched. Smoothing one shrinks it: a full [1,2,1] pass
 * multiplies the radius by (2 + 2 cos 100 degrees) / 4 = 0.41. A helix is drawn at the
 * radius it has, and the roundness comes from the arc spline instead.
 */
export function guidePoints(ca, ss, confidence, profile) {
  const n = ca.length / 3;
  if (n < 3 || !(profile.smoothing > 0) || profile.smoothingPasses < 1) return ca.slice();
  let guide = Float64Array.from(ca);
  for (let pass = 0; pass < profile.smoothingPasses; pass++) {
    const next = guide.slice();
    for (let i = 1; i < n - 1; i++) {
      if (ss[i] !== SHEET) continue;
      const amount = profile.smoothing * Math.min(Math.max(confidence[i], 0), 1);
      for (let k = 0; k < 3; k++) {
        const averaged = (guide[3 * (i - 1) + k] + guide[3 * i + k] * 2
                          + guide[3 * (i + 1) + k]) * 0.25;
        next[3 * i + k] = guide[3 * i + k] + (averaged - guide[3 * i + k]) * amount;
      }
    }
    guide = next;
  }
  return guide;
}

/* ------------------------------------------------------------------ the curve ----------- */

/**
 * A point on the circle through a, b, c, going from b to c as t runs 0 to 1.
 *
 * The straightness guard is on the SINE of the turn, not on the absolute length of the cross
 * product: at 3.8 A spacing a sine of a hundred-millionth still clears 1e-7, and the circle
 * it describes has a centre computed from the difference of two nearly equal large numbers,
 * so the arc wanders. Strands are where that bites, being close to straight already and
 * straighter after their pleat is smoothed. Below the floor a straight line is not an
 * approximation but the correct answer; between floor and ceiling the two are blended so
 * there is no seam where the treatment changes.
 */
export function arcPoint(a, b, c, t) {
  const u = sub(b, a);
  const v = sub(c, a);
  const normal = cross(u, v);
  const normalLength = len(normal);
  const line = add(b, mul(sub(c, b), t));

  const sine = normalLength / Math.max(len(u) * len(v), 1e-12);
  const straightBelow = 0.02, curvedAbove = 0.10;
  if (!(sine > straightBelow)) return line;
  const arcWeight = Math.min((sine - straightBelow) / (curvedAbove - straightBelow), 1);

  const uu = dot(u, u), vv = dot(v, v);
  const centre = add(a, mul(add(mul(cross(normal, u), vv), mul(cross(v, normal), uu)),
                            1 / (2 * normalLength * normalLength)));
  const radius = len(sub(b, centre));
  if (!(radius > 1e-6) || !Number.isFinite(radius)) return line;

  const e1 = mul(sub(b, centre), 1 / radius);
  const nHat = mul(normal, 1 / normalLength);
  const e2 = cross(nHat, e1);
  const toC = sub(c, centre);
  // The short way round: consecutive alpha carbons never subtend more than half a turn.
  const sweep = Math.atan2(dot(toC, e2), dot(toC, e1));
  const angle = sweep * t;
  const arc = add(centre, add(mul(e1, Math.cos(angle) * radius),
                              mul(e2, Math.sin(angle) * radius)));
  if (!arc.every(Number.isFinite)) return line;
  return add(line, mul(sub(arc, line), arcWeight));
}

/** The guide curve. Blending the two circular arcs through each overlapping triple
 *  reproduces a circle exactly, so a helix is drawn at its true radius. C1 at the joins. */
export function splinePoint(ca, n, u) {
  if (n < 2) return [ca[0] ?? 0, ca[1] ?? 0, ca[2] ?? 0];
  const clamped = Math.min(Math.max(u, 0), n - 1);
  const i = Math.min(Math.floor(clamped), n - 2);
  const t = clamped - i;
  const at = k => [ca[3 * k], ca[3 * k + 1], ca[3 * k + 2]];
  const p0 = at(Math.max(i - 1, 0));
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(Math.min(i + 2, n - 1));
  const before = arcPoint(p0, p1, p2, t);
  const after = arcPoint(p3, p1, p2, t);
  return add(mul(before, 1 - t), mul(after, t));
}

/* ------------------------------------------------------------------ cross sections ------ */

export const SHARPNESS_LEVELS = 16;

/**
 * One ring of a superellipse, with its vertices spaced evenly ALONG THE SECTION rather than
 * evenly in angle.
 *
 * Uniform angle is badly behaved on a flattened superellipse: measured on the helix ribbon,
 * twenty uniform-angle samples put fourteen of them on the two thin edges, leaving the broad
 * faces spanned by segments 9.8 times longer than the shortest. Shading interpolated across
 * spacing that uneven is what makes the sides of a ribbon look coarse. Arc length takes the
 * ratio to 2.8 and puts six on the edges.
 */
export function sectionTable(segments, k, aspect) {
  const dense = 2048;
  const points = new Float64Array(dense * 2);
  for (let i = 0; i < dense; i++) {
    const angle = 2 * Math.PI * i / dense;
    const c = Math.cos(angle), s = Math.sin(angle);
    points[2 * i] = Math.sign(c) * Math.pow(Math.abs(c), 2 / k) * aspect;
    points[2 * i + 1] = Math.sign(s) * Math.pow(Math.abs(s), 2 / k);
  }
  const cumulative = new Float64Array(dense + 1);
  for (let i = 0; i < dense; i++) {
    const j = (i + 1) % dense;
    cumulative[i + 1] = cumulative[i]
      + Math.hypot(points[2 * j] - points[2 * i], points[2 * j + 1] - points[2 * i + 1]);
  }
  const total = cumulative[dense];

  const offsets = new Float64Array(segments * 2);
  const normals = new Float64Array(segments * 2);
  for (let r = 0; r < segments; r++) {
    const wanted = total * r / segments;
    let lo = 0, hi = dense;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < wanted) lo = mid + 1; else hi = mid;
    }
    const angle = 2 * Math.PI * Math.min(lo, dense - 1) / dense;
    const c = Math.cos(angle), s = Math.sin(angle);
    offsets[2 * r] = Math.sign(c) * Math.pow(Math.abs(c), 2 / k);
    offsets[2 * r + 1] = Math.sign(s) * Math.pow(Math.abs(s), 2 / k);
    // The surface normal is the gradient of the implicit form:
    // n proportional to (sign(x)|x/w|^(k-1)/w, sign(y)|y/h|^(k-1)/h).
    normals[2 * r] = Math.sign(c) * Math.pow(Math.abs(c), 2 * (k - 1) / k);
    normals[2 * r + 1] = Math.sign(s) * Math.pow(Math.abs(s), 2 * (k - 1) / k);
  }
  return { offsets, normals };
}

/** Half-width and half-thickness, blended out of coil so structure grows rather than
 *  appears. `widthScale` shapes the arrowhead and is applied to the sheet's TARGET width,
 *  not to the blended result: scaling the blend collapses the tip to an order of magnitude
 *  thinner than the cord drawn at the very next sample, whose rearward-facing step shows
 *  end-on as a round disc in the middle of the arrowhead. */
export function section(structure, confidence, profile, widthScale = 1) {
  const t = Math.min(Math.max(confidence, 0), 1);
  const grow = target => profile.coilRadius + (target - profile.coilRadius) * t;
  if (structure === HELIX) return [grow(profile.helixHalfWidth), grow(profile.helixHalfThickness)];
  if (structure === SHEET) {
    return [grow(profile.sheetHalfWidth * widthScale), grow(profile.sheetHalfThickness)];
  }
  return [profile.coilRadius, profile.coilRadius];
}

/**
 * A MULTIPLIER on the strand's half-width, shaping the arrowhead. 1 everywhere else.
 *
 * A multiplier and not an absolute width, because an absolute one overrides whatever the
 * structure at that sample actually is: on trp-cage, whose assignment carries a single sheet
 * residue, a 1.6-residue head reached back across two COIL residues and widened them. And
 * past the tip the width jumped straight back to the full strand width, which is a notch in
 * the ribbon. The head is never longer than the strand it caps.
 */
export function arrowScales(ss, parameters, profile) {
  const scales = new Float64Array(parameters.length).fill(1);
  if (!(profile.arrowResidues > 0) || !(profile.sheetHalfWidth > 0)) return scales;

  const runs = [];
  let start = null;
  for (let i = 0; i < ss.length; i++) {
    if (ss[i] === SHEET) {
      if (start === null) start = i;
      if (i + 1 === ss.length || ss[i + 1] !== SHEET) { runs.push([start, i]); start = null; }
    }
  }
  if (!runs.length) return scales;

  for (let index = 0; index < parameters.length; index++) {
    const u = parameters[index];
    for (const [runStart, runEnd] of runs) {
      const head = Math.min(profile.arrowResidues, runEnd - runStart + 1);
      const base = runEnd - head;
      // The point sits at the end of the strand's EXTENT, not at its last residue index:
      // the structure fades out over the half residue past it, and stopping the taper at the
      // index leaves the width snapping back to the full strand for that half residue.
      const tip = runEnd + 0.5;
      if (!(u >= base && u <= tip && head > 0)) continue;
      const along = Math.max((tip - u) / (head + 0.5), 0);
      const target = profile.arrowTipHalfWidth
        + (profile.arrowHalfWidth - profile.arrowTipHalfWidth) * along;
      scales[index] = target / profile.sheetHalfWidth;
      break;
    }
  }
  return scales;
}

/** The assignment at a fractional residue, with the outgoing structure faded out across a
 *  boundary rather than cut to the incoming one: the SHAPE passes through coil, which is
 *  what a real ribbon does. */
export function interpolatedStructure(ss, confidence, u) {
  if (!ss.length) return [COIL, 0];
  const clamped = Math.min(Math.max(u, 0), ss.length - 1);
  const i = Math.min(Math.floor(clamped), Math.max(ss.length - 2, 0));
  const t = clamped - i;
  const j = Math.min(i + 1, ss.length - 1);
  if (ss[i] === ss[j]) return [ss[i], confidence[i] + (confidence[j] - confidence[i]) * t];
  return t < 0.5 ? [ss[i], confidence[i] * (1 - t * 2)]
                 : [ss[j], confidence[j] * ((t - 0.5) * 2)];
}

/**
 * Which sample each ring sits on, and which residue paints it.
 *
 * One ring per spline sample, plus a coincident duplicate wherever the nearest residue
 * changes, painted by the OUTGOING residue. Without the duplicate the GPU interpolates the
 * colour from one structure to another across the boundary sample, so every helix end wears
 * a pale washed-out band and every strand junction a magenta one. The quads between the
 * coincident pair are zero-area and never rasterise, so the colour changes in a hard edge,
 * which is what a cartoon does.
 *
 * A function of the chain length and the profile ALONE, never of a frame's assignments, so
 * the vertex count is constant across a trajectory and the buffers are allocated once.
 */
export function ringLayout(residues, profile) {
  const sampleCount = (residues - 1) * profile.samplesPerResidue + 1;
  const nearest = s => Math.min(Math.max(Math.round(s / profile.samplesPerResidue), 0),
                                residues - 1);
  const rings = [];
  for (let s = 0; s < sampleCount; s++) {
    if (s > 0 && nearest(s - 1) !== nearest(s)) rings.push([s, nearest(s - 1)]);
    rings.push([s, nearest(s)]);
  }
  return rings;
}

/** Vertices and indices for a chain of this length. Constant for a given residue count. */
export function meshSize(residues, profile = PROFILE) {
  const rings = ringLayout(residues, profile).length;
  const segments = profile.radialSegments;
  // Plus two end caps: a centre vertex and a duplicated rim each.
  return {
    rings,
    vertices: rings * segments + 2 * (1 + segments),
    indices: (rings - 1) * segments * 6 + 2 * segments * 3,
  };
}

/** Triangle indices. A function of the residue count alone, so they are built once. */
export function buildIndices(residues, profile = PROFILE) {
  const { rings, vertices } = meshSize(residues, profile);
  const segments = profile.radialSegments;
  const indices = new Uint32Array(meshSize(residues, profile).indices);
  let at = 0;
  for (let s = 0; s < rings - 1; s++) {
    const base = s * segments;
    for (let r = 0; r < segments; r++) {
      const next = (r + 1) % segments;
      const a = base + r, b = base + next, c = a + segments, d = b + segments;
      indices[at++] = a; indices[at++] = b; indices[at++] = c;
      indices[at++] = b; indices[at++] = d; indices[at++] = c;
    }
  }
  // End caps. Winding matches the sweep's, geometric normal outward: inverted, and with
  // back-face culling on, the renderer draws the tube's interior and every ribbon looks
  // hollow.
  for (const end of [0, 1]) {
    const capBase = rings * segments + end * (1 + segments);
    for (let r = 0; r < segments; r++) {
      const next = (r + 1) % segments;
      const rim = capBase + 1 + r, rimNext = capBase + 1 + next;
      if (end === 0) { indices[at++] = capBase; indices[at++] = rimNext; indices[at++] = rim; }
      else { indices[at++] = capBase; indices[at++] = rim; indices[at++] = rimNext; }
    }
  }
  if (at !== indices.length) throw new Error(`index count ${at} != ${indices.length}`);
  void vertices;
  return indices;
}

/**
 * Sweep one frame into the supplied buffers.
 *
 * @param points     flat xyz of the alpha carbons, in the stage's units
 * @param ss         per-residue 'H' / 'E' / 'C'
 * @param ssConf     per-residue 0..1, how sure the assigner is
 * @param profile    proportions in the SAME units as `points` (see profileInUnits)
 * @param out        { position, normal, structure, residue } typed arrays to fill.
 *                   `residue` is the index of the residue that PAINTS each vertex, so any
 *                   per-residue quantity - the colour mode's confidence ramp, a future
 *                   hydrophobicity mode - can be looked up without the sweep knowing what
 *                   the colour means.
 */
export function buildCartoon(points, ss, ssConf, profile, out, tables) {
  const n = points.length / 3;
  const segments = profile.radialSegments;
  if (n < 2 || ss.length !== n) return false;

  // Two confidence tracks, and the difference matters. `paint` is one value per element and
  // is what the ribbon is COLOURED by; `shape` is that eased down at each element's ends and
  // is what the cross section is swept from, so a ribbon narrows into the cord over a couple
  // of residues. Tapering the colour too puts a grey wash at every ribbon end.
  const grown = Array.from(ssConf, ribbonConfidence);
  const paint = levelledConfidence(ss, grown);
  const shape = taperedConfidence(ss, paint, profile);
  void paint;   // the shape is swept from `shape`; colour is looked up by residue instead
  const guide = guidePoints(points, ss, shape, profile);

  const sampleCount = (n - 1) * profile.samplesPerResidue + 1;
  const centres = new Float64Array(sampleCount * 3);
  const parameters = new Float64Array(sampleCount);
  for (let s = 0; s < sampleCount; s++) {
    const u = s / profile.samplesPerResidue;
    parameters[s] = u;
    const p = splinePoint(guide, n, u);
    centres[3 * s] = p[0]; centres[3 * s + 1] = p[1]; centres[3 * s + 2] = p[2];
  }

  // Tangents by central difference on the sampled curve, which is stable even where the
  // analytic derivative vanishes at a cusp.
  const tangents = new Float64Array(sampleCount * 3);
  for (let s = 0; s < sampleCount; s++) {
    const a = Math.max(s - 1, 0), b = Math.min(s + 1, sampleCount - 1);
    const d = unit([centres[3 * b] - centres[3 * a],
                    centres[3 * b + 1] - centres[3 * a + 1],
                    centres[3 * b + 2] - centres[3 * a + 2]]);
    tangents[3 * s] = d[0]; tangents[3 * s + 1] = d[1]; tangents[3 * s + 2] = d[2];
  }

  /* The ribbon's flat face is oriented by the STRUCTURE, not by the curve:
   *
   *     tangent  = ca[i+1] - ca[i-1]
   *     bisector = (ca[i-1] - ca[i]) + (ca[i+1] - ca[i])
   *     side     = tangent x bisector
   *
   * The bisector points to the concave side, which for a helix is straight at its axis, so
   * `side` comes out along the axis and the ribbon's broad face turns outward: a coiled
   * band seen face-on from outside, which is what a helix should look like. */
  const sides = [];
  for (let i = 0; i < n; i++) {
    const at = k => [points[3 * k], points[3 * k + 1], points[3 * k + 2]];
    const previous = at(Math.max(i - 1, 0));
    const current = at(i);
    const following = at(Math.min(i + 1, n - 1));
    const along = sub(following, previous);
    const bisector = add(sub(previous, current), sub(following, current));
    let side = cross(along, bisector);
    if (len(side) < 1e-5) {
      // Three collinear alpha carbons leave the roll undetermined. Carry the previous
      // residue's frame rather than inventing one, which shows as a kink in a straight run.
      side = sides.length ? sides[sides.length - 1]
                          : perpendicular(len(along) > 1e-6 ? unit(along) : [0, 0, 1]);
    }
    side = unit(side);
    // Continuity: without this a strand's ribbon flips edge-over-edge at every residue,
    // which reads as shredded rather than twisted.
    if (sides.length && dot(side, sides[sides.length - 1]) < 0) side = mul(side, -1);
    sides.push(side);
  }
  // Making the sign continuous stops the flip; it does not stop the TWIST, because a strand
  // pleats side to side so the roll alternates every residue. A symmetric [1,2,1] average
  // removes the alternation and leaves a steady rotation, which is exactly the distinction
  // wanted: the pleat is noise, a helix's roll is the helix.
  for (let pass = 0; pass < profile.frameSmoothingPasses; pass++) {
    const smoothed = sides.slice();
    for (let i = 1; i < sides.length - 1; i++) {
      const sum = add(add(sides[i - 1], mul(sides[i], 2)), sides[i + 1]);
      if (len(sum) > 1e-6) smoothed[i] = unit(sum);
    }
    for (let i = 0; i < sides.length; i++) sides[i] = smoothed[i];
  }

  const arrowScale = arrowScales(ss, parameters, profile);
  const rings = ringLayout(n, profile);
  const structureCode = { [COIL]: 0, [HELIX]: 1, [SHEET]: 2 };

  let v = 0;
  for (const [s, paintResidue] of rings) {
    const tangent = [tangents[3 * s], tangents[3 * s + 1], tangents[3 * s + 2]];
    const u = parameters[s];
    const i = Math.min(Math.floor(u), n - 1);
    const j = Math.min(i + 1, n - 1);
    const f = u - i;
    let normalAxis = add(mul(sides[i], 1 - f), mul(sides[j], f));
    normalAxis = sub(normalAxis, mul(tangent, dot(normalAxis, tangent)));
    normalAxis = len(normalAxis) > 1e-6 ? unit(normalAxis) : perpendicular(tangent);
    const binormal = unit(cross(tangent, normalAxis));

    const [structure, confidence] = interpolatedStructure(ss, shape, u);
    const [halfWidth, halfThickness] =
      section(structure, confidence, profile, arrowScale[s]);

    const t = Math.min(Math.max(confidence, 0), 1);
    const level = structure === COIL ? 0
      : Math.min(Math.max(Math.round(t * (SHARPNESS_LEVELS - 1)), 0), SHARPNESS_LEVELS - 1);
    const table = tables[level];

    const cx = centres[3 * s], cy = centres[3 * s + 1], cz = centres[3 * s + 2];
    for (let r = 0; r < segments; r++) {
      const ox = table.offsets[2 * r] * halfWidth;
      const oy = table.offsets[2 * r + 1] * halfThickness;
      out.position[3 * v] = cx + normalAxis[0] * ox + binormal[0] * oy;
      out.position[3 * v + 1] = cy + normalAxis[1] * ox + binormal[1] * oy;
      out.position[3 * v + 2] = cz + normalAxis[2] * ox + binormal[2] * oy;

      const wx = table.normals[2 * r] / Math.max(halfWidth, 1e-4);
      const wy = table.normals[2 * r + 1] / Math.max(halfThickness, 1e-4);
      const raw = [normalAxis[0] * wx + binormal[0] * wy,
                   normalAxis[1] * wx + binormal[1] * wy,
                   normalAxis[2] * wx + binormal[2] * wy];
      const nu = len(raw) > 1e-6 ? unit(raw) : normalAxis;
      out.normal[3 * v] = nu[0]; out.normal[3 * v + 1] = nu[1]; out.normal[3 * v + 2] = nu[2];

      out.structure[v] = structureCode[ss[paintResidue]] ?? 0;
      out.residue[v] = paintResidue;
      v++;
    }
  }

  // End caps: a triangle fan across the first and last ring. Without them the tube is open
  // at both termini and you see straight through it, because the far wall's inside is
  // back-facing and culled. The rim is duplicated rather than shared, because a cap is flat:
  // its normal is the outward tangent, and sharing would smear the shading around the rim.
  for (const end of [0, 1]) {
    const sample = end === 0 ? 0 : sampleCount - 1;
    const ringBase = (end === 0 ? 0 : rings.length - 1) * segments;
    const sign = end === 0 ? -1 : 1;
    const outward = [tangents[3 * sample] * sign, tangents[3 * sample + 1] * sign,
                     tangents[3 * sample + 2] * sign];
    out.position[3 * v] = centres[3 * sample];
    out.position[3 * v + 1] = centres[3 * sample + 1];
    out.position[3 * v + 2] = centres[3 * sample + 2];
    out.normal[3 * v] = outward[0];
    out.normal[3 * v + 1] = outward[1];
    out.normal[3 * v + 2] = outward[2];
    out.structure[v] = out.structure[ringBase];
    out.residue[v] = out.residue[ringBase];
    v++;
    for (let r = 0; r < segments; r++) {
      out.position[3 * v] = out.position[3 * (ringBase + r)];
      out.position[3 * v + 1] = out.position[3 * (ringBase + r) + 1];
      out.position[3 * v + 2] = out.position[3 * (ringBase + r) + 2];
      out.normal[3 * v] = outward[0];
      out.normal[3 * v + 1] = outward[1];
      out.normal[3 * v + 2] = outward[2];
      out.structure[v] = out.structure[ringBase + r];
      out.residue[v] = out.residue[ringBase + r];
      v++;
    }
  }
  return v;
}

/** The sixteen cross sections, built once. A section flattens and squares off together, so
 *  the aspect ratio used to place the vertices travels with the sharpness: round at level 0,
 *  the ribbon's own ratio at the top. */
export function buildTables(profile) {
  const ribbonAspect = profile.helixHalfWidth / Math.max(profile.helixHalfThickness, 1e-4);
  return Array.from({ length: SHARPNESS_LEVELS }, (_, level) => {
    const t = level / (SHARPNESS_LEVELS - 1);
    return sectionTable(profile.radialSegments,
                        2 + (profile.ribbonSharpness - 2) * t,
                        1 + (ribbonAspect - 1) * t);
  });
}
