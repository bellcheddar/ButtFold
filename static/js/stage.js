/* The 3D stage: a ribbon along the CA trace, coloured by secondary structure, orbitable.
 *
 * three.js from a pinned CDN version, tube geometry along a Catmull-Rom spline through the
 * CA trace. PLAN.md section 6.4.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not assign secondary structure. Baked frames arrive with it; live and queued
 *    frames get it from the worker. The stage draws what it is given.
 *  - It does not rebuild geometry per frame. A 150-frame trajectory would allocate and
 *    dispose 150 tube geometries a second, and the garbage collector would show up as
 *    stutter in the animation. The tube is built once at the trajectory's residue count and
 *    its vertex positions are rewritten in place.
 *  - It does not own the clock. `player.js` decides which frame is current and when;
 *    this renders whatever it is handed.
 *
 * The clear colour is --bf-stage, which is the sRGB of the app's linear (0.047, 0.039,
 * 0.122), measured from a render rather than converted from a guess.
 */

import { StageCamera } from './StageCamera.js';

const STAGE_CLEAR = 0x0d0d26;

// Ribbon colouring, the thing a viewer actually sees. PLAN section 6.1.
export const COLOUR_MODES = {
  structure: {
    label: 'Structure',
    H: 0xff3d9a,   // helix magenta
    E: 0x22e5ff,   // sheet cyan
    C: 0x6b7c93,   // coil slate
  },
  // Okabe-Ito: the standard qualitative palette that survives every common form of colour
  // vision deficiency. Magenta against cyan is fine for most people and is the app's look;
  // this is the alternative for the people it is not fine for.
  colourblind: {
    label: 'Colour-blind safe',
    H: 0xe69f00,   // orange
    E: 0x0072b2,   // blue
    C: 0x999999,   // grey
  },
};

/* The confidence ramp, a third mode: orange below 50, amber below 70, green above 70. It
 * colours by how sure P-SEA is rather than by what it decided, which is the honest view
 * early in a fold when it is not sure of anything. */
export function confidenceColour(confidence) {
  const percent = confidence * 100;
  if (percent < 50) return 0xff6b35;
  if (percent < 70) return 0xfcb900;
  return 0x35d07f;
}

