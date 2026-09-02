/* Does a real pointer drag actually turn the structure, in a real browser?
 *
 * `tests/stage_camera.test.mjs` proves the interaction MODEL: what a drag of n pixels does
 * to the attitude. It says nothing about whether a pointer event ever reaches it, and that
 * is the half Marc reported broken. A camera with a perfect model and no listener attached
 * passes every unit test and does nothing at all when you drag it.
 *
 * So this dispatches genuine mouse and wheel input through the DevTools protocol at the
 * canvas, and checks the attitude, the distance and the rendered pixels all changed.
 *
 *   node tests/stage_drag.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8007/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9880 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bf-drag-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,900',
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
    expression, returnByValue: true, awaitPromise: true,
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

const state = () => evaluate(`(() => {
  const c = window.buttfoldPlayer.stage.control;
  return { attitude: c.attitude.slice(), distance: c.distance,
           interacting: c.interacting, orbiting: c.isOrbiting };
})()`);

/** A fingerprint of what the stage is actually showing. */
const pixels = () => evaluate(`(() => {
  // Excluding the ribbon: the stage holds two canvases now - three.js's, and the residue
  // ribbon drawn over it in 2D. A bare selector picks whichever comes first, and asking a
  // 2D canvas for a WebGL context returns null rather than throwing, so this failed as
  // "Cannot read properties of null" a long way from the selector that caused it.
  //
  // And no backticks in this comment: it sits inside a JS template literal, where one would
  // end the literal. That is the second time in this session.
  const canvas = document.querySelector('#stage canvas:not(.residue-ribbon)');
  const player = window.buttfoldPlayer;
  const frame = player.frames[player.index];
  player.stage.render(frame.points, frame.ss, frame.confidence);
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const buf = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let h = 0;
  for (let i = 0; i < buf.length; i += 4) h = (h * 31 + buf[i] + buf[i+1] * 3 + buf[i+2] * 7) >>> 0;
  return h;
})()`);

const box = await evaluate(`(() => {
  const r = document.querySelector('#stage canvas:not(.residue-ribbon)').getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);

async function drag(dx, dy, steps = 8) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1,
    clickCount: 1, pointerType: 'mouse',
  }, sessionId);
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: box.x + Math.round(dx * i / steps),
      y: box.y + Math.round(dy * i / steps), button: 'left', buttons: 1,
      pointerType: 'mouse',
    }, sessionId);
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: box.x + dx, y: box.y + dy, button: 'left', buttons: 0,
    clickCount: 1, pointerType: 'mouse',
  }, sessionId);
  await sleep(200);
}

const failures = [];
const before = await state();
const beforePixels = await pixels();

// A horizontal drag.
await drag(220, 0);
const afterH = await state();
const afterHPixels = await pixels();
const movedH = afterH.attitude.some((v, i) => Math.abs(v - before.attitude[i]) > 1e-6);

// Then a LONG vertical drag, well past where the old +/-1.35 clamp would have stopped it.
// 1,200 pixels at 0.006 rad/px is about seven radians: more than a full tumble.
const beforeV = await state();
for (let i = 0; i < 6; i++) await drag(0, 200);
const afterV = await state();
const movedV = afterV.attitude.some((v, i) => Math.abs(v - beforeV.attitude[i]) > 1e-6);

// And the LAST increment of that vertical drag must still do something. This is the
// regression: the old clamp let the first part of a drag work and silently stopped the
// rest, so a test that only compared start to end would have passed.
const beforeLast = await state();
await drag(0, 200);
const afterLast = await state();
const lastMoved = afterLast.attitude.some((v, i) => Math.abs(v - beforeLast.attitude[i]) > 1e-6);

// Wheel zoom.
const beforeZoom = (await state()).distance;
for (let i = 0; i < 5; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120, pointerType: 'mouse',
  }, sessionId);
  await sleep(60);
}
const afterZoom = (await state()).distance;

// Double-click reframes.
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent',
             { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
               clickCount: 2, pointerType: 'mouse' }, sessionId);
}
await sleep(300);
const afterReframe = await state();

chrome.kill();

console.log(`canvas centre     ${box.x}, ${box.y}`);
console.log(`horizontal drag   attitude changed: ${movedH}, pixels changed: `
            + `${beforePixels !== afterHPixels}`);
console.log(`vertical drag     1,200 px: attitude changed: ${movedV}`);
console.log(`  its last 200 px still moved: ${lastMoved}`);
console.log(`wheel zoom        ${beforeZoom.toFixed(0)} -> ${afterZoom.toFixed(0)}`);
console.log(`double-click      distance back to ${afterReframe.distance.toFixed(0)}, `
            + `interacting ${afterReframe.interacting}`);
if (logs.length) logs.forEach(l => console.log(`  [page] ${l}`));

if (!movedH) failures.push('a horizontal drag did not turn the structure');
if (beforePixels === afterHPixels) {
  failures.push('the stage rendered identical pixels after a drag: the camera moved and '
                + 'nothing redrew');
}
if (!movedV) failures.push('a vertical drag did not turn the structure');
if (!lastMoved) {
  failures.push('the last 200 px of a 1,400 px vertical drag did nothing: the pitch is '
                + 'clamped again, which is the bug that made a vertical drag die mid-gesture');
}
if (!(afterZoom < beforeZoom * 0.95)) {
  failures.push(`the wheel did not zoom in (${beforeZoom.toFixed(0)} -> ${afterZoom.toFixed(0)})`);
}
if (Math.abs(afterReframe.distance - afterZoom) < 1) {
  failures.push('double-click did not reframe');
}
if (logs.some(l => l.startsWith('EXCEPTION'))) failures.push('the page threw');

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS');
