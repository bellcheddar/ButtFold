/* The cartoon geometry: is it a cartoon, or is it a hose?
 *
 * These check the properties that make the difference, on real coordinates from the baked
 * gallery. Each one corresponds to something that was visibly wrong in the round-tube
 * renderer this replaced.
 *
 *   node --test tests/cartoon.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PROFILE, profileInUnits, buildCartoon, buildTables, buildIndices, meshSize, ringLayout,
  section, arrowScales, splinePoint, arcPoint, levelledConfidence, taperedConfidence,
  guidePoints, sectionTable, HELIX, SHEET, COIL,
} from '../static/js/cartoon.js';
import { runLengthDecode } from '../static/js/PSEA.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const gallery = JSON.parse(readFileSync(join(REPO, 'static/baked/gallery.json'), 'utf8'));

function foldNamed(id) {
  const fold = gallery.folds.find(f => f.id === id);
  assert.ok(fold, `no baked fold ${id}`);
  return fold;
}

/** Sweep one baked frame and hand back the buffers. */
function sweep(fold, frameIndex) {
  const frame = fold.frames[frameIndex];
  const n = fold.residueCount;
  const profile = profileInUnits(fold.angstromsPerUnit);
  const tables = buildTables(profile);
  const size = meshSize(n, profile);
  const out = {
    position: new Float32Array(size.vertices * 3),
    normal: new Float32Array(size.vertices * 3),
    structure: new Uint8Array(size.vertices),
    residue: new Uint16Array(size.vertices),
  };
  const ss = runLengthDecode(frame.ss);
  const ssConf = Float32Array.from(frame.ssConf, c => c / 100);
  const written = buildCartoon(Float64Array.from(frame.points), ss, ssConf, profile, out, tables);
  return { out, written, size, profile, ss, ssConf, frame, n };
}

test('the mesh is well formed: no NaN, no degenerate normal, every index in range', () => {
  // A NaN vertex does not crash. It silently removes triangles from the render, which looks
  // like a hole in the protein, so this is the predicate rather than a smoke test.
  for (const fold of gallery.folds) {
    for (const frameIndex of [0, Math.floor(fold.frames.length / 2), fold.frames.length - 1]) {
      const { out, written, size, n, profile } = sweep(fold, frameIndex);
      const where = `${fold.id} frame ${frameIndex}`;
      assert.equal(written, size.vertices, `${where}: vertices written`);

      for (let v = 0; v < size.vertices; v++) {
        for (let k = 0; k < 3; k++) {
          assert.ok(Number.isFinite(out.position[3 * v + k]), `${where}: position ${v} is NaN`);
          assert.ok(Number.isFinite(out.normal[3 * v + k]), `${where}: normal ${v} is NaN`);
        }
        const length = Math.hypot(out.normal[3 * v], out.normal[3 * v + 1],
                                  out.normal[3 * v + 2]);
        // A degenerate normal shades as a black facet.
        assert.ok(length > 0.5, `${where}: normal ${v} has length ${length.toFixed(3)}`);
        assert.ok(out.residue[v] < n, `${where}: residue index ${out.residue[v]} out of range`);
      }

      const indices = buildIndices(n, profile);
      for (const index of indices) {
        assert.ok(index < size.vertices, `${where}: index ${index} out of range`);
      }
    }
  }
});

test('the vertex count never changes across a trajectory', () => {
  // The buffers are allocated once. If the layout depended on a frame's assignments they
  // would have to be reallocated on most frames of a fold, and the geometry would be rebuilt
  // from scratch sixty times a second.
  const fold = foldNamed('ubiquitin');
  const profile = profileInUnits(fold.angstromsPerUnit);
  const expected = meshSize(fold.residueCount, profile).vertices;
  const seen = new Set();
  for (let i = 0; i < fold.frames.length; i += 17) {
    seen.add(sweep(fold, i).written);
  }
  assert.deepEqual([...seen], [expected],
                   'the vertex count moved with the secondary structure');
});

