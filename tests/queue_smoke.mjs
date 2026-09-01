/* Does a visitor actually get a fold out of the droplet queue?
 *
 * `tests/test_queue.py` proves the caps, the cache and the worker in Python. This proves
 * the thing neither of those touches: that clicking "Fold on the server" on the real page
 * submits a job, follows it through its states, and ends with the result adopted by the
 * same player the gallery uses.
 *
 * It needs the worker running as well as the app:
 *   ./.venv/bin/python app.py
 *   ./.venv/bin/python -m buttfold.worker
 *
 *   node tests/queue_smoke.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8007/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9700 + Math.floor(Math.random() * 150);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bf-queue-'))}`,
  '--no-first-run', '--no-default-browser-check',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', d => { stderr += d.toString(); });

async function endpoint() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error(`Chrome never opened a debugging port\n${stderr.slice(-1200)}`);
}

const ws = new WebSocket(await endpoint());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
const logs = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description}`);
  }
};
const send = (method, params = {}, sessionId) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'threw');
  return result.value;
};

let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evaluate('!!(window.buttfoldPlayer && window.buttfoldPlayer.frames.length)');
  if (ready) break;
}
if (!ready) {
  console.error('the page never loaded');
  logs.forEach(l => console.error(`  [page] ${l}`));
  chrome.kill();
  process.exit(1);
}

// Trp-cage, selected: the page opens on ubiquitin, which the droplet folds in minutes
// rather than seconds, and this test is about the queue rather than about the protein.
await evaluate(`window.buttfoldPlayer.load('trp_cage')`);
await sleep(1200);
const baked = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  return { id: p.fold.id, frames: p.frames.length, q: p.frames[p.frames.length - 1].q,
           rgFirst: p.frames[0].rg, rgLast: p.frames[p.frames.length - 1].rg };
})()`);

await evaluate(`document.querySelector('#engine-mode button[data-source="queued"]').click()`);

// The page picks a random seed per load, so the first click is a genuine fold. A cache hit
// here would be legitimate but would skip the queued and folding states, and an earlier
// version of this test failed on exactly that - reporting the cache doing its job as a
// broken queue. The second click below uses the SAME seed and is therefore a guaranteed
// cache hit, which is how the cache path gets tested deliberately rather than by accident.
const seen = new Set();
let state = null;
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  state = await evaluate(`(() => {
    const p = window.buttfoldPlayer;
    return {
      status: document.getElementById('live-status').textContent,
      source: p.source,
      frames: p.frames.length,
      q: p.frames.length ? p.frames[p.frames.length - 1].q : 0,
      rgFirst: p.frames.length ? p.frames[0].rg : 0,
      rgLast: p.frames.length ? p.frames[p.frames.length - 1].rg : 0,
      contactsTotal: p.frames.reduce((s, f) => s + f.newContacts.length, 0),
      contactsFirst: p.frames.length ? p.frames[0].newContacts.length : 0,
      badge: document.getElementById('badge-where').textContent,
      notes: p.scored ? p.scored.moments.reduce((s, m) => s + m.notes.length, 0) : 0,
      seed: p.fold.queued ? p.fold.queued.seed : null,
      seconds: p.fold.queued ? p.fold.queued.seconds : null,
    };
  })()`);
  seen.add(state.status.replace(/[0-9]+/g, 'N').split(',')[0]);
  if (/^folded on the server/.test(state.status)) break;
}

// Now the cache. Same page, same seed, so this must not spawn a second fold: it must come
// back immediately with the identical trajectory.
const firstSeed = state.seed;
await evaluate(`window.buttfoldPlayer.load('trp_cage')`);
const began = Date.now();
await evaluate(`document.querySelector('#engine-mode button[data-source="queued"]').click()`);
let cached = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  cached = await evaluate(`(() => {
    const p = window.buttfoldPlayer;
    return { status: document.getElementById('live-status').textContent,
             seed: p.fold.queued ? p.fold.queued.seed : null,
             frames: p.frames.length };
  })()`);
  if (/^folded on the server/.test(cached.status)) break;
}
const cacheSeconds = (Date.now() - began) / 1000;
chrome.kill();

console.log(`gallery       ${baked.id}: ${baked.frames} frames, Q ${baked.q.toFixed(3)}`);
console.log(`states seen   ${[...seen].join(' | ')}`);
console.log(`final         "${state.status}"`);
console.log(`result        ${state.frames} frames, Q ${state.q.toFixed(3)}, `
            + `Rg ${state.rgFirst.toFixed(1)} -> ${state.rgLast.toFixed(1)} A `
            + `(ratio ${(state.rgLast / state.rgFirst).toFixed(2)})`);
console.log(`contacts      ${state.contactsTotal}, ${state.contactsFirst} on frame 1`);
console.log(`badge         "${state.badge}", ${state.notes.toLocaleString()} notes`);
console.log(`cache hit     seed ${cached.seed} returned in ${cacheSeconds.toFixed(1)} s, `
            + `${cached.frames} frames`);
if (logs.length) logs.forEach(l => console.log(`  [page] ${l}`));

const failures = [];
if (!/^folded on the server/.test(state.status)) {
  failures.push(`the queued fold never completed: "${state.status}"`);
}
// The states a visitor should actually see, rather than a spinner that ends in an answer.
if (![...seen].some(s => s.startsWith('queued'))) failures.push('never reported a queue position');
if (![...seen].some(s => s.includes('folding on the server'))) {
  failures.push('never reported progress while folding');
}
if (state.source !== 'queued') failures.push(`the player is on source "${state.source}"`);
if (!(state.frames >= 100)) failures.push(`only ${state.frames} frames`);
// The same two assertions the baker makes, because a queued fold that did not collapse is
// as worthless as a baked one that did not, and the worker bakes through the same code.
if (!(state.rgLast / state.rgFirst <= 0.8)) {
  failures.push(`did not collapse: Rg ratio ${(state.rgLast / state.rgFirst).toFixed(2)}`);
}
if (!(state.contactsFirst / state.contactsTotal < 0.25)) {
  failures.push(`started folded: ${state.contactsFirst} of ${state.contactsTotal} on frame 1`);
}
// Q at 0.8 rather than at the gallery's own value. The page asks for a RANDOM seed each
// time, deliberately, so that "fold it again" is a genuinely different trajectory rather
// than a cache hit that looks like a very fast fold. P0-3b measured what that costs: the
// same build folding the same coil lands anywhere across a real spread depending only on
// the random force. Measured here at seed 416548, trp-cage finished at Q 0.892 against the
// gallery's 1.000, which is a good fold and not a regression.
if (!(state.q >= 0.8)) failures.push(`final Q ${state.q.toFixed(3)} is below 0.8`);
if (!state.badge.includes('on the server')) {
  failures.push(`the badge says "${state.badge}": a visitor cannot tell where this was computed`);
}
if (!(state.notes > 500)) failures.push(`the queued fold scored only ${state.notes} notes`);
if (state.seed === null) failures.push('the result carries no seed, so it cannot be reproduced');
if (logs.some(l => l.startsWith('EXCEPTION'))) failures.push('the page threw');

// The cache. Same seed, so the identical trajectory must come back, and it must come back
// far faster than folding it again - which is the whole point of the cache converging.
if (cached.seed !== firstSeed) {
  failures.push(`the cached request returned seed ${cached.seed}, not ${firstSeed}: the `
                + 'cache key does not identify the trajectory');
}
if (!(cached.frames === state.frames)) {
  failures.push(`the cached result has ${cached.frames} frames, not ${state.frames}`);
}
if (!(cacheSeconds < 4)) {
  failures.push(`the cached request took ${cacheSeconds.toFixed(1)} s, which is long enough `
                + 'that it may have folded again rather than hit the cache');
}

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS');
