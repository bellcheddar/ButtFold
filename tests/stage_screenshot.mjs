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
  // Excluding the ribbon: the stage holds two canvases now - three.js's, and the residue
  // ribbon drawn over it in 2D. A bare selector picks whichever comes first, and asking a
  // 2D canvas for a WebGL context returns null rather than throwing, so this failed as
  // "Cannot read properties of null" a long way from the selector that caused it.
  //
  // And no backticks in this comment: it sits inside a JS template literal, where one would
  // end the literal. That is the second time in this session.
  const canvas = document.querySelector('#stage canvas:not(.residue-ribbon)');
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
  const canvas = document.querySelector('#stage canvas:not(.residue-ribbon)');
  const player = window.buttfoldPlayer;
  for (const mode of ['structure', 'colourblind', 'confidence', 'rainbow', 'phobic']) {
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

/* Does the structure move BETWEEN frames, or does it jump from one to the next?
 *
 * A trajectory is 150 frames and the music is about forty seconds, so the frame index
 * changes four times a second while the page redraws sixty times: without interpolation the
 * same pose is drawn fifteen times and then replaced, which is what jumping is. This samples
 * the rendered geometry itself - the vertex buffer the cartoon sweeps - and asks how many
 * DISTINCT poses appear while the frame index holds still.
 *
 * Sampled from the buffer rather than from the frame index, because the frame index would
 * be the same in both cases: the question is what was drawn, not what was asked for. */
const morph = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  // A hash of the vertex buffer the cartoon actually swept, sampled sparsely: what was
  // DRAWN, not what was asked for. The frame index is identical with and without
  // interpolation, so watching it would prove nothing.
  const signature = () => {
    const a = p.stage.buffers.position;
    let h = 2166136261;
    for (let i = 0; i < a.length; i += 97) {
      h ^= Math.round(a[i] * 1000); h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const poses = new Set();
  const frames = new Set();
  // Thirteen samples inside ONE frame's worth of playback, which is roughly what the loop
  // takes at 60 Hz between two frames of a 150-frame trajectory over forty seconds.
  for (let i = 0; i <= 12; i++) {
    p._showAt(40 + i / 13);
    poses.add(signature());
    frames.add(p.index);
  }
  return { poses: poses.size, frames: frames.size };
})()`);
console.log(`morph         ${morph.poses} distinct poses drawn across `
            + `${morph.frames} trajectory frame(s)`);

// The transport must be ON SCREEN without scrolling, at the sizes people actually have.
// Marc's instruction, 2026-09-01: the structure should share more of the screen and the
// Play bar should be visible at the bottom on a standard screen. That is arithmetic over
// six element heights, which is exactly the sort of thing that is right when written and
// wrong three commits later, so it is measured rather than trusted.
const desktops = [];
for (const [width, height] of [[1440, 900], [1280, 800], [1512, 982], [1366, 768]]) {
  await send('Emulation.setDeviceMetricsOverride',
             { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(450);
  desktops.push(await evaluate(`(() => {
    const play = document.getElementById('play').getBoundingClientRect();
    const stage = document.getElementById('stage').getBoundingClientRect();
    const controls = document.querySelector('.controls');
    // One line means every group shares the row's top edge. Comparing heights would pass a
    // wrap that happened to leave the container the same height.
    const tops = [...controls.querySelectorAll('.control')]
      .map(el => Math.round(el.getBoundingClientRect().top));
    const readouts = [...document.querySelectorAll('.readout')]
      .map(el => Math.round(el.getBoundingClientRect().top));
    const volume = document.getElementById('volume').getBoundingClientRect();
    const transport = document.querySelector('.stage-transport').getBoundingClientRect();
    const segmented = document.querySelector('.segmented').getBoundingClientRect();
    return {
      // Marc's instruction: the Play panel matches the COLOUR/STYLE/ENGINE panel. Compared
      // as measured boxes rather than as matching declarations, because the two are built
      // from different padding and font stacks and only agree by arithmetic.
      transportHeight: Math.round(transport.height),
      segmentedHeight: Math.round(segmented.height),
      playFontPx: parseFloat(getComputedStyle(document.getElementById('play')).fontSize),
      segmentedFontPx: parseFloat(
        getComputedStyle(document.querySelector('.segmented button')).fontSize),
      volumeIconVisible: !!document.querySelector('.volume-icon')?.getBoundingClientRect().width,
      size: '${width}x${height}',
      playBottom: Math.round(play.bottom),
      // The transport is inside the viewer now, so "on screen" is no longer arithmetic over
      // six element heights: it is whether the bar is inside the stage it overlays.
      playInsideStage: play.top >= stage.top - 1 && play.bottom <= stage.bottom + 1
                       && play.left >= stage.left - 1,
      // A range input that did not turn is 18 px wide and full height of nothing: it looks
      // like a hairline rather than like a broken control, which is why this is measured.
      volumeIsVertical: volume.height > volume.width * 2,
      volumeInsideStage: volume.right <= stage.right + 1 && volume.top >= stage.top - 1
                         && volume.bottom <= stage.bottom + 1,
      // The readouts are the last thing under the stage, so this is what "the viewer fits"
      // actually means now that the transport is inside the frame. The stage's height is a
      // subtraction from the viewport and the subtrahend is measured HERE rather than added
      // up on paper, which is the only reason it is right.
      readoutsBottom: Math.round(
        document.querySelector('.readouts').getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
      stageHeight: Math.round(stage.height),
      stageShare: stage.height / window.innerHeight,
      controlRows: new Set(tops).size,
      controlsWidth: Math.round(controls.scrollWidth),
      controlsFits: controls.scrollWidth <= controls.clientWidth + 1,
      readoutRows: new Set(readouts).size,
    };
  })()`));
}
// And the same four sizes with the ESMFold engine selected, because that mode adds a row
// above the stage. The first version of this row was `display: flex`, which beats the
// browser's own `[hidden] { display: none }`, so it took its height even while hidden and
// pushed the readouts below the fold in EVERY mode.
const withPulldown = [];
for (const [width, height] of [[1440, 900], [1280, 800], [1366, 768]]) {
  await send('Emulation.setDeviceMetricsOverride',
             { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(300);
  withPulldown.push(await evaluate(`(() => {
    document.querySelector('#engine-mode button[data-source="queued"]').click();
    const row = document.getElementById('uniprot-row').getBoundingClientRect();
    return {
      size: '${width}x${height}',
      rowHeight: Math.round(row.height),
      readoutsBottom: Math.round(
        document.querySelector('.readouts').getBoundingClientRect().bottom),
      viewportHeight: window.innerHeight,
    };
  })()`));
}
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

// And the page must be usable on a phone: the stage is specified as roughly the lower half
// of the viewport, and nothing may push the body wider than the screen.
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
}, sessionId);
await sleep(900);
const mobile = await evaluate(`(() => {
  const stage = document.getElementById('stage').getBoundingClientRect();
  const tops = [...document.querySelectorAll('.readout')]
    .map(el => Math.round(el.getBoundingClientRect().top));
  const rows = [...new Set(tops)].sort((a, b) => a - b);
  // The badge and the music switch used to be pinned to the same corner and sized
  // independently: at 350 px the badge wraps to two lines, grows underneath the switch, and
  // the two overlap. Measured as rectangles rather than trusted, because it looked correct
  // at every desktop width and only failed on a phone.
  const badge = document.querySelector('.stage-badge').getBoundingClientRect();
  const toggle = document.querySelector('.music-toggle').getBoundingClientRect();
  const overlap = !(badge.right <= toggle.left || toggle.right <= badge.left
                    || badge.bottom <= toggle.top || toggle.bottom <= badge.top);
  return {
    badgeOverlapsToggle: overlap,
    footerInsideStage: badge.left >= stage.left - 1 && toggle.right <= stage.right + 1
                       && badge.top >= stage.top - 1 && toggle.bottom <= stage.bottom + 1,
    // The two charts must be on a phone AND have a canvas with height in them. They were
    // never hidden: the canvas flexes into its row, and off the stage's row there was no
    // height to flex into, so both drew a title and a legend with a hairline between them.
    chartCanvases: [...document.querySelectorAll('.chart canvas')]
      .map(c => Math.round(c.getBoundingClientRect().height)),
    // Eight readouts as four columns and two rows, which is why there are eight.
    readoutRows: rows.length,
    readoutColumns: rows.length ? tops.filter(t => t === rows[0]).length : 0,
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
for (const d of desktops) {
  console.log(`  ${d.size.padEnd(9)} volume ${d.volumeIsVertical ? 'vertical' : 'FLAT'}, `
              + `panels ${d.transportHeight}/${d.segmentedHeight}px, `
              + `readouts end at ${d.readoutsBottom}px of `
              + `${d.viewportHeight}px, stage ${d.stageHeight}px `
              + `(${(d.stageShare * 100).toFixed(0)}%), controls ${d.controlRows} row`
              + `${d.controlRows === 1 ? '' : 's'} (${d.controlsWidth}px), `
              + `readouts ${d.readoutRows} row${d.readoutRows === 1 ? '' : 's'}`);
}
console.log(`mobile 390px  badge/switch overlap ${mobile.badgeOverlapsToggle}, `
            + `both inside the stage ${mobile.footerInsideStage}`);
console.log(`mobile 390px  charts ${mobile.chartCanvases.join(' and ')}px tall, readouts `
            + `${mobile.readoutColumns}x${mobile.readoutRows}, `
            + `body ${mobile.bodyScrollWidth}px wide, stage `
            + `${mobile.stageWidth}x${mobile.stageHeight} of ${mobile.viewportHeight}px`);
if (pageLogs.length) pageLogs.forEach(l => console.log(`  [page] ${l}`));

const failures = [];
if (uniformity.error) failures.push(uniformity.error);
// 13 samples inside one frame's worth of playback should be 13 different poses. Before
// interpolation they were one pose drawn thirteen times, and the frame index - which is what
// a naive test would have watched - was identical in both cases.
if (!(morph.poses >= 12)) {
  failures.push(`only ${morph.poses} distinct poses across 13 samples within one frame: the `
                + 'structure is jumping from frame to frame rather than moving between them');
}
if (morph.frames !== 1) {
  failures.push(`the samples crossed ${morph.frames} trajectory frames, so this measured `
                + 'the frames changing rather than the poses between them');
}
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

for (const d of desktops) {
  // Same height and same text size as the control panel above it.
  if (Math.abs(d.transportHeight - d.segmentedHeight) > 1) {
    failures.push(`at ${d.size} the Play panel is ${d.transportHeight}px and the control `
                  + `panel is ${d.segmentedHeight}px`);
  }
  if (d.playFontPx !== d.segmentedFontPx) {
    failures.push(`at ${d.size} Play is set at ${d.playFontPx}px and the control buttons at `
                  + `${d.segmentedFontPx}px`);
  }
  if (!d.volumeIconVisible) failures.push(`at ${d.size} the volume icon did not render`);
  if (!d.playInsideStage) {
    failures.push(`at ${d.size} the transport is not inside the viewer it controls`);
  }
  if (!d.volumeIsVertical) {
    failures.push(`at ${d.size} the volume slider did not turn vertical: this browser `
                  + 'honours neither writing-mode nor appearance: slider-vertical on a range '
                  + 'input, and an 18px-wide horizontal slider is unusable');
  }
  if (!d.volumeInsideStage) {
    failures.push(`at ${d.size} the volume slider is outside the viewer`);
  }
  if (d.readoutsBottom > d.viewportHeight) {
    failures.push(`at ${d.size} the readouts end at ${d.readoutsBottom}px, `
                  + `${d.readoutsBottom - d.viewportHeight}px below the ${d.viewportHeight}px `
                  + 'fold: the stage is taking more height than is left over');
  }
  if (d.playBottom > d.viewportHeight) {
    failures.push(`at ${d.size} the Play bar ends at ${d.playBottom}px, below the `
                  + `${d.viewportHeight}px fold: a visitor has to scroll to press Play`);
  }
  if (d.controlRows !== 1) {
    failures.push(`at ${d.size} the control bar wraps to ${d.controlRows} rows`);
  }
  if (!d.controlsFits) {
    failures.push(`at ${d.size} the control bar overflows its container (${d.controlsWidth}px)`);
  }
  if (d.readoutRows !== 1) {
    failures.push(`at ${d.size} the readouts wrap to ${d.readoutRows} rows`);
  }
  // And the structure must still be the subject: a layout that fits by shrinking the stage
  // to a strip has solved the wrong problem.
  if (!(d.stageShare > 0.38)) {
    failures.push(`at ${d.size} the stage is only ${(d.stageShare * 100).toFixed(0)}% of the `
                  + 'viewport; the structure should be the subject');
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
for (const d of withPulldown) {
  if (d.readoutsBottom > d.viewportHeight) {
    failures.push(`at ${d.size} with the ESMFold pulldown open the readouts end at `
                  + `${d.readoutsBottom}px, ${d.readoutsBottom - d.viewportHeight}px below `
                  + `the ${d.viewportHeight}px fold`);
  }
}
console.log(`esmfold mode  pulldown row ${withPulldown[0].rowHeight}px, readouts end at `
            + withPulldown.map(d => `${d.readoutsBottom}/${d.viewportHeight}`).join(', '));
if (!mobile.controlsReachable) failures.push('a control is off the right edge on a phone');
if (mobile.chartCanvases.length !== 2) {
  failures.push(`${mobile.chartCanvases.length} chart canvases on a phone, want 2`);
}
if (!mobile.chartCanvases.every(h => h >= 80)) {
  failures.push(`a chart canvas is ${Math.min(...mobile.chartCanvases)}px tall on a phone: `
                + 'the chart is present but there is nothing in it');
}
if (mobile.badgeOverlapsToggle) {
  failures.push('the engine badge and the music switch overlap on a phone');
}
if (!mobile.footerInsideStage) {
  failures.push('the badge or the music switch is outside the viewer on a phone');
}
if (mobile.readoutRows !== 2 || mobile.readoutColumns !== 4) {
  failures.push(`the readouts are ${mobile.readoutColumns} by ${mobile.readoutRows} on a `
                + 'phone, want 4 by 2');
}

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
console.log('\nPASS');