test('helix and sheet are FLAT ribbons and coil is a round cord', () => {
  // The whole point. A round section swept along a helix reads as a coiled coil, which means
  // something else entirely in this field.
  const p = PROFILE;
  const [helixW, helixT] = section(HELIX, 1, p);
  const [sheetW, sheetT] = section(SHEET, 1, p);
  const [coilW, coilT] = section(COIL, 1, p);

  assert.ok(helixW / helixT > 4, `the helix section is only ${(helixW / helixT).toFixed(1)}:1`);
  assert.ok(sheetW / sheetT > 4, `the strand section is only ${(sheetW / sheetT).toFixed(1)}:1`);
  assert.equal(coilW, coilT, 'the coil cord is not round');
  assert.ok(coilW < helixT, 'the coil cord is not thinner than the ribbons');
  // And both ribbons are wider than the cord by a lot, or they read as a slightly squashed
  // tube rather than as a ribbon.
  assert.ok(helixW / coilW > 5 && sheetW / coilW > 5);
});

test('a strand ends in an arrowhead that widens then comes to a point', () => {
  // The arrow is what tells a reader which way a strand runs, and PLAN asks for it
  // explicitly. It is a multiplier on the strand's width, so outside a strand it is 1.
  const ss = 'CCCEEEEEECCC'.split('');
  const profile = PROFILE;
  const parameters = [];
  for (let s = 0; s <= (ss.length - 1) * 10; s++) parameters.push(s / 10);
  const scales = arrowScales(ss, parameters, profile);

  const widthAt = u => scales[Math.round(u * 10)] * profile.sheetHalfWidth;
  // The strand runs residues 3 to 8, so a 1.6-residue head starts at 6.4 and points at 8.5.
  // The head is WIDEST at its base and narrows from there: measured 1.40 through the body,
  // 1.78 at 6.6, 1.10 at 7.4, 0.42 at 8.2.
  const body = widthAt(4.0);      // inside the strand, before the head
  const base = widthAt(6.6);      // just inside the head, near its base
  const tip = widthAt(8.2);       // close to its point

  assert.ok(Math.abs(body - profile.sheetHalfWidth) < 1e-6,
            `the strand body is ${body.toFixed(2)}, not the strand width`);
  assert.ok(base > profile.sheetHalfWidth * 1.15,
            `the arrowhead does not widen (base ${base.toFixed(2)} vs body ${body.toFixed(2)})`);
  assert.ok(tip < profile.sheetHalfWidth * 0.4,
            `the arrowhead does not come to a point (tip ${tip.toFixed(2)})`);
  assert.ok(tip > 0, 'the tip is a true point, which degenerates the ring into a line');

  // Outside the strand the scale is exactly 1, so the section decides. An absolute width
  // here reached back across coil residues and widened them.
  assert.equal(scales[Math.round(1.0 * 10)], 1, 'the arrow widened a coil residue');
  assert.equal(scales[Math.round(11.0 * 10)], 1, 'the arrow persisted past the strand');
});

