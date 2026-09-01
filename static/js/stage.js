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
import { HYDROPATHY } from './MusicalScale.js';
import { buildCartoon, buildIndices, buildTables, meshSize, profileInUnits, PROFILE }
  from './cartoon.js';

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

/* The confidence ramp: orange below 50, amber below 70, green above 70 (PLAN section 6.1).
 * It colours by how much of the fold has happened at each residue, which is the honest view
 * early on, when most of the chain has not arrived. */
export function confidenceColour(confidence) {
  const percent = confidence * 100;
  if (percent < 50) return 0xff6b35;
  if (percent < 70) return 0xfcb900;
  return 0x35d07f;
}

/* ---------------------------------------------------------------- N to C, and Phobic ----
 * Both ported from PhoneFold's `FoldRender/Colouring.swift`, including its short labels:
 * the app calls these "N->C" and "Phobic" in its own compact form. */

function hsv(hue, saturation, value) {
  const i = Math.floor(hue * 6) % 6;
  const f = hue * 6 - Math.floor(hue * 6);
  const p = value * (1 - saturation);
  const q = value * (1 - f * saturation);
  const t = value * (1 - (1 - f) * saturation);
  const [r, g, b] = [[value, t, p], [q, value, p], [p, value, t],
                     [p, q, value], [t, p, value], [value, p, q]][i];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** N to C through the spectrum. Hue only, at fixed saturation and value, so no residue is
 *  darker than another and the eye reads position rather than brightness. Stops at 0.75 of
 *  the way round: going the whole way makes the two termini the same colour, which defeats
 *  the point of the mode. */
export function rainbowColour(t) {
  return hsv(Math.min(Math.max(t, 0), 1) * 0.75, 0.85, 1.0);
}

function mixHex(a, b, t) {
  const k = Math.min(Math.max(t, 0), 1);
  const ch = shift => Math.round(((a >> shift) & 0xff)
    + (((b >> shift) & 0xff) - ((a >> shift) & 0xff)) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Kyte-Doolittle, mapped cyan (hydrophilic, -4.5) through slate to amber (hydrophobic,
 *  +4.5), so a packing core lights up warm. Which is the thing worth watching: the core
 *  forms first and completely, and this is the mode that shows it. */
export function hydrophobicityColour(hydropathy) {
  const t = Math.min(Math.max((hydropathy + 4.5) / 9.0, 0), 1);
  return t < 0.5 ? mixHex(0x22e5ff, 0x6b7c93, t * 2)
                 : mixHex(0x6b7c93, 0xfcb900, (t - 0.5) * 2);
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

  /* Allocate the cartoon's buffers once for a trajectory of this length.
   *
   * The vertex count is a function of the residue count and the profile ALONE, never of a
   * frame's secondary structure - that is what `ringLayout` guarantees - so the buffers and
   * the index array are built here and only their contents change per frame. A cartoon whose
   * vertex count moved with the assignment would reallocate on most frames of a fold.
   *
   * `angstromsPerUnit` is the fold's own recorded ruler. The cartoon's proportions are in
   * angstroms because that is the language PyMOL and every ribbon diagram use; the stage
   * works in the artefact's quantised box, so they are converted here rather than guessed.
   */
  setResidueCount(n, angstromsPerUnit = null) {
    const ruler = angstromsPerUnit ?? this.angstromsPerUnit ?? 0.04;
    if (n === this.residueCount && this.mesh && ruler === this.angstromsPerUnit) return;
    this.residueCount = n;
    this.angstromsPerUnit = ruler;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    const THREE = this.THREE;

    this.profile = profileInUnits(ruler, PROFILE);
    this.tables = buildTables(this.profile);
    const size = meshSize(n, this.profile);
    this.buffers = {
      position: new Float32Array(size.vertices * 3),
      normal: new Float32Array(size.vertices * 3),
      structure: new Uint8Array(size.vertices),
      residue: new Uint16Array(size.vertices),
    };

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.buffers.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(this.buffers.normal, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(
      new Float32Array(size.vertices * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(buildIndices(n, this.profile), 1));

    const material = new THREE.MeshPhongMaterial({
      vertexColors: true, shininess: 34, specular: 0x1b2740,
      // The cartoon is a closed surface with correct winding, so the back faces are the
      // inside and are never meant to be seen.
      side: THREE.FrontSide, flatShading: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // One mesh, always centred on the origin, always in shot. Culling it can only ever be
    // wrong here, and a stale or NaN bounding sphere is how it silently disappears.
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  /**
   * Draw one frame.
   *
   * @param positions flat xyz, length 3n, in the artefact's quantised units
   * @param ss        per-residue 'H'/'E'/'C', length n
   * @param confidence per-residue native fraction 0..1, for the confidence colour mode
   * @param ssConf    per-residue P-SEA certainty 0..1, which the cartoon's shape is swept from
   */
  render(positions, ss, confidence, ssConf) {
    const n = positions.length / 3;
    this.setResidueCount(n);
    if (!this.mesh) return;

    // No P-SEA certainty (an older artefact, or a source that does not carry it): fall back
    // to full confidence wherever a structure is assigned, so the ribbon is drawn at its
    // full width rather than collapsing to a cord. Stated rather than silent, because a
    // cartoon that quietly renders as a tube looks like a rendering bug.
    const certainty = ssConf ?? this._assumedCertainty(ss, n);

    const written = buildCartoon(positions, ss, certainty, this.profile,
                                 this.buffers, this.tables);
    if (!written) return;

    const geometry = this.mesh.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    // Recomputed every frame: the structure changes size by a factor of two over a
    // trajectory, and a bounding sphere from frame 0 would be wrong for every other frame.
    geometry.computeBoundingSphere();

    this._paint(confidence, n);
    this.renderer.render(this.scene, this.camera);
  }

  /** Draw the scene again without rebuilding anything.
   *
   * The idle orbit and a drag move the camera, not the protein, so they need a draw and not
   * a sweep. Sweeping anyway rebuilt 16,562 vertices sixty times a second to spin a camera:
   * measured at 34 ms a frame on a software rasteriser, which is 29 fps and enough main-
   * thread load to starve the audio thread. The geometry changes when the trajectory frame
   * does, which during playback is 24 times a second and while paused is never.
   */
  redraw() {
    if (this.mesh) this.renderer.render(this.scene, this.camera);
  }

  _assumedCertainty(ss, n) {
    if (!this._certaintyScratch || this._certaintyScratch.length !== n) {
      this._certaintyScratch = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) this._certaintyScratch[i] = ss[i] === 'C' ? 0 : 1;
    return this._certaintyScratch;
  }

  /* Colour every vertex from the structure code the sweep wrote, not from a remap of ring
   * index to residue. The sweep already knows which residue paints each ring, including the
   * duplicated junction rings that make a boundary a hard edge rather than a gradient. */
  _paint(confidence, n) {
    const colours = this.mesh.geometry.attributes.color;
    const array = colours.array;
    const palette = COLOUR_MODES[this.colourMode] ?? COLOUR_MODES.structure;
    const byCode = [palette.C, palette.H, palette.E];
    const colour = new this.THREE.Color();
    const vertices = this.buffers.structure.length;
    const mode = this.colourMode;

    // Two colours per structure code is all the ramp needs, so the conversion is hoisted
    // out of the per-vertex loop: at 20 segments and 10 samples a residue this runs about
    // 160,000 times a frame on ubiquitin, and `Color.setHex` is not free.
    const cache = new Map();
    const rgbOf = (hex) => {
      let rgb = cache.get(hex);
      if (!rgb) { colour.setHex(hex); rgb = [colour.r, colour.g, colour.b]; cache.set(hex, rgb); }
      return rgb;
    };

    // Everything that varies per RESIDUE is looked up through the vertex's own residue
    // index, which the sweep wrote. The sweep does not need to know what any mode means.
    const lastResidue = Math.max(n - 1, 1);
    for (let v = 0; v < vertices; v++) {
      const residue = this.buffers.residue[v];
      let hex;
      if (mode === 'confidence') {
        hex = confidenceColour(confidence ? (confidence[residue] ?? 0) : 0);
      } else if (mode === 'rainbow') {
        hex = rainbowColour(residue / lastResidue);
      } else if (mode === 'phobic') {
        hex = hydrophobicityColour(this.hydropathy ? (this.hydropathy[residue] ?? 0) : 0);
      } else {
        hex = byCode[this.buffers.structure[v]] ?? palette.C;
      }
      const rgb = rgbOf(hex);
      array[3 * v] = rgb[0];
      array[3 * v + 1] = rgb[1];
      array[3 * v + 2] = rgb[2];
    }
    colours.needsUpdate = true;
  }

  setColourMode(mode) { this.colourMode = mode; }

  /** The sequence, for the hydrophobicity mode. Converted to a per-residue Kyte-Doolittle
   *  array once per fold rather than per vertex per frame: at 20 segments and 10 samples a
   *  residue that lookup would run about 160,000 times a frame. */
  setSequence(sequence) {
    this.hydropathy = Float32Array.from(sequence ?? '', code => HYDROPATHY[code] ?? 0);
  }

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
