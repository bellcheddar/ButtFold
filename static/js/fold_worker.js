/* The live fold: architecture C. The visitor's own CPU folds a real protein.
 *
 * PLAN.md section 5.4. The module runs HERE, in a Web Worker, and the main thread receives
 * frames by postMessage. Two reasons it is a worker and not the main thread, and the second
 * one was measured rather than assumed:
 *
 *  1. A fold is seconds to minutes of solid arithmetic. On the main thread the page would
 *     not respond and the ribbon would not turn.
 *  2. **A browser suspends a fold it cannot see.** P0-2 measured Safari sitting at 0% CPU
 *     in every WebContent process the moment its window was occluded, and Chrome taking
 *     1.9x as long in a background tab as in a foreground one. A worker fixes Chrome
 *     completely and does not fix Safari, which suspends the worker too. So this reports
 *     its own progress and the main thread notices a stall rather than pretending.
 *
 * The worker also runs `ContactTracker` and `PSEA`, so the main thread receives frames
 * identical in shape to a baked one and the player cannot tell the paths apart. That is the
 * Watch lesson applied here: the consumer does no geometry it does not have to.
 *
 * No SharedArrayBuffer, so no COOP/COEP header burden on the whole site for one feature.
 * Frames are copied Float32Arrays, transferred rather than cloned.
 *
 * Protocol:
 *   in   { type: 'fold', foldId, native: number[], start: number[], sequence,
 *          steps, frames, params }
 *        { type: 'cancel' }
 *   out  { type: 'ready' }
 *        { type: 'frame', index, frame, step, steps }
 *        { type: 'done', foldId, seconds, q, frames }
 *        { type: 'error', message }
 */

import createGoModel from '../wasm/go_model.mjs';
import { LiveScale, buildFrame, centre, maxAbs, newTrajectoryState, roundHalfToEven }
  from './frames.js';

let modulePromise = null;
const loadModule = () => (modulePromise ??= createGoModel());
let cancelled = false;

/** Native contact pairs and their reference distances, from the native structure.
 *
 * The same definition the C uses when it builds the model: |i-j| >= minSep and a native
 * CA-CA distance under the cutoff. Recomputed here rather than asked of the module, because
 * the module reports only the chain-wide fraction and the sonifier needs it per residue. */
function nativeContacts(native, cutoff, minSep) {
  const n = native.length / 3;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + minSep; j < n; j++) {
      const dx = native[3 * j] - native[3 * i];
      const dy = native[3 * j + 1] - native[3 * i + 1];
      const dz = native[3 * j + 2] - native[3 * i + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < cutoff) pairs.push([i, j, d]);
    }
  }
  return pairs;
}

/**
 * Per-residue native fraction, on a 0 to 100 scale: the confidence the sonifier reads.
 *
 * A residue with no native contacts of its own takes the chain's overall value, because
 * 0/0 is not 0. A flexible terminus or a residue on a convex surface can have no long-range
 * partners at all, and scoring those zero would paint them as permanently unfolded even in
 * the native structure. Measured on the launch gallery: 5 of ubiquitin's 76 residues take
 * that branch, so it is not dead code.
 */
function perResidueNativeFraction(points, pairs, n, tolerance = 1.2) {
  const formed = new Float64Array(n);
  const total = new Float64Array(n);
  let close = 0;
  for (const [i, j, sigma] of pairs) {
    total[i]++; total[j]++;
    const dx = points[3 * j] - points[3 * i];
    const dy = points[3 * j + 1] - points[3 * i + 1];
    const dz = points[3 * j + 2] - points[3 * i + 2];
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) < tolerance * sigma) {
      formed[i]++; formed[j]++; close++;
    }
  }
  const overall = pairs.length ? close / pairs.length : 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (total[i] > 0 ? formed[i] / total[i] : overall) * 100;
  return { confidence: out, q: overall };
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'cancel') { cancelled = true; return; }
  if (message.type !== 'fold') return;

  cancelled = false;
  try {
    const mod = await loadModule();
    self.postMessage({ type: 'ready' });

    const { foldId, sequence, steps, frames: frameCount, params } = message;
    const native = Float64Array.from(message.native);
    const start = Float64Array.from(message.start);
    const n = native.length / 3;
    const { kT, kTFinal, dt, gamma, cutoff, minSep, seed } = params;

    const bytes = n * 3 * 8;
    const np = mod._malloc(bytes);
    const sp = mod._malloc(bytes);
    mod.HEAPF64.set(native, np / 8);
    mod.HEAPF64.set(start, sp / 8);
    const ok = mod._bf_init(np, sp, n, kT, kTFinal, dt, gamma, cutoff, minSep, seed, steps);
    mod._free(np);
    mod._free(sp);
    if (ok !== n) throw new Error('the model rejected this input');

    const pairs = nativeContacts(native, cutoff, minSep);
    const state = newTrajectoryState(n);
    const stride = Math.max(Math.floor(steps / frameCount), 1);

    const readPositions = () => {
      const ptr = mod._bf_positions();
      // Copied out before anything else runs: ALLOW_MEMORY_GROWTH can replace the whole
      // heap buffer under a growing allocation, and a view onto a detached buffer reads as
      // zeros or throws, with no error from the module itself.
      return Float64Array.from(mod.HEAPF32.subarray(ptr / 4, ptr / 4 + n * 3));
    };

    const first = readPositions();
    const scale = new LiveScale(maxAbs(centre(first)));

    let index = 0;
    const emit = (points, step) => {
      const units = scale.accommodate(maxAbs(centre(points)));
      const { confidence, q } = perResidueNativeFraction(points, pairs, n);
      const frame = buildFrame(points, units, state.tracker, state.smoother, confidence);
      frame.q = roundHalfToEven(q * 1000);
      self.postMessage({ type: 'frame', index: index++, frame, step, steps });
      return q;
    };

    const began = performance.now();
    let q = emit(first, 0);          // the CLI emits before its first step; so does this
    for (let taken = 0; taken < steps && !cancelled; taken += stride) {
      mod._bf_step(Math.min(stride, steps - taken));
      q = emit(readPositions(), Math.min(taken + stride, steps));
    }
    const seconds = (performance.now() - began) / 1000;
    mod._bf_free();

    if (cancelled) {
      self.postMessage({ type: 'cancelled', foldId, frames: index });
    } else {
      self.postMessage({ type: 'done', foldId, seconds, q, frames: index,
                         angstromsPerUnit: scale.angstromsPerUnit,
                         scaleGrewTimes: scale.grewTimes });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.stack || err) });
  }
};
