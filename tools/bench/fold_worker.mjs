/* The benchmark's fold, in a Web Worker. Also the shape Phase 3's live fold takes.
 *
 * The first version of P0-2 folded on the main thread and yielded with `setTimeout(0)`
 * between blocks of steps, which is the obvious way to keep a tab responsive. Measured:
 * Safari suspended the tab the moment its window went behind another, every WebContent
 * process sat at 0% CPU, and the benchmark simply never finished. From outside that is
 * indistinguishable from "Safari cannot run the module", which is one of the two outcomes
 * P0-2 exists to decide between, and it would have been the wrong answer.
 *
 * A worker is not throttled that way, and it is what PLAN.md section 5.4 specifies for the
 * app regardless. So the measurement now matches the thing being measured, and a visitor
 * who switches tabs mid-fold keeps folding instead of silently stopping.
 *
 * Protocol, deliberately tiny:
 *   in   { type: 'fold', id, native: Float64Array, start: Float64Array, n, steps, stride,
 *          params: { kT, kTFinal, dt, gamma, cutoff, minSep, seed } }
 *   out  { type: 'frame', index, step, positions: Float32Array }   (transferred)
 *        { type: 'done', id, seconds, q, rg, frames }
 *        { type: 'error', id, message }
 */

import createGoModel from '../../static/wasm/go_model.mjs';

let modulePromise = null;
const module_ = () => (modulePromise ??= createGoModel());

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== 'fold') return;
  try {
    const mod = await module_();
    const { id, native, start, n, steps, stride, params } = msg;
    const { kT, kTFinal, dt, gamma, cutoff, minSep, seed } = params;

    const bytes = n * 3 * 8;
    const np = mod._malloc(bytes);
    const sp = mod._malloc(bytes);
    mod.HEAPF64.set(native, np / 8);
    mod.HEAPF64.set(start, sp / 8);
    const ok = mod._bf_init(np, sp, n, kT, kTFinal, dt, gamma, cutoff, minSep, seed, steps);
    mod._free(np);
    mod._free(sp);
    if (ok !== n) throw new Error('bf_init rejected the input');

    const snapshot = () => {
      const ptr = mod._bf_positions();
      // Copied out of the heap before posting: ALLOW_MEMORY_GROWTH can replace the buffer
      // under a growing allocation, and a view onto a detached buffer posts as garbage.
      return Float32Array.from(mod.HEAPF32.subarray(ptr / 4, ptr / 4 + n * 3));
    };

    const started = performance.now();
    let index = 0;
    let first = snapshot();          // the CLI emits before its first step; so does this
    self.postMessage({ type: 'frame', index: index++, step: 0, positions: first },
                     [first.buffer]);
    for (let taken = 0; taken < steps; taken += stride) {
      mod._bf_step(Math.min(stride, steps - taken));
      const positions = snapshot();
      self.postMessage({ type: 'frame', index: index++, step: Math.min(taken + stride, steps),
                         positions }, [positions.buffer]);
    }
    const seconds = (performance.now() - started) / 1000;
    const q = mod._bf_native_fraction();
    const rg = mod._bf_radius_of_gyration();
    mod._bf_free();
    self.postMessage({ type: 'done', id, seconds, q, rg, frames: index });
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.stack || err) });
  }
};
