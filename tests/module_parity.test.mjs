/* Does the streaming module produce the same trajectory as the CLI?
 *
 * The CLI writes a whole fold to a file; the module hands out one frame at a time so a
 * browser can draw it while it happens. They are the same C, so this is not a physics
 * question, it is a wiring question: does `bf_init` seed the way `main` seeds, does
 * `bf_step` interpolate the anneal against the whole run rather than against each block,
 * does the module emit its first frame before the first step like the CLI does.
 *
 * Every one of those is a mistake that produces a trajectory which folds, looks right, and
 * is not the trajectory the gallery was baked from. The bar is therefore BITWISE identity,
 * not approximate agreement: this is one program compiled once, driven two ways.
 *
 *   node --test tests/module_parity.test.mjs
 *
 * Needs, both from tools/build_wasm.sh:
 *   static/wasm/go_model.js       the module
 *   build/wasm/go_model_cli.js    the CLI, run here to generate the reference
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_JS = join(REPO, 'static/wasm/go_model.mjs');
const CLI_JS = join(REPO, 'build/wasm/go_model_cli.js');
const WORK = join(REPO, 'build/p0');

const PROTEIN = 'trp_cage';
const STEPS = 200_000;      // enough to leave the coil and start packing, seconds to run
const STRIDE = 2_000;       // 101 frames
const KT = 1.0, KT_FINAL = 0.6, DT = 0.005, GAMMA = 1.0, CUTOFF = 8.0, MIN_SEP = 3, SEED = 1;

function xyzToFlat(path) {
  return readFileSync(path, 'utf8').trim().split('\n')
    .flatMap(line => line.trim().split(/\s+/).map(Number));
}

/** The CLI's frame file: two little-endian int32 (n, frames), then float32 xyz triples. */
function readFrames(path) {
  const buf = readFileSync(path);
  const n = buf.readInt32LE(0);
  const declared = buf.readInt32LE(4);
  const floats = new Float32Array(buf.buffer, buf.byteOffset + 8,
                                  (buf.length - 8) / 4);
  const frames = [];
  for (let f = 0; f * n * 3 < floats.length; f++) {
    frames.push(floats.subarray(f * n * 3, (f + 1) * n * 3));
  }
  return { n, declared, frames };
}

test('the streaming module reproduces the CLI bit for bit', async () => {
  for (const p of [MODULE_JS, CLI_JS]) {
    assert.ok(existsSync(p), `missing ${p} - run ./tools/build_wasm.sh`);
  }
  mkdirSync(WORK, { recursive: true });

  const nativeXyz = join(REPO, `build/xyz/${PROTEIN}.native.xyz`);
  const startXyz = join(REPO, `build/xyz/${PROTEIN}.start.seed1.xyz`);
  assert.ok(existsSync(nativeXyz), `missing ${nativeXyz} - run tools/coil.py ${PROTEIN}`);

  // Reference: the CLI, exactly as the baker and the droplet queue run it.
  const out = join(WORK, `${PROTEIN}.moduleparity.bin`);
  execFileSync(process.execPath, [
    CLI_JS, '--native', nativeXyz, '--start', startXyz, '--out', out,
    '--steps', String(STEPS), '--stride', String(STRIDE),
    '--kT', String(KT), '--kT-final', String(KT_FINAL), '--seed', String(SEED),
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  const reference = readFrames(out);

  const createGoModel = (await import(MODULE_JS)).default;
  const mod = await createGoModel();

  const native = xyzToFlat(nativeXyz);
  const start = xyzToFlat(startXyz);
  const n = native.length / 3;
  assert.equal(n, reference.n, 'residue count');

  // Doubles into the module heap, because bf_init takes const double*.
  const bytes = native.length * 8;
  const nativePtr = mod._malloc(bytes);
  const startPtr = mod._malloc(bytes);
  mod.HEAPF64.set(native, nativePtr / 8);
  mod.HEAPF64.set(start, startPtr / 8);

  const got = mod._bf_init(nativePtr, startPtr, n, KT, KT_FINAL, DT, GAMMA,
                           CUTOFF, MIN_SEP, SEED, STEPS);
  mod._free(nativePtr);
  mod._free(startPtr);
  assert.equal(got, n, 'bf_init returned the residue count');
  assert.equal(mod._bf_total_steps(), STEPS, 'the module kept the anneal budget it was given');

  const frames = [];
  const snapshot = () => {
    const ptr = mod._bf_positions();
    frames.push(Float32Array.from(mod.HEAPF32.subarray(ptr / 4, ptr / 4 + n * 3)));
  };
  snapshot();                                   // the CLI emits before its first step
  for (let taken = 0; taken < STEPS; taken += STRIDE) {
    mod._bf_step(STRIDE);
    snapshot();
  }

  assert.equal(frames.length, reference.frames.length, 'frame count');
  for (let f = 0; f < frames.length; f++) {
    for (let k = 0; k < n * 3; k++) {
      assert.equal(frames[f][k], reference.frames[f][k],
                   `frame ${f}, component ${k}: module ${frames[f][k]} vs CLI ` +
                   `${reference.frames[f][k]}`);
    }
  }

  // And the readouts the browser shows, against the same coordinates.
  const q = mod._bf_native_fraction();
  const rg = mod._bf_radius_of_gyration();
  assert.ok(q >= 0 && q <= 1, `Q out of range: ${q}`);
  assert.ok(rg > 1 && rg < 100, `Rg implausible: ${rg}`);
  mod._bf_free();
  assert.equal(mod._bf_residue_count(), 0, 'bf_free left no fold running');
});