test('the spline draws a helix at its true radius, where Catmull-Rom cuts 17% off it', () => {
  // An ideal alpha helix: 3.6 residues per turn, radius 2.3 A, rise 1.5 A per residue.
  const radius = 2.3, rise = 1.5, perTurn = 3.6, n = 20;
  const ca = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const angle = 2 * Math.PI * i / perTurn;
    ca[3 * i] = radius * Math.cos(angle);
    ca[3 * i + 1] = radius * Math.sin(angle);
    ca[3 * i + 2] = rise * i;
  }
  // Catmull-Rom, for the comparison that is the actual claim.
  const catmull = (u) => {
    const i = Math.min(Math.floor(u), n - 2), t = u - i;
    const P = k => [ca[3 * k], ca[3 * k + 1], ca[3 * k + 2]];
    const [p0, p1, p2, p3] = [P(Math.max(i - 1, 0)), P(i), P(i + 1), P(Math.min(i + 2, n - 1))];
    return [0, 1, 2].map(k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t
      + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t
      + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t));
  };

  // Sample between two alpha carbons, where a cutting spline is furthest inside the curve.
  let arc = 0, cut = 0;
  for (let u = 6; u <= 12; u += 0.02) {
    const a = splinePoint(ca, n, u);
    const c = catmull(u);
    arc = Math.max(arc, Math.abs(Math.hypot(a[0], a[1]) - radius) / radius);
    cut = Math.max(cut, Math.abs(Math.hypot(c[0], c[1]) - radius) / radius);
  }
  // Measured: 4.6% for the arc blend against 16.9% for Catmull-Rom, and 16.9% is exactly
  // the figure PhoneFold's own source records for why its helices came out as rounded
  // triangles. A helix is not a circle, so the arc blend is not exact on one either; what
  // matters is that it is nearly four times closer.
  assert.ok(cut > 0.15, `Catmull-Rom only cuts ${(cut * 100).toFixed(1)}%; the case is wrong`);
  assert.ok(arc < 0.06, `the arc spline departs by ${(arc * 100).toFixed(1)}%`);
  assert.ok(arc < cut / 3,
            `the arc spline (${(arc * 100).toFixed(1)}%) is not much better than ` +
            `Catmull-Rom (${(cut * 100).toFixed(1)}%)`);

  // And the same construction on three collinear points is a straight line, not a wobble
  // around an enormous unstable circle. Strands are where that bit.
  const straight = arcPoint([0, 0, 0], [3.8, 0, 0], [7.6, 0, 0], 0.5);
  assert.ok(Math.abs(straight[0] - 5.7) < 1e-9 && Math.abs(straight[1]) < 1e-9,
            `a straight run bent: ${straight.map(v => v.toFixed(4))}`);
});

test('a strand lies flat: the guide smoothing takes out the pleat and keeps the curve', () => {
  // A strand may curve; it may not zigzag, and those are separable. Measured on protein G's
  // sheet in PhoneFold: 1.74 A of zigzag untouched, 0.17 A after three full passes.
  const n = 12;
  const raw = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    raw[3 * i] = i * 3.3;
    raw[3 * i + 1] = (i % 2 ? 1 : -1) * 0.9;   // the pleat
    raw[3 * i + 2] = 0.02 * i * i;             // a gentle real curve
  }
  const ss = Array(n).fill(SHEET);
  const confidence = new Float64Array(n).fill(1);
  const smoothed = guidePoints(raw, ss, confidence, PROFILE);

  const zigzag = (points) => {
    let worst = 0;
    for (let i = 1; i < n - 1; i++) {
      // How far this point sits off the midpoint of its neighbours, across the chain.
      const mid = (points[3 * (i - 1) + 1] + points[3 * (i + 1) + 1]) / 2;
      worst = Math.max(worst, Math.abs(points[3 * i + 1] - mid));
    }
    return worst;
  };
  const before = zigzag(raw), after = zigzag(smoothed);
  assert.ok(before > 1.5, 'the test case has no pleat to remove');
  assert.ok(after < before / 5,
            `the pleat survived: ${before.toFixed(2)} A -> ${after.toFixed(2)} A`);

  // The real curvature must survive. Straightening the sheet would be deleting structure.
  const span = points => points[3 * (n - 1) + 2] - points[2];
  assert.ok(span(smoothed) > span(raw) * 0.6,
            'the smoothing flattened the strand as well as the pleat');

  // And a HELIX must be untouched: one [1,2,1] pass multiplies its radius by 0.41.
  const helix = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    helix[3 * i] = 2.3 * Math.cos(2 * Math.PI * i / 3.6);
    helix[3 * i + 1] = 2.3 * Math.sin(2 * Math.PI * i / 3.6);
    helix[3 * i + 2] = 1.5 * i;
  }
  const untouched = guidePoints(helix, Array(n).fill(HELIX), confidence, PROFILE);
  for (let k = 0; k < helix.length; k++) {
    assert.equal(untouched[k], helix[k], 'the smoothing shrank a helix');
  }
});

