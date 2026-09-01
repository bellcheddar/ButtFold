/* The Phase 1 exit gate: a headless screenshot of the stage mid-fold is non-uniform, and
 * the served artefact's first and last frames really do differ in Rg by the asserted ratio.
 *
 * The screenshot check is the house rule (PLAN.md section 10, item 6): any committed
 * screenshot is asserted non-uniform before it is believed. It exists because a stage that
 * renders nothing at all produces a beautiful, plausible, entirely flat dark-blue rectangle
 * that looks exactly like a stage waiting for its first frame.
 *
 * Non-uniformity is measured as the fraction of pixels that differ from the modal colour by
 * more than a small threshold. A blank canvas scores near zero; a drawn ribbon scores well
 * above it. The threshold is deliberately generous, because the point is to catch "nothing
 * was drawn", not to grade the rendering.
 *
 *   node tests/stage_screenshot.mjs [url] [outputPng]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'http://127.0.0.1:8007/';
const outPng = process.argv[3] ?? join(REPO, 'build/p0/stage.png');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(Math.random() * 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'buttfold-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,900',
  // WebGL in headless Chrome needs a software rasteriser; without these the stage silently
  // produces a context-creation failure and an empty canvas, which is the exact false
  // negative this test is supposed to catch.
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
const pageLogs = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageLogs.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description}`);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    pageLogs.push((msg.params.args ?? []).map(a => a.value ?? a.description).join(' '));
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

// Wait for the player to have loaded a trajectory, rather than for a fixed delay: a fixed
// delay is how a screenshot ends up being taken of a page that had not finished loading.
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  ready = await evaluate('!!(window.buttfoldPlayer && window.buttfoldPlayer.frames.length)');
  if (ready) break;
}
if (!ready) {
  console.error('the player never loaded a trajectory');
  pageLogs.forEach(l => console.error(`  [page] ${l}`));
  chrome.kill();
  process.exit(1);
}

const info = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  // Mid-fold, deliberately: frame 0 is a coil and the last frame is the folded structure,
  // and a screenshot of either would be a picture of an endpoint rather than of the thing
  // the page is about.
  p._show(Math.floor(p.frames.length / 2));
  const first = p.frames[0], last = p.frames[p.frames.length - 1];
  return {
    id: p.fold.id, name: p.fold.name, frames: p.frames.length,
    residues: p.residueCount,
    rgFirst: first.rg, rgLast: last.rg,
    collapseRatio: last.rg / first.rg,
    contactsTotal: p.frames.reduce((s, f) => s + f.newContacts.length, 0),
    contactsFirstFrame: first.newContacts.length,
    ssMid: p.frames[Math.floor(p.frames.length / 2)].ss,
  };
})()`);
await sleep(600);   // one or two animation frames, so the render lands

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false },
                        sessionId);
mkdirSync(dirname(outPng), { recursive: true });
const png = Buffer.from(shot.data, 'base64');
writeFileSync(outPng, png);

// Non-uniformity, measured on the stage element alone rather than the whole page: the page
// has text and cards on it and would score as varied even with a dead canvas.
const uniformity = await evaluate(`(() => {
  const canvas = document.querySelector('#stage canvas');
  if (!canvas) return { error: 'no canvas in #stage' };
  // Force a render and read the buffer in the SAME task. WebGL clears its drawing buffer
  // after compositing unless preserveDrawingBuffer is set, so a readPixels done later
  // returns a blank canvas whatever was drawn - a false negative that looks exactly like
  // the real failure this test hunts for.
  const player = window.buttfoldPlayer;
  const frame = player.frames[player.index];
  player.stage.render(frame.points, frame.ss, null);
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return { error: 'no WebGL context' };
  const w = canvas.width, h = canvas.height;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const counts = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const key = (pixels[i] >> 3) + ',' + (pixels[i+1] >> 3) + ',' + (pixels[i+2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let modal = 0, modalKey = '';
  for (const [k, v] of counts) if (v > modal) { modal = v; modalKey = k; }
  const total = w * h;
  return { width: w, height: h, distinctColours: counts.size,
           modalKey, modalFraction: modal / total,
           nonUniformFraction: 1 - modal / total };
})()`);

// Each colour mode must produce a DIFFERENT rendering. This is the check that would have
// caught the confidence ramp reading `null` for every residue and painting the whole ribbon
// one colour: the module was imported, the button was wired, the function was called, and
// the wiring audit could see nothing wrong. A mode that changes the colours to a single
// uniform colour looks implemented from every angle except this one.
const modes = await evaluate(`(async () => {
  const out = {};
  const canvas = document.querySelector('#stage canvas');
  const player = window.buttfoldPlayer;
  for (const mode of ['structure', 'colourblind', 'confidence']) {
    document.querySelector('#colour-mode button[data-mode="' + mode + '"]').click();
    const frame = player.frames[player.index];
    player.stage.render(frame.points, frame.ss, frame.confidence);
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const counts = new Map();
    let signature = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const key = (pixels[i] >> 4) + ',' + (pixels[i+1] >> 4) + ',' + (pixels[i+2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      signature = (signature * 31 + pixels[i] + pixels[i+1] * 3 + pixels[i+2] * 7) >>> 0;
    }
    let modal = 0;
    for (const v of counts.values()) if (v > modal) modal = v;
    out[mode] = { distinct: counts.size, nonUniform: 1 - modal / (canvas.width * canvas.height),
                  signature };
  }
  document.querySelector('#colour-mode button[data-mode="structure"]').click();
  return out;
})()`);

// And the page must be usable on a phone: the stage is specified as roughly the lower half
// of the viewport, and nothing may push the body wider than the screen.
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
}, sessionId);
await sleep(900);
const mobile = await evaluate(`(() => {
  const stage = document.getElementById('stage').getBoundingClientRect();
  return {
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    stageHeight: Math.round(stage.height),
    stageWidth: Math.round(stage.width),
    viewportHeight: window.innerHeight,
    controlsReachable: [...document.querySelectorAll('.segmented button, .play')]
      .every(el => el.getBoundingClientRect().right <= window.innerWidth + 1),
  };
})()`);
const mobileShot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync(outPng.replace(/\.png$/, '-mobile.png'),
              Buffer.from(mobileShot.data, 'base64'));

chrome.kill();

console.log(`fold          ${info.name} (${info.id}), ${info.residues} residues, ${info.frames} frames`);
console.log(`Rg            ${info.rgFirst.toFixed(1)} -> ${info.rgLast.toFixed(1)} A, ratio ${info.collapseRatio.toFixed(2)}`);
console.log(`contacts      ${info.contactsTotal} total, ${info.contactsFirstFrame} on frame 1 (${(100*info.contactsFirstFrame/info.contactsTotal).toFixed(0)}%)`);
console.log(`stage canvas  ${uniformity.width}x${uniformity.height}, ${uniformity.distinctColours} distinct colours`);
console.log(`non-uniform   ${(uniformity.nonUniformFraction * 100).toFixed(1)}% of pixels differ from the modal colour`);
console.log(`screenshot    ${outPng}`);
for (const [mode, m] of Object.entries(modes)) {
  console.log(`  ${mode.padEnd(12)} ${m.distinct} colours, `
              + `${(m.nonUniform * 100).toFixed(1)}% non-uniform, signature ${m.signature}`);
}
console.log(`mobile 390px  body ${mobile.bodyScrollWidth}px wide, stage `
            + `${mobile.stageWidth}x${mobile.stageHeight} of ${mobile.viewportHeight}px`);
if (pageLogs.length) pageLogs.forEach(l => console.log(`  [page] ${l}`));

const failures = [];
if (uniformity.error) failures.push(uniformity.error);
// A blank stage is one colour and scores ~0. A drawn ribbon on a dark ground covers a few
// per cent of the canvas, so 1% is comfortably above blank and comfortably below a real
// render.
if (!(uniformity.nonUniformFraction > 0.01)) {
  failures.push(`the stage is uniform: ${(uniformity.nonUniformFraction * 100).toFixed(2)}% of pixels differ from the modal colour, which is what a stage that drew nothing looks like`);
}
if (!(uniformity.distinctColours > 8)) {
  failures.push(`only ${uniformity.distinctColours} distinct colours on the stage`);
}
if (!(info.collapseRatio <= 0.8)) {
  failures.push(`the served artefact does not collapse: Rg ratio ${info.collapseRatio.toFixed(2)} against the 0.8 bar`);
}
if (!(info.contactsFirstFrame / info.contactsTotal < 0.25)) {
  failures.push(`the served artefact starts folded: ${info.contactsFirstFrame} of ${info.contactsTotal} contacts on frame 1`);
}
if (!/[HEC]/.test(info.ssMid)) {
  failures.push('the mid-fold frame carries no secondary structure');
}

// Every colour mode must draw something, and no two may draw the same thing.
for (const [mode, m] of Object.entries(modes)) {
  if (!(m.nonUniform > 0.01)) failures.push(`the ${mode} colour mode drew nothing`);
  if (!(m.distinct > 4)) failures.push(`the ${mode} colour mode drew ${m.distinct} colours`);
}
const signatures = Object.entries(modes).map(([mode, m]) => [mode, m.signature]);
for (let i = 0; i < signatures.length; i++) {
  for (let j = i + 1; j < signatures.length; j++) {
    if (signatures[i][1] === signatures[j][1]) {
      failures.push(`the ${signatures[i][0]} and ${signatures[j][0]} colour modes render `
                    + 'identically, so at least one of them is wired to nothing');
    }
  }
}

// The mobile pass. A page whose body is wider than the viewport scrolls sideways, which on
// a phone is the difference between a usable page and a broken one.
if (mobile.bodyScrollWidth > mobile.viewportWidth + 1) {
  failures.push(`the body is ${mobile.bodyScrollWidth}px wide in a ${mobile.viewportWidth}px `
                + 'viewport, so the page scrolls sideways');
}
if (!(mobile.stageHeight >= 300)) {
  failures.push(`the stage is only ${mobile.stageHeight}px tall on a phone`);
}
if (!mobile.controlsReachable) failures.push('a control is off the right edge on a phone');

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS');
