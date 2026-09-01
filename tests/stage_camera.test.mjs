/* The interaction model, tested without a browser.
 *
 * `StageCamera.js` is deliberately free of three.js and of DOM events, exactly as
 * PhoneFold's `StageCamera.swift` is free of SwiftUI, so the whole of "what a drag does"
 * can be checked here rather than through a rendered canvas.
 *
 *   node --test tests/stage_camera.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { StageCamera, RESTING_ATTITUDE, fromAxisAngle, multiply, normalize }
  from '../static/js/StageCamera.js';

/** Where a point ends up after the attitude is applied. Quaternion sandwich, written out. */
function rotate(q, [x, y, z]) {
  const conj = [-q[0], -q[1], -q[2], q[3]];
  const r = multiply(multiply(q, [x, y, z, 0]), conj);
  return [r[0], r[1], r[2]];
}

test('a vertical drag never dies, however far it goes', () => {
  // THE regression. The old camera was yaw and pitch with pitch clamped to +/-1.35 rad to
  // protect a camera orbit's up vector, and PhoneFold hit the same wall: from the resting
  // tilt, about 223 points of downward drag reached the clamp, after which vertical input
  // did nothing while horizontal kept working. One ordinary trackpad drag.
  const camera = new StageCamera(3200);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    const before = camera.attitude.slice();
    camera.drag(0, 60);                      // 2,400 points of downward drag in total
    const moved = camera.attitude.some((v, k) => Math.abs(v - before[k]) > 1e-9);
    seen.push(moved);
  }
  assert.ok(seen.every(Boolean),
            `vertical drag stopped having an effect after ${seen.indexOf(false)} increments`);

  // And it really has tumbled all the way over rather than wobbling: a point that started
  // on +Y must have passed through -Y at some stage of 2,400 points of drag.
  const camera2 = new StageCamera(3200);
  let lowest = 1;
  for (let i = 0; i < 60; i++) {
    camera2.drag(0, 30);
    lowest = Math.min(lowest, rotate(camera2.attitude, [0, 1, 0])[1]);
  }
  assert.ok(lowest < -0.9, `the subject never tipped past vertical (lowest Y ${lowest})`);
});

test('the drag directions are the ones the app uses', () => {
  // Dragging RIGHT turns the front of the protein toward the right of the screen.
  const right = new StageCamera(3200);
  right.attitude = [0, 0, 0, 1];             // from square-on, so the sign is unambiguous
  right.drag(100, 0);
  const front = rotate(right.attitude, [0, 0, 1]);
  assert.ok(front[0] > 0.05,
            `dragging right did not carry the front rightwards (x ${front[0].toFixed(3)})`);

  // Dragging DOWN brings the top toward the viewer.
  const down = new StageCamera(3200);
  down.attitude = [0, 0, 0, 1];
  down.drag(0, 100);
  const top = rotate(down.attitude, [0, 1, 0]);
  assert.ok(top[2] > 0.05,
            `dragging down did not bring the top toward the viewer (z ${top[2].toFixed(3)})`);
});

test('drag right still means right when the protein is upside down', () => {
  // The increment is applied about the SCREEN axes. Composing on the other side flips the
  // horizontal direction whenever the subject is inverted, which is the kind of thing that
  // feels like a broken control rather than like a bug.
  const upright = new StageCamera(3200);
  upright.attitude = [0, 0, 0, 1];
  upright.drag(60, 0);
  const uprightFront = rotate(upright.attitude, [0, 0, 1]);

  const inverted = new StageCamera(3200);
  inverted.attitude = fromAxisAngle(Math.PI, 0, 0, 1);   // rolled 180 degrees
  inverted.drag(60, 0);
  const invertedFront = rotate(inverted.attitude, [0, 0, 1]);

  assert.ok(Math.sign(uprightFront[0]) === Math.sign(invertedFront[0]),
            'dragging right reversed direction when the protein was upside down');
});

test('the attitude stays a unit quaternion over a long interaction', () => {
  // Renormalised every increment. Drift here shows up as the structure slowly shearing,
  // which reads as a rendering bug rather than as a camera one.
  const camera = new StageCamera(3200);
  for (let i = 0; i < 5000; i++) camera.drag(7, -3);
  const length = Math.hypot(...camera.attitude);
  assert.ok(Math.abs(length - 1) < 1e-9, `the attitude drifted to length ${length}`);
});