test('a ribbon has one width and tapers only at its ends', () => {
  // Per-residue confidence made the half-width swing 1.46-fold along a single strand, which
  // on screen is a ribbon pinching in and out like a squeezed tube.
  const ss = [...'CCEEEEEEEECC'];
  const wobbly = [0, 0, 0.72, 0.92, 1.0, 0.95, 0.83, 0.9, 1.0, 0.88, 0, 0];
  const levelled = levelledConfidence(ss, wobbly);
  const inside = levelled.slice(2, 10);
  assert.equal(new Set(inside.map(v => v.toFixed(9))).size, 1,
               'the strand does not have a single confidence');

  const tapered = taperedConfidence(ss, levelled, PROFILE);
  // Ends lower than the middle, middle unchanged.
  assert.ok(tapered[2] < tapered[5], 'the ribbon does not taper at its start');
  assert.ok(tapered[9] < tapered[5], 'the ribbon does not taper at its end');
  assert.ok(Math.abs(tapered[5] - levelled[5]) < 1e-9, 'the taper reached the middle');
  // And the taper is capped, so a short element keeps a body.
  const shortSs = [...'CEEEC'];
  const shortTapered = taperedConfidence(shortSs, [0, 1, 1, 1, 0], PROFILE);
  assert.ok(shortTapered[2] > 0.5, 'a three-residue strand tapered away to nothing');
});

test('the cross section squares off, and its vertices are spread along the section', () => {
  // Uniform angle on a flattened superellipse puts fourteen of twenty samples on the two
  // thin edges, leaving the broad faces spanned by segments 9.8x longer than the shortest.
  // Shading interpolated across spacing that uneven is what makes a ribbon look coarse.
  const aspect = PROFILE.helixHalfWidth / PROFILE.helixHalfThickness;
  const k = PROFILE.ribbonSharpness;
  const table = sectionTable(20, k, aspect);
  const spread = (points) => {
    const lengths = [];
    for (let r = 0; r < 20; r++) {
      const next = (r + 1) % 20;
      lengths.push(Math.hypot(points[2 * next] - points[2 * r],
                              points[2 * next + 1] - points[2 * r + 1]));
    }
    return Math.max(...lengths) / Math.min(...lengths);
  };
  const byArcLength = new Float64Array(40);
  const byAngle = new Float64Array(40);
  for (let r = 0; r < 20; r++) {
    byArcLength[2 * r] = table.offsets[2 * r] * aspect;
    byArcLength[2 * r + 1] = table.offsets[2 * r + 1];
    const t = 2 * Math.PI * r / 20;
    byAngle[2 * r] = Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), 2 / k) * aspect;
    byAngle[2 * r + 1] = Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), 2 / k);
  }
  // Measured: 11.3-fold by uniform angle, 4.2-fold by arc length. Shading interpolated
  // across spacing as uneven as the first is what made the sides of a ribbon look coarse.
  assert.ok(spread(byAngle) > 8, 'the uniform-angle case is not the problem it was');
  assert.ok(spread(byArcLength) < spread(byAngle) / 2,
            `arc-length spacing (${spread(byArcLength).toFixed(1)}) is no better than ` +
            `uniform angle (${spread(byAngle).toFixed(1)})`);

  // Squared off: at sharpness 6 a point at 45 degrees sits well outside the ellipse's.
  const round = sectionTable(20, 2, 1);
  const sharp = sectionTable(20, 6, 1);
  const extent = t => Math.max(...Array.from({ length: 20 },
    (_, r) => Math.abs(t.offsets[2 * r]) + Math.abs(t.offsets[2 * r + 1])));
  assert.ok(extent(sharp) > extent(round) * 1.15,
            'the sharpened section is no squarer than an ellipse');
});

