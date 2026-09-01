/* The Phase 3 exit gate: does a browser actually fold trp-cage?
 *
 * PLAN.md section 11: "in headless Chrome, a seeded trp-cage live fold reaches Q >= 0.95
 * (native measured 0.973) and streams >= 100 frame messages".
 *
 * This clicks "Fold it live" on the real page, waits for the worker to finish, and measures
 * the trajectory it produced. It is deliberately end to end: the module has already been
 * proved bitwise identical to the CLI (P0-3c) and the frame construction byte-identical to
 * the baker (live_parity), so what is left to test is the wiring - does the page fetch the
 * right native state, hand the worker the right parameters, receive the frames, and put
 * them through the same player.
 *
 *   node tests/live_fold.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8007/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9600 + Math.floor(Math.random() * 150);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'buttfold-live-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,900', '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
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
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`Chrome never opened a debugging port\n${stderr.slice(-1500)}`);
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
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`${msg.params.type}: ` +
              (msg.params.args ?? []).map(a => a.value ?? a.description).join(' '));
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

const support = await evaluate('window.buttfoldPlayer.liveSupported');
const bakedFinalQ = await evaluate(
  '(() => { const f = window.buttfoldPlayer.frames; return f[f.length - 1].q; })()');

// Trp-cage is the first card and is what the page loads by default; assert that rather
// than assume it, because the gate is specifically about trp-cage.
const foldId = await evaluate('window.buttfoldPlayer.fold.id');

console.log(`page          fold ${foldId}, live support ${support.ok ? 'yes' : 'no'}`
            + (support.missing.length ? ` (missing ${support.missing.join(', ')})` : ''));
console.log(`baked final Q ${bakedFinalQ.toFixed(3)}`);

const began = Date.now();
await evaluate(`document.querySelector('#engine-mode button[data-source="live"]').click()`);

let live = null;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  live = await evaluate(`(() => {
    const p = window.buttfoldPlayer;
    const status = document.getElementById('live-status').textContent;
    const done = /^folded /.test(status);
    return {
      status, done, source: p.source,
      frames: p.frames.length,
      finalQ: p.frames.length ? p.frames[p.frames.length - 1].q : 0,
      firstRg: p.frames.length ? p.frames[0].rg : 0,
      lastRg: p.frames.length ? p.frames[p.frames.length - 1].rg : 0,
      badge: document.getElementById('badge-where').textContent,
      contactsTotal: p.frames.reduce((s, f) => s + f.newContacts.length, 0),
      contactsFirst: p.frames.length ? p.frames[0].newContacts.length : 0,
      notes: p.scored ? p.scored.moments.reduce((s, m) => s + m.notes.length, 0) : 0,
      ssFinal: p.frames.length ? p.frames[p.frames.length - 1].ss : '',
    };
  })()`);
  if (live.done) break;
}
const wall = (Date.now() - began) / 1000;
chrome.kill();

console.log(`status        ${live.status}`);
console.log(`wall clock    ${wall.toFixed(1)} s in the browser`);
console.log(`frames        ${live.frames} streamed`);
console.log(`Q             ${live.finalQ.toFixed(3)} (baked ${bakedFinalQ.toFixed(3)})`);
console.log(`Rg            ${live.firstRg.toFixed(1)} -> ${live.lastRg.toFixed(1)} A, `
            + `ratio ${(live.lastRg / live.firstRg).toFixed(2)}`);
console.log(`contacts      ${live.contactsTotal} total, ${live.contactsFirst} on frame 1`);
console.log(`badge         "${live.badge}"`);
console.log(`score         ${live.notes.toLocaleString()} notes`);
if (logs.length) logs.forEach(l => console.log(`  [page] ${l}`));

const failures = [];
if (!support.ok) failures.push(`the page reports no live support: ${support.missing.join(', ')}`);
if (foldId !== 'trp_cage') failures.push(`the default fold is ${foldId}, not trp_cage`);
if (!live.done) failures.push(`the fold did not finish in ${wall.toFixed(0)} s: "${live.status}"`);
// The gate, verbatim from PLAN section 11.
if (!(live.finalQ >= 0.95)) failures.push(`final Q ${live.finalQ.toFixed(3)} is below 0.95`);
if (!(live.frames >= 100)) failures.push(`only ${live.frames} frames streamed, want >= 100`);
// And the same assertions the baker makes, because a live fold that does not collapse is
// as worthless as a baked one that does not.
if (!(live.lastRg / live.firstRg <= 0.8)) {
  failures.push(`the live fold did not collapse: Rg ratio ${(live.lastRg / live.firstRg).toFixed(2)}`);
}
if (!(live.contactsFirst / live.contactsTotal < 0.25)) {
  failures.push(`the live fold started folded: ${live.contactsFirst} of ${live.contactsTotal} `
                + 'contacts on frame 1');
}
if (live.source !== 'live') failures.push(`the player is still on source "${live.source}"`);
if (!live.badge.includes('in your browser')) {
  failures.push(`the stage badge says "${live.badge}", not "in your browser": a visitor `
                + 'cannot tell where this was computed');
}
if (!(live.notes > 500)) failures.push(`the live fold scored only ${live.notes} notes`);
if (!/[HEC]/.test(live.ssFinal)) failures.push('the live frames carry no secondary structure');
if (logs.some(l => l.startsWith('EXCEPTION'))) failures.push('the page threw');

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS');
