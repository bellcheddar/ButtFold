/* The JS geometry ports against the Python reference, not against themselves.
 *
 * PLAN.md section 10, item 3. `PSEA.js` and `ContactTracker.js` were both written from the
 * same Swift as `tools/psea.py` and `tools/contacts.py`, so testing one against the other
 * would only prove they were written by the same hand on the same day. What these assert is
 * agreement with a committed reference output, produced by the Python that the baker
 * actually runs. If the baked path and the live path ever disagree about where a helix is
 * or when a contact formed, the same fold would sound different depending on which path
 * played it, and that is exactly the class of bug this catches.
 *
 * Regenerate the fixtures with:
 *   tools/psea.py --fixtures
 *   tools/contacts.py --fixtures
 *
 *   node --test tests/geometry_parity.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { assign, runLengthEncode, runLengthDecode, Hysteresis } from '../static/js/PSEA.js';
import { ContactTracker } from '../static/js/ContactTracker.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PSEA_DIR = join(REPO, 'tests/fixtures/psea');
const CONTACTS_DIR = join(REPO, 'tests/fixtures/contacts');

const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));

test('PSEA.js reproduces tools/psea.py exactly', () => {
  assert.ok(existsSync(join(PSEA_DIR, 'index.json')),
            'missing fixtures - run tools/psea.py --fixtures');
  const { cases } = readJSON(join(PSEA_DIR, 'index.json'));
  assert.ok(cases.length >= 5, 'expected at least five P-SEA cases');

  let sawHelix = false, sawSheet = false, sawAllCoil = false;
  for (const entry of cases) {
    const fixture = readJSON(join(PSEA_DIR, entry.file));
    const flat = Float64Array.from(fixture.ca.flat());
    const { ss, confidence } = assign(flat);

    assert.equal(ss.length, fixture.residueCount, `${entry.name}: length`);
    assert.equal(ss, fixture.ss, `${entry.name}: assignment`);
    assert.equal(runLengthEncode(ss), fixture.ssRunLength, `${entry.name}: run-length`);
    assert.equal(runLengthDecode(runLengthEncode(ss)), ss, `${entry.name}: round trip`);
    for (let i = 0; i < confidence.length; i++) {
      // 1e-6, because the fixture stores confidence rounded to six decimal places. The
      // assignment itself is compared for exact equality above and that is the bar that
      // matters: confidence only drives how strongly the renderer morphs.
      assert.ok(Math.abs(confidence[i] - fixture.confidence[i]) < 1e-6,
                `${entry.name}: confidence at ${i}: ${confidence[i]} vs ${fixture.confidence[i]}`);
    }
    if (ss.includes('H')) sawHelix = true;
    if (ss.includes('E')) sawSheet = true;
    if (fixture.residueCount > 5 && !ss.includes('H') && !ss.includes('E')) sawAllCoil = true;
  }

  // A port that returned a constant would pass every equality above if the fixtures all
  // happened to agree with that constant. These three assert the fixtures do not.
  assert.ok(sawHelix, 'no fixture contained a helix, so the helix branch was never exercised');
  assert.ok(sawSheet, 'no fixture contained a sheet, so the sheet branch was never exercised');
  assert.ok(sawAllCoil, 'no fixture was an unassigned coil, so "assigns nothing" is untested');
});

test('the P-SEA hysteresis holds a state for three frames before it changes', () => {
  const smoother = new Hysteresis(4, 3);
  const conf = n => new Array(4).fill(n);
  assert.equal(smoother.smooth('CCCC', conf(0)).ss, 'CCCC');
  // One frame of helix is a flicker and must not take.
  assert.equal(smoother.smooth('HHHH', conf(0.9)).ss, 'CCCC');
  assert.equal(smoother.smooth('HHHH', conf(0.9)).ss, 'CCCC');
  // Three consecutive frames of the same new state, so it takes.
  const taken = smoother.smooth('HHHH', conf(0.9));
  assert.equal(taken.ss, 'HHHH');
  assert.deepEqual(taken.confidence, conf(0.9));
  // And a single frame back to coil does not undo it - nor may it take the coil frame's
  // certainty, which is a score for a structure this residue is not being drawn as.
  const held = smoother.smooth('CCCC', conf(0));
  assert.equal(held.ss, 'HHHH');
  assert.deepEqual(held.confidence, conf(0.9),
                   'a held residue borrowed the incoming frame\'s certainty');
});

test('ContactTracker.js reproduces tools/contacts.py exactly', () => {
  assert.ok(existsSync(join(CONTACTS_DIR, 'index.json')),
            'missing fixtures - run tools/contacts.py --fixtures');
  const { cases } = readJSON(join(CONTACTS_DIR, 'index.json'));
  assert.ok(cases.length >= 2, 'expected at least two contact cases');

  for (const entry of cases) {
    const fixture = readJSON(join(CONTACTS_DIR, entry.file));
    const tracker = new ContactTracker();
    let total = 0;
    fixture.frames.forEach((frame, index) => {
      const formed = tracker.update(Float64Array.from(frame.positions));
      assert.deepEqual(formed, frame.formed,
                       `${entry.id} frame ${index}: contacts formed`);
      assert.equal(tracker.activeContactCount, frame.activeAfter,
                   `${entry.id} frame ${index}: contacts held`);
      total += formed.length;
    });
    assert.equal(total, entry.contactsFormed, `${entry.id}: total contacts`);
    // A tracker with the hysteresis removed fires far more often; a tracker that never
    // resets its state fires once and stops. Both would fail the per-frame checks above,
    // but this makes the failure legible.
    assert.ok(total > 0, `${entry.id}: no contact formed at all`);
  }
});

test('the contact hysteresis does not fire between the two cutoffs', () => {
  // One pair, residues 0 and 5, walked across both cutoffs. Every other residue is parked
  // a thousand angstroms away so that exactly one pair is ever eligible: the first version
  // of this test laid the chain out at a realistic 3.8 A spacing and accidentally put
  // residues 1 and 2 inside the cutoff of residue 5, which fired contacts nobody asked
  // about. The tracker only ever looks at distances and |i-j|, so a physically absurd
  // arrangement is the right way to isolate one transition.
  const n = 8;
  const frame = (separation) => {
    const p = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) p[3 * i + 1] = 1000 * i;   // far apart, along y
    p[3 * 0] = 0; p[3 * 0 + 1] = 0;
    p[3 * 5] = separation; p[3 * 5 + 1] = 0;               // d(0,5) = separation
    return p;
  };
  const tracker = new ContactTracker();
  assert.deepEqual(tracker.update(frame(9.0)), [], 'formed above the 8.0 cutoff');
  assert.deepEqual(tracker.update(frame(8.2)), [], 'formed between 8.0 and 8.5');
  assert.deepEqual(tracker.update(frame(7.9)), [[0, 5]], 'did not form below 8.0');
  assert.deepEqual(tracker.update(frame(8.2)), [], 'refired inside the hysteresis gap');
  assert.equal(tracker.activeContactCount, 1, 'broke at 8.2, below the 8.5 break cutoff');
  assert.deepEqual(tracker.update(frame(8.6)), [], 'unexpected event on breaking');
  assert.equal(tracker.activeContactCount, 0, 'did not break above 8.5');
  assert.deepEqual(tracker.update(frame(7.9)), [[0, 5]], 'did not re-form after breaking');
});
