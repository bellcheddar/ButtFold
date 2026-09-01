/* Does the browser keep the same frames the baker keeps?
 *
 * `tools/bake_gallery.py` runs the Go binary at twice the frame cap and then keeps an
 * evenly spaced `cap` of its output. A fold being watched as the droplet computes it sees
 * the RAW stream and has to make the same choice, in JavaScript, from the two numbers the
 * queue's status route publishes. Two implementations of one rule, so they are run against
 * each other rather than assumed to agree: numpy's `linspace(...).round()` breaks ties to
 * even and JavaScript's `Math.round` breaks them upward, which is the same trap that cost a
 * coordinate in the live parity gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { keptFrameIndices } from '../static/js/frames.js';

// The pair the droplet actually runs, plus sizes chosen to land on ties and on the edges.
const CASES = [[301, 150], [300, 150], [151, 150], [1000, 150], [7, 4], [9, 5], [5, 2]];

test('the browser keeps exactly the frames the baker keeps', () => {
  const python = `
import json, numpy as np
out = {}
for total, cap in ${JSON.stringify(CASES)}:
    idx = np.linspace(0, total - 1, cap).round().astype(int)
    out[f"{total},{cap}"] = sorted(set(idx.tolist()))
print(json.dumps(out))
`;
  const reference = JSON.parse(
    execFileSync('python3', ['-c', python], { encoding: 'utf8' }));

  for (const [total, cap] of CASES) {
    const mine = [...keptFrameIndices(total, cap)].sort((a, b) => a - b);
    assert.deepEqual(mine, reference[`${total},${cap}`],
                     `${total} raw frames down to ${cap}`);
  }
});

test('nothing is dropped when there is nothing to drop', () => {
  assert.equal(keptFrameIndices(150, 150), null);
  assert.equal(keptFrameIndices(10, 150), null);
});

test('the droplet pair keeps the first frame and the last', () => {
  // The last frame is the folded structure and the whole animation is heading towards it,
  // so losing it would be the one loss that shows.
  const kept = keptFrameIndices(301, 150);
  assert.equal(kept.size, 150);
  assert.ok(kept.has(0));
  assert.ok(kept.has(300));
});