test('the orbit stops instantly on a drag and resumes after the delay', () => {
  const camera = new StageCamera(3200);
  // Idle: it orbits, but only once the resume delay has passed.
  camera.advance(1.0);
  assert.equal(camera.isOrbiting, false, 'it started orbiting before the resume delay');
  camera.advance(10.0);
  assert.equal(camera.isOrbiting, true, 'it never resumed orbiting while idle');

  camera.drag(10, 0);
  assert.equal(camera.isOrbiting, false, 'a drag did not stop the orbit');

  // A held gesture does not resume behind the visitor's back.
  camera.endInteraction();
  camera.advance(4.0);
  assert.equal(camera.isOrbiting, false,
               'the orbit resumed four seconds after the drag; the app waits eight');
  camera.advance(5.0);
  assert.equal(camera.isOrbiting, true, 'the orbit never came back');

  // And ButtFold's first version simply never orbited again after one drag, which is the
  // failure at the other end.
  const before = camera.attitude.slice();
  camera.advance(1.0);
  assert.ok(camera.attitude.some((v, k) => Math.abs(v - before[k]) > 1e-9),
            'the resumed orbit is not actually moving anything');
});

test('a gesture whose end is never announced is closed by the timeout', () => {
  // pointerup does not always arrive: a gesture can be taken by another element or
  // cancelled by the system. Without this backstop the camera stays "interacting" for good
  // and the orbit never returns - PhoneFold's "the drag gets stuck".
  const camera = new StageCamera(3200);
  camera.drag(10, 10);
  assert.equal(camera.interacting, true);
  camera.advance(2.5);
  assert.equal(camera.interacting, false, 'an abandoned gesture was never closed');
});

test('zoom is exponential, clamped, and framed on the fitted distance', () => {
  const camera = new StageCamera(3000);
  assert.equal(camera.distance, 3000);
  // PhoneFold's own ratios: 0.8 and 6.0 against a default of 1.5.
  assert.ok(Math.abs(camera.minimumDistance - 3000 * 0.8 / 1.5) < 1e-9);
  assert.ok(Math.abs(camera.maximumDistance - 3000 * 6.0 / 1.5) < 1e-9);

  camera.zoom(0.1);
  const once = camera.distance;
  assert.ok(once < 3000, 'a positive step did not zoom in');
  camera.zoom(-0.1);
  assert.ok(Math.abs(camera.distance - 3000) < 1e-6, 'zoom is not reversible');

  // A step is the same PROPORTION wherever the camera is.
  camera.zoom(0.2);
  const a = camera.distance;
  camera.zoom(0.2);
  const b = camera.distance;
  camera.zoom(0.2);
  const c = camera.distance;
  assert.ok(Math.abs((a / b) - (b / c)) < 1e-9, 'zoom steps are not proportional');

  for (let i = 0; i < 200; i++) camera.zoom(0.5);
  assert.ok(camera.distance >= camera.minimumDistance - 1e-9, 'zoomed inside the minimum');
  for (let i = 0; i < 200; i++) camera.zoom(-0.5);
  assert.ok(camera.distance <= camera.maximumDistance + 1e-9, 'zoomed past the maximum');
});

test('a pinch is measured from where it started, not compounded per callback', () => {
  const camera = new StageCamera(3000);
  camera.magnify(2.0);
  const half = camera.distance;
  // The same cumulative scale reported again must not zoom again.
  camera.magnify(2.0);
  assert.ok(Math.abs(camera.distance - half) < 1e-9,
            'the pinch compounded rather than being relative to its anchor');
  camera.magnify(1.0);
  assert.ok(Math.abs(camera.distance - 3000) < 1e-6, 'returning to scale 1 did not restore');
});

test('resizing keeps the zoom the visitor chose', () => {
  const camera = new StageCamera(3000);
  camera.zoom(0.4);
  const ratio = camera.distance / camera.defaultDistance;
  camera.setDefaultDistance(4200);
  assert.ok(Math.abs(camera.distance / camera.defaultDistance - ratio) < 1e-9,
            'a resize threw away the zoom');
});

test('double-click reframes to the opening view', () => {
  const camera = new StageCamera(3000);
  camera.drag(300, 200);
  camera.zoom(0.5);
  camera.reframe();
  assert.deepEqual(camera.attitude, RESTING_ATTITUDE);
  assert.equal(camera.distance, 3000);
  assert.equal(camera.interacting, false);
});

test('the opening view is tilted slightly above, as the app opens', () => {
  const camera = new StageCamera(3000);
  assert.deepEqual(camera.attitude, normalize(RESTING_ATTITUDE));
  // 0.18 radians about X, and not the identity. "Slightly above" means the subject's TOP
  // is tipped toward the viewer, which is the same direction a downward drag takes it - so
  // the opening view is a small downward drag already applied.
  const top = rotate(camera.attitude, [0, 1, 0]);
  assert.ok(top[2] > 0.1,
            `the opening view is square-on rather than tilted (top z ${top[2].toFixed(3)})`);
  const front = rotate(camera.attitude, [0, 0, 1]);
  assert.ok(front[1] < -0.1, 'the front is not tipped downward');
});
