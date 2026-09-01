/* The in-between poses: are they a chain, and do they still meet the frames at each end?
 *
 * Run over the committed gallery rather than over invented input, because the thing this
 * has to survive is the real gap between two frames of a real trajectory - up to 30 A of
 * alpha carbon movement, which is what makes a plain lerp tear the chain apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { morphFrames, newMorphScratch, bondLengths, relaxBonds, RELAX_PASSES }
  from '../static/js/morph.js';
import { runLengthDecode } from '../static/js/PSEA.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const gallery = JSON.parse(
  readFileSync(join(REPO, 'static/baked/gallery.json'), 'utf8'));

const decode = (frame) => ({
  points: Float32Array.from(frame.points),
  ss: runLengthDecode(frame.ss),
  confidence: frame.conf?.length ? Float32Array.from(frame.conf, c => c / 100) : null,
  ssConfidence: frame.ssConf?.length ? Float32Array.from(frame.ssConf, c => c / 100) : null,
});

function lengths(points, n) {
  return Array.from(bondLengths(points, n, new Float64Array(n - 1)));
}

test('every in-between pose is still a chain', () => {
  let worst = 0, worstWhere = '';
  for (const fold of gallery.folds) {
    const n = fold.residueCount;
    const scratch = newMorphScratch(n);
    for (let f = 0; f + 1 < fold.frames.length; f++) {
      const a = decode(fold.frames[f]), b = decode(fold.frames[f + 1]);
      const la = lengths(a.points, n), lb = lengths(b.points, n);
      for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const pose = morphFrames(a, b, t, scratch);
        const lm = lengths(pose.points, n);
        for (let i = 0; i < n - 1; i++) {
          const target = la[i] + (lb[i] - la[i]) * t;
          const error = Math.abs(lm[i] - target) / target;
          if (error > worst) { worst = error; worstWhere = `${fold.id} ${f}->${f + 1} t=${t}`; }
        }
      }
    }
  }
  // A plain lerp leaves the worst bond 97% short, measured. The bar is set an order of
  // magnitude below what anyone could see rather than at the measured 0.7%, so the passes
  // can be tuned without rewriting the test - but not silently removed.
  assert.ok(worst < 0.05,
            `worst bond is ${(100 * worst).toFixed(1)}% off its target at ${worstWhere}`);
});

test('a morph meets the real frames at both ends', () => {
  const fold = gallery.folds[0];
  const n = fold.residueCount;
  const scratch = newMorphScratch(n);
  const a = decode(fold.frames[40]), b = decode(fold.frames[41]);
  for (const [t, near] of [[0.001, a], [0.999, b]]) {
    const pose = morphFrames(a, b, t, scratch);
    let drift = 0;
    for (let i = 0; i < pose.points.length; i++) {
      drift = Math.max(drift, Math.abs(pose.points[i] - near.points[i]));
    }
    // In quantised units, where the box is +/-1000: a thousandth of the way in must look
    // like the frame it started from, or playback would flick at every frame boundary.
    assert.ok(drift < 6, `t=${t} is ${drift.toFixed(1)} units from the frame it should match`);
  }
});

test('a residue that changes structure narrows to a cord and grows back', () => {
  // The cartoon sweeps its cross section from ssConfidence, so a letter that changes has to
  // pass through zero: otherwise a helix becomes a strand in one redraw, which is the pop
  // this whole file exists to remove.
  const n = 4;
  const scratch = newMorphScratch(n);
  const straight = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0]);
  const a = { points: straight, ss: 'HHCC', confidence: null,
              ssConfidence: new Float32Array([0.9, 0.9, 0.2, 0.2]) };
  const b = { points: straight, ss: 'EECC', confidence: null,
              ssConfidence: new Float32Array([0.8, 0.8, 0.2, 0.2]) };
  const midpoint = morphFrames(a, b, 0.5, scratch);
  assert.equal(midpoint.ssConfidence[0], 0, 'the changing residue did not reach zero width');
  assert.ok(midpoint.ssConfidence[2] > 0.15, 'an unchanged residue was narrowed too');

  const early = morphFrames(a, b, 0.25, scratch);
  assert.equal(early.ss[0], 'H', 'the letter switched before the halfway point');
  assert.ok(early.ssConfidence[0] > 0 && early.ssConfidence[0] < 0.9,
            'the ribbon did not narrow on the way in');
  const late = morphFrames(a, b, 0.75, scratch);
  assert.equal(late.ss[0], 'E', 'the letter did not switch after the halfway point');
});

test('the bond projection leaves a chain it is already happy with alone', () => {
  const n = 5;
  const points = new Float32Array([0, 0, 0, 3, 0, 0, 6, 0, 0, 9, 0, 0, 12, 0, 0]);
  const before = Array.from(points);
  relaxBonds(points, new Float64Array([3, 3, 3, 3]), n, RELAX_PASSES);
  for (let i = 0; i < points.length; i++) {
    assert.ok(Math.abs(points[i] - before[i]) < 1e-4, `atom ${i} moved for no reason`);
  }
});

test('the projection separates two residues sitting on top of each other', () => {
  // What a lerp produces when two frames cross: the direction to push them apart in is
  // whatever the floating point noise says, and any direction beats a division by zero.
  const n = 3;
  const points = new Float32Array([0, 0, 0, 0, 0, 0, 6, 0, 0]);
  relaxBonds(points, new Float64Array([3, 3]), n, RELAX_PASSES);
  const d = Math.hypot(points[3] - points[0], points[4] - points[1], points[5] - points[2]);
  assert.ok(Number.isFinite(d), 'the projection produced NaN');
  assert.ok(Math.abs(d - 3) < 0.05, `the coincident pair ended up ${d.toFixed(2)} apart`);
});