test('junction rings make a colour boundary a hard edge, not a gradient', () => {
  // Without the coincident duplicate the GPU interpolates the colour across the boundary
  // sample, so every helix end wears a pale band and every strand junction a magenta one.
  const profile = PROFILE;
  const rings = ringLayout(10, profile);
  const samples = rings.map(r => r[0]);
  const duplicated = samples.filter((s, i) => i > 0 && samples[i - 1] === s);
  assert.ok(duplicated.length >= 8,
            `only ${duplicated.length} junction rings for a 10-residue chain`);
  // Coincident: the duplicate sits on the same sample, painted by the outgoing residue.
  for (let i = 1; i < rings.length; i++) {
    if (rings[i][0] === rings[i - 1][0]) {
      assert.ok(rings[i - 1][1] < rings[i][1],
                'the junction pair is not outgoing-then-incoming');
    }
  }
});

test('a real fold produces distinct helix, sheet and coil geometry', () => {
  // Ubiquitin is the beta-grasp fold and carries all three. If the sweep collapsed them to
  // one shape every check above could still pass.
  const fold = foldNamed('ubiquitin');
  const { out, ss, size } = sweep(fold, fold.frames.length - 1);
  const counts = { 0: 0, 1: 0, 2: 0 };
  for (let v = 0; v < size.vertices; v++) counts[out.structure[v]]++;
  assert.ok(counts[1] > 0, 'no helix vertices');
  assert.ok(counts[2] > 0, 'no sheet vertices');
  assert.ok(counts[0] > 0, 'no coil vertices');
  assert.ok(ss.includes('H') && ss.includes('E'), 'the test fold has no mixed structure');

  // The ribbons really are wider than the cord in the swept geometry, not just in the
  // profile: measure each ring's own extent and group by structure.
  const segments = PROFILE.radialSegments;
  const extents = { 0: [], 1: [], 2: [] };
  const ringCount = ringLayout(fold.residueCount, PROFILE).length;
  for (let ring = 0; ring < ringCount; ring++) {
    const base = ring * segments;
    let cx = 0, cy = 0, cz = 0;
    for (let r = 0; r < segments; r++) {
      cx += out.position[3 * (base + r)];
      cy += out.position[3 * (base + r) + 1];
      cz += out.position[3 * (base + r) + 2];
    }
    cx /= segments; cy /= segments; cz /= segments;
    let widest = 0;
    for (let r = 0; r < segments; r++) {
      widest = Math.max(widest, Math.hypot(out.position[3 * (base + r)] - cx,
                                           out.position[3 * (base + r) + 1] - cy,
                                           out.position[3 * (base + r) + 2] - cz));
    }
    extents[out.structure[base]].push(widest);
  }
  const median = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const coil = median(extents[0]), helix = median(extents[1]), sheet = median(extents[2]);
  // Measured on ubiquitin's final frame: coil 5.1 units, helix 34.4 of an intended 34.7,
  // sheet 33.7 of 36.0, with the arrowhead reaching 50.2. Swept straight from P-SEA's raw
  // quality score instead of through `ribbonConfidence`, the sheet median was 9.5 - a
  // quarter width, which is a cord with pretensions rather than a ribbon.
  assert.ok(helix > coil * 5, `helix rings are only ${(helix / coil).toFixed(1)}x the cord`);
  assert.ok(sheet > coil * 5, `sheet rings are only ${(sheet / coil).toFixed(1)}x the cord`);
  assert.ok(helix > PROFILE.helixHalfWidth / fold.angstromsPerUnit * 0.85,
            'the helix ribbon is not drawn at its intended width');
  assert.ok(sheet > PROFILE.sheetHalfWidth / fold.angstromsPerUnit * 0.85,
            'the strand ribbon is not drawn at its intended width');
  // And the arrowhead is genuinely wider than the strand body.
  assert.ok(Math.max(...extents[2]) > sheet * 1.3, 'no ring is as wide as an arrowhead base');
});