export class Stage {
  constructor(container, THREE) {
    this.THREE = THREE;
    this.container = container;
    this.residueCount = 0;
    this.colourMode = 'structure';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(STAGE_CLEAR);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40000);
    // **The camera is fixed on +Z and the SUBJECT rotates**, which is how PhoneFold's stage
    // works and is the whole reason a vertical drag no longer dies. See StageCamera.js.
    // The distance still comes from the viewport in _fitCamera, because the artefact
    // quantises every trajectory into the same +/-1000 box but the RIGHT distance depends
    // on the stage's aspect: one tuned on a wide desktop stage crops a tall phone one.
    this.halfExtent = 1000;      // the artefact's quantisedRange
    this.control = new StageCamera(3200);   // distance replaced by _fitCamera on first resize

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    // Two lights and an ambient: enough to read a tube's curvature without the scene
    // looking lit from a studio. A single light makes the far side of every helix black.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 1, 1);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb4ff, 0.35);
    fill.position.set(-1, -0.6, -0.8);
    this.scene.add(fill);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._installDrag();
    this._installResize();
    this.resize();
  }

  /* Build the tube once for a trajectory of this length. Called on protein change, not on
   * frame change. */
  setResidueCount(n) {
    if (n === this.residueCount && this.mesh) return;
    this.residueCount = n;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const THREE = this.THREE;
    // Enough spline samples that a helix reads as a helix: about four per residue.
    this.tubularSegments = Math.max(64, (n - 1) * 4);
    this.radialSegments = 8;

    // Spread along a line rather than all at the origin. A CatmullRomCurve3 whose control
    // points are coincident has zero length, and TubeGeometry's Frenet frames on it come
    // out NaN: the vertex positions are NaN, the bounding sphere computed from them is NaN,
    // and three.js then frustum-culls the mesh for the rest of its life. The page looks
    // perfect and the stage stays empty. Found by the screenshot gate, not by any test.
    const points = Array.from({ length: n }, (_, i) =>
      new THREE.Vector3(i * 10 - (n - 1) * 5, 0, 0));
    this.curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
    const geometry = new THREE.TubeGeometry(this.curve, this.tubularSegments, 26,
                                            this.radialSegments, false);
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(geometry.attributes.position.count * 3), 3));
    const material = new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 42, specular: 0x223355,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // One mesh, always centred on the origin, always in shot. Culling it can only ever be
    // wrong here, and a stale or NaN bounding sphere is how it silently disappears.
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /**
   * Draw one frame.
   * @param positions flat xyz, length 3n, in the artefact's quantised units
   * @param ss        per-residue 'H'/'E'/'C', length n
   * @param confidence per-residue 0..1, or null
   */
  render(positions, ss, confidence) {
    const n = positions.length / 3;
    this.setResidueCount(n);
    const THREE = this.THREE;

    for (let i = 0; i < n; i++) {
      this.curve.points[i].set(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    }

    // Rebuild the tube's vertex positions in place. TubeGeometry has no "update from
    // curve" method, so a fresh one is generated and its position/normal buffers are
    // copied across. That allocates one geometry per frame inside three.js and discards
    // it immediately, which is still far cheaper than replacing the mesh, and it keeps
    // the colour buffer we own.
    const fresh = new THREE.TubeGeometry(this.curve, this.tubularSegments, 26,
                                         this.radialSegments, false);
    const geometry = this.mesh.geometry;
    geometry.attributes.position.array.set(fresh.attributes.position.array);
    geometry.attributes.normal.array.set(fresh.attributes.normal.array);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    // Recomputed every frame: the structure changes size by a factor of two over a
    // trajectory, and a bounding sphere from frame 0 would be wrong for every other frame.
    geometry.computeBoundingSphere();
    fresh.dispose();

    this._paint(ss, confidence, n);
    this.renderer.render(this.scene, this.camera);
  }

  _paint(ss, confidence, n) {
    const geometry = this.mesh.geometry;
    const colours = geometry.attributes.color;
    const ringCount = this.tubularSegments + 1;
    const perRing = this.radialSegments + 1;
    const palette = COLOUR_MODES[this.colourMode] ?? COLOUR_MODES.structure;
    const colour = new this.THREE.Color();

    for (let ring = 0; ring < ringCount; ring++) {
      // Which residue this ring sits on. The tube is sampled uniformly along the curve,
      // and the curve's control points are the residues, so this is a straight remap.
      const residue = Math.min(n - 1, Math.round(ring / (ringCount - 1) * (n - 1)));
      let hex;
      if (this.colourMode === 'confidence') {
        hex = confidenceColour(confidence ? (confidence[residue] ?? 0) : 0);
      } else {
        hex = palette[ss?.[residue] ?? 'C'] ?? palette.C;
      }
      colour.setHex(hex);
      for (let k = 0; k < perRing; k++) {
        const v = ring * perRing + k;
        if (v * 3 + 2 < colours.array.length) colour.toArray(colours.array, v * 3);
      }
    }
    colours.needsUpdate = true;
  }

  setColourMode(mode) { this.colourMode = mode; }

  /* One frame of the idle spin, called by the player's loop even when paused, so the
   * structure is always presented rather than sitting still like a screenshot. */
  spin(deltaSeconds) {
    this.control.advance(deltaSeconds);
    this._applyOrbit();
  }

  /* The camera distance at which a sphere of radius halfExtent fits both dimensions of
   * the current viewport, with a margin. Vertical and horizontal are computed separately
   * and the larger wins, because whichever needs more room is the one that would crop. */
  _fitCamera() {
    // 1.10, not more. The artefact's scale is set so that the WIDEST frame of the
    // trajectory reaches exactly +/-1000 in its largest axis; measured across the launch
    // gallery, a typical frame reaches 360 to 960, so most of the animation is already
    // smaller than the box. That is the intended consequence of scaling once from the
    // widest frame rather than per frame, and the margin only has to cover the extra
    // projected extent when the structure rotates.
    const margin = 1.10;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const vertical = (this.halfExtent * margin) / Math.tan(vFov / 2);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const horizontal = (this.halfExtent * margin) / Math.tan(hFov / 2);
    this.control.setDefaultDistance(Math.max(vertical, horizontal));
  }

  /* The camera sits on +Z at the chosen distance and never moves off it; the group carries
   * the attitude. No lookAt target to orbit, no up vector to protect, and therefore no pole
   * to clamp against - which is exactly what the old yaw/pitch orbit had, and what killed a
   * vertical drag once it reached the clamp. */
  _applyOrbit() {
    const q = this.control.attitude;
    this.group.quaternion.set(q[0], q[1], q[2], q[3]);
    this.camera.position.set(0, 0, this.control.distance);
    this.camera.lookAt(0, 0, 0);
  }

  /* Pointer, wheel and touch, translated into StageCamera calls and nothing more.
   *
   * `setPointerCapture` rather than window-level listeners: a fast drag that leaves the
   * canvas keeps delivering events to the element that captured it, and the browser sends
   * `pointercancel` if the gesture is taken away - which is the end event the old code had
   * no way to hear. StageCamera's two-second input timeout stays as a backstop anyway,
   * because PhoneFold learned that an end event you rely on is one that will not arrive.
   */
  _installDrag() {
    const element = this.renderer.domElement;
    element.style.touchAction = 'none';
    const pointers = new Map();
    let lastX = 0, lastY = 0, pinchStart = 0;

    const positions = () => [...pointers.values()];
    const spread = () => {
      const [a, b] = positions();
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    element.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      element.setPointerCapture?.(e.pointerId);
      if (pointers.size === 1) { lastX = e.clientX; lastY = e.clientY; }
      if (pointers.size === 2) { pinchStart = spread(); this.control.pinchAnchor = null; }
      e.preventDefault();
    });

    element.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        // Two fingers: pinch to zoom, and no rotation, so the two do not fight.
        if (pinchStart > 0) this.control.magnify(spread() / pinchStart);
      } else {
        this.control.drag(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
      }
      this._applyOrbit();
      this.renderer.render(this.scene, this.camera);
      e.preventDefault();
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId);
      if (pointers.size === 0) {
        this.control.endInteraction();
      } else if (pointers.size === 1) {
        const [only] = positions();
        lastX = only.x; lastY = only.y;   // carry on dragging with the finger left behind
        pinchStart = 0;
      }
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener('lostpointercapture', release);

    // Scroll-wheel zoom: PLAN's "Mac adds scroll-wheel zoom". Scaled to taste and passed
    // straight through; the camera makes it exponential and clamps it.
    element.addEventListener('wheel', (e) => {
      this.control.zoom(-e.deltaY * 0.0015);
      this._applyOrbit();
      this.renderer.render(this.scene, this.camera);
      e.preventDefault();
    }, { passive: false });

    element.addEventListener('dblclick', () => {
      this.control.reframe();
      this._applyOrbit();
      this.renderer.render(this.scene, this.camera);
    });
  }

  _installResize() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this.resize());
      return;
    }
    new ResizeObserver(() => this.resize()).observe(this.container);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._fitCamera();
    this._applyOrbit();
    if (this.mesh) this.renderer.render(this.scene, this.camera);
  }
}
