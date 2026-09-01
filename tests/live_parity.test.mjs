/* Do the live path and the baked path build the same frame from the same trajectory?
 *
 * A Phase 3 exit criterion. The gallery is baked in Python and the live fold builds its
 * frames in JavaScript, in a worker, from a WASM module. Three implementations of "a
 * trajectory" could easily agree on the physics and disagree on the packaging - a different
 * rounding, a contact tracker started one frame late, secondary structure smoothed with a
 * different window - and the result would be one protein that looks and sounds like two
 * different things depending on which button was pressed.
 *
 * The comparison is exact. `static/js/frames.js` is run over the SAME Angstrom coordinates
 * the baker used, with the same scale the baker recorded, and every field of every frame is
 * compared byte for byte against the committed artefact.
 *
 * The input is `tests/fixtures/frames/*.json`: the exact float32 Angstrom coordinates the
 * baker built from, written by `tools/bake_gallery.py --frame-fixtures`. The obvious
 * alternative - multiplying the committed quantised integers back by the recorded scale -
 * is lossy by half a unit, about 0.008 A on trp-cage. That is far below anything a viewer
 * sees and it is NOT below the 8.0 A contact cutoff: measured, a pair 0.008 A from the
 * threshold flipped and the test reported a difference between two implementations that
 * agree (trp-cage frame 16, contact 4-10). A parity test whose own input is lossy at the
 * scale of the thing it compares is worse than no test.
 *
 *   node --test tests/live_parity.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildFrame, newTrajectoryState, LiveScale, centre, maxAbs, radiusOfGyration }
  from '../static/js/frames.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const gallery = JSON.parse(readFileSync(join(REPO, 'static/baked/gallery.json'), 'utf8'));
const FRAMES = join(REPO, 'tests/fixtures/frames');

/** The exact float32 Angstroms the baker used, out of the base64 fixture. */
function exactFrames(id) {
  const fixture = JSON.parse(readFileSync(join(FRAMES, `${id}.json`), 'utf8'));
  return fixture.frames.map(encoded => {
    const bytes = Buffer.from(encoded, 'base64');
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    return Float64Array.from(floats);
  });
}

/** The baked frame, back in Angstroms. Lossy, and only used where that does not matter. */
function angstroms(frame, angstromsPerUnit) {
  const out = new Float64Array(frame.points.length);
  for (let i = 0; i < frame.points.length; i++) out[i] = frame.points[i] * angstromsPerUnit;
  return out;
}

test('frames.js rebuilds every baked frame exactly', () => {
  const { cases } = JSON.parse(readFileSync(join(FRAMES, 'index.json'), 'utf8'));
  assert.ok(cases.length >= 2, 'run tools/bake_gallery.py --frame-fixtures');
  let framesChecked = 0, foldsChecked = 0;
  for (const entry of cases) {
    const fold = gallery.folds.find(f => f.id === entry.id);
    assert.ok(fold, `${entry.id} is not in the baked gallery`);
    const coordinates = exactFrames(entry.id);
    assert.equal(coordinates.length, fold.frames.length, `${entry.id}: frame count`);
    const scale = 1 / fold.angstromsPerUnit;
    const state = newTrajectoryState(fold.residueCount);
    fold.frames.forEach((baked, index) => {
      const ca = coordinates[index];
      const built = buildFrame(ca, scale, state.tracker, state.smoother, baked.conf);
      const where = `${fold.id} frame ${index}`;

      // Coordinates, exactly. A rounding difference here is a structure drawn in a
      // slightly different place, which is invisible and wrong.
      assert.equal(built.points.length, baked.points.length, `${where}: point count`);
      for (let i = 0; i < built.points.length; i++) {
        assert.equal(built.points[i], baked.points[i], `${where}: point ${i}`);
      }
      // The note onsets. A tracker started a frame late, or without the hysteresis, would
      // still produce a plausible-looking stream of contacts.
      assert.deepEqual(built.newContacts, baked.newContacts, `${where}: contacts`);
      // The ribbon's colour and the sonifier's texture voices.
      assert.equal(built.ss, baked.ss, `${where}: secondary structure`);
      assert.deepEqual(built.conf, baked.conf, `${where}: confidence`);
      assert.deepEqual(built.ssConf, baked.ssConf, `${where}: secondary-structure certainty`);
      assert.equal(built.rg, baked.rg, `${where}: radius of gyration`);
      framesChecked++;
    });
    foldsChecked++;
  }
  assert.equal(foldsChecked, cases.length);
  assert.ok(framesChecked >= 300, `only ${framesChecked} frames compared`);
});

