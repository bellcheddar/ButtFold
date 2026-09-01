/* The stage camera: a slow cinematic orbit that a drag overrides instantly.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldRender/StageCamera.swift`, commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e. Kept free of three.js and of DOM events for the
 * same reason the Swift is kept free of SwiftUI: the whole interaction model is then
 * testable without a browser, and `stage.js` only has to translate pointer events into
 * calls. The quaternion maths below is written out rather than imported for that reason -
 * it is sixteen lines, and it means `tests/stage_camera.test.mjs` needs nothing.
 *
 * **The bug this fixes, in PhoneFold's own words.** The camera used to be yaw and pitch,
 * with pitch clamped to protect a camera orbit's up vector, and that clamp is what made a
 * vertical drag die mid-gesture: from the resting pitch, the clamp was reached after about
 * 223 points of downward drag - one ordinary trackpad drag - after which vertical input did
 * nothing while horizontal kept working. ButtFold shipped with exactly the same clamp, at
 * +/-1.35 radians. The stage rotates the *protein* against a fixed camera on +Z, and a
 * quaternion on the subject has no pole to protect, so the protein now tumbles freely, like
 * the object in the hand the drag is meant to be.
 *
 * Each drag increment is applied about the **screen** axes (premultiplied), which is what
 * keeps "drag right turns right, drag down tips toward you" true in every orientation,
 * including upside down. Composing on the other side flips the horizontal direction
 * whenever the protein is inverted.
 */

/* ------------------------------------------------------------------ quaternions -------- */

/** A quaternion for a rotation of `angle` radians about a unit axis, as [x, y, z, w]. */
export function fromAxisAngle(angle, ax, ay, az) {
  const half = angle / 2;
  const s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

export function multiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export const IDENTITY = [0, 0, 0, 1];

/* ------------------------------------------------------------------ the camera --------- */

/** The framing tilt the stage opens with: slightly above, as a stage should be lit. */
export const RESTING_ATTITUDE = fromAxisAngle(0.18, 1, 0, 0);

export class StageCamera {
  /**
   * @param defaultDistance the distance at which the structure is framed. ButtFold works in
   *   the artefact's own +/-1000 box rather than PhoneFold's normalised 1.15-unit one, so
   *   the absolute number comes from `stage.js`'s aspect fit and only the RATIOS are taken
   *   from the app: it can come to 0.53 of the framed distance and out to 4x it, which is
   *   PhoneFold's 0.8 and 6.0 against its own 1.5.
   */
  constructor(defaultDistance = 3200) {
    this.attitude = RESTING_ATTITUDE.slice();
    this.defaultDistance = defaultDistance;
    this.distance = defaultDistance;
    this.minimumDistance = defaultDistance * (0.8 / 1.5);
    this.maximumDistance = defaultDistance * (6.0 / 1.5);

    /** Radians per second of automatic orbit. */
    this.autoOrbitRate = 0.12;
    /* Seconds of stillness after an interaction before the orbit resumes.
     *
     * Eight, not two and a half, and PhoneFold's comment is the reason: the orbit should be
     * instantly overridden by a drag, and it is, but resuming two and a half seconds after
     * the finger lifts means a view you just set starts sliding away while you are still
     * looking at it. Long enough to read as deliberate. ButtFold's first version never
     * resumed at all, which is the other failure: one drag and the stage is dead. */
    this.resumeDelay = 8.0;
    /* A backstop for a gesture whose end was never announced - a pointer capture lost, a
     * pointerup swallowed by another element. Two seconds, not a fraction of one: a hand
     * holding the protein still mid-drag is completely normal. */
    this.inputTimeout = 2.0;

    this.idleTime = 0;
    this.interacting = false;
    this.sinceLastInput = 0;
    this.pinchAnchor = null;
  }

  get isOrbiting() { return !this.interacting && this.idleTime >= this.resumeDelay; }

  /** Reframe when the viewport changes, keeping the zoom the visitor chose. */
  setDefaultDistance(distance) {
    const ratio = this.distance / this.defaultDistance;
    this.defaultDistance = distance;
    this.minimumDistance = distance * (0.8 / 1.5);
    this.maximumDistance = distance * (6.0 / 1.5);
    this.distance = Math.min(Math.max(distance * ratio, this.minimumDistance),
                             this.maximumDistance);
  }

  advance(deltaTime) {
    if (!(deltaTime > 0)) return;
    if (this.interacting) {
      this.sinceLastInput += deltaTime;
      if (this.sinceLastInput < this.inputTimeout) {
        this.idleTime = 0;
        return;
      }
      // No input for a while: the gesture is over whether or not anyone said so.
      this.endInteraction();
    }
    this.idleTime += deltaTime;
    if (this.idleTime < this.resumeDelay) return;
    // Resume gently rather than snapping to full speed the instant the finger lifts.
    const easeIn = Math.min((this.idleTime - this.resumeDelay) / 1.5, 1);
    this._rotate(0, this.autoOrbitRate * deltaTime * easeIn);
  }

  /**
   * A drag, in CSS pixels, since the previous callback.
   *
   * Dragging **right** turns the front of the protein toward the right of the screen.
   * Dragging **down** brings its top toward the viewer. The signs are the whole of it, and
   * in PhoneFold they were the wrong way round once already, which is why the maths is here
   * and not at the call site.
   */
  drag(deltaX, deltaY, sensitivity = 0.006) {
    this.interacting = true;
    this.idleTime = 0;
    this.sinceLastInput = 0;
    this._rotate(deltaY * sensitivity, deltaX * sensitivity);
  }

  _rotate(aboutScreenX, aboutScreenY) {
    const turn = multiply(fromAxisAngle(aboutScreenX, 1, 0, 0),
                          fromAxisAngle(aboutScreenY, 0, 1, 0));
    // Premultiplied: the increment is about the SCREEN axes, not the subject's own, so
    // "drag right turns right" survives the protein being tumbled upside down.
    this.attitude = normalize(multiply(turn, this.attitude));
  }

  /** Pinch. `scale` is the gesture's cumulative magnification, 1 at the start. */
  magnify(scale) {
    this.interacting = true;
    this.idleTime = 0;
    this.sinceLastInput = 0;
    const anchor = this.pinchAnchor ?? this.distance;
    this.pinchAnchor = anchor;
    this.distance = Math.min(Math.max(anchor / Math.max(scale, 0.01), this.minimumDistance),
                             this.maximumDistance);
  }

  /** Scroll-wheel zoom. Exponential, so a step is the same PROPORTION of the distance
   *  wherever the camera is. Scroll has no end event, so the input timeout closes it. */
  zoom(steps) {
    if (!steps || !Number.isFinite(steps)) return;
    this.interacting = true;
    this.idleTime = 0;
    this.sinceLastInput = 0;
    this.distance = Math.min(Math.max(this.distance * Math.exp(-steps), this.minimumDistance),
                             this.maximumDistance);
  }

  endInteraction() {
    this.interacting = false;
    this.idleTime = 0;
    this.sinceLastInput = 0;
    this.pinchAnchor = null;
  }

  /** Double-click or double-tap: frame the whole structure again. */
  reframe() {
    this.attitude = RESTING_ATTITUDE.slice();
    this.distance = this.defaultDistance;
    this.endInteraction();
  }
}