test('the recorded ruler really is the scale the baker used', () => {
  for (const fold of gallery.folds) {
    // Exactly one frame reaches the edge of the box, and that frame's extent in Angstroms
    // times the scale must be the box. If angstromsPerUnit were stale or wrong, every
    // check above would still pass on its own terms and every real length would be wrong.
    const extents = fold.frames.map(f => maxAbs(f.points));
    const widest = Math.max(...extents);
    assert.equal(widest, gallery.quantisedRange, `${fold.id}: no frame reaches the box edge`);

    const widestFrame = fold.frames[extents.indexOf(widest)];
    const ca = angstroms(widestFrame, fold.angstromsPerUnit);
    const half = maxAbs(centre(ca));
    assert.ok(Math.abs(half * (1 / fold.angstromsPerUnit) - gallery.quantisedRange) < 2,
              `${fold.id}: the recorded scale does not reproduce the box`);

    // And the recorded Rg must be the Rg of those Angstrom coordinates.
    const rg = radiusOfGyration(ca);
    assert.ok(Math.abs(rg * 10 - widestFrame.rg) < 1.0,
              `${fold.id}: recorded Rg ${widestFrame.rg / 10} vs measured ${rg.toFixed(2)}`);
  }
});

test('the live scale grows and never shrinks', () => {
  // Seeded from the first frame, it must accommodate every later frame of every launch
  // fold without ever moving backwards. The measured widest-frame ratios run 1.05 to 1.39,
  // so the 1.45 headroom should mean it never grows at all.
  for (const fold of gallery.folds) {
    const first = angstroms(fold.frames[0], fold.angstromsPerUnit);
    const scale = new LiveScale(maxAbs(centre(first)));
    let previous = Infinity;
    for (const frame of fold.frames) {
      const ca = angstroms(frame, fold.angstromsPerUnit);
      const units = scale.accommodate(maxAbs(centre(ca)));
      assert.ok(units <= previous + 1e-9,
                `${fold.id}: the scale grew the structure, which reads as a jump`);
      previous = units;
    }
    assert.equal(scale.grewTimes, 0,
                 `${fold.id}: the 1.45 headroom was not enough (grew ${scale.grewTimes} times, `
                 + `widest frame ratio ${fold.widestFrameRatio})`);
    // Every frame must fit the box under that scale, or the structure clips at the edges.
    const units = scale.accommodate(0);
    for (const frame of fold.frames) {
      const ca = angstroms(frame, fold.angstromsPerUnit);
      assert.ok(maxAbs(centre(ca)) * units <= 1000 + 1,
                `${fold.id}: a frame does not fit the live box`);
    }
  }
});

test('the widest frame is not the first one, so a live scale really is a guess', () => {
  // If the coil were always the widest frame this whole mechanism would be unnecessary,
  // and a future change that made it so should retire LiveScale rather than leave it.
  const ratios = gallery.folds.map(f => f.widestFrameRatio);
  assert.ok(Math.max(...ratios) > 1.1,
            'every trajectory is widest on its first frame; LiveScale is unnecessary');
  assert.ok(Math.min(...ratios) >= 1.0, 'a trajectory is wider than its own widest frame');
});
