/* Does the page actually make sound, in a browser, from a click?
 *
 * The parity test proves the SCORE is right. It says nothing about whether the score
 * reaches an AudioContext, because it never opens one. That gap is exactly the shape of the
 * failure PLAN.md section 10 is built around: two halves of a feature, one complete and
 * authoritative-looking, the other never reached. A sonifier with perfect note-for-note
 * parity that is wired to nothing produces silence and passes every unit test.
 *
 * So this drives the real page in headless Chrome with a fake audio device, clicks Play as
 * a real user gesture, and asserts that the context is running, that notes were scheduled,
 * and that the animation is being driven by the audio clock rather than by itself.
 *
 *   node tests/audio_smoke.mjs [url]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:8007/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'buttfold-audio-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,900',
  // A headless browser has no sound card. Without these an AudioContext is created and
  // never leaves the "suspended" state, which is indistinguishable from a page that forgot
  // to resume it - the exact failure this test hunts for.
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--alsa-output-device=plug:default',
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
  ready = await evaluate(
    '!!(window.buttfoldPlayer && window.buttfoldPlayer.scored && window.buttfoldPlayer.audio)');
  if (ready) break;
}
if (!ready) {
  console.error('the player never produced a score');
  logs.forEach(l => console.error(`  [page] ${l}`));
  chrome.kill();
  process.exit(1);
}

const before = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  return {
    fold: p.fold.id,
    style: p.styleId,
    moments: p.scored.moments.length,
    residueCount: p.residueCount,
    notes: p.scored.moments.reduce((s, m) => s + m.notes.length, 0),
    durationSeconds: p.audio.durationSeconds,
    timeline: p.audio.timeline.length,
    // The figure moved from a line of body text to the transport's tooltip.
    summary: document.getElementById('score-summary').title,
    available: p.audio.available,
  };
})()`);

// `userGesture: true` on Runtime.evaluate makes this a real activation as far as the
// autoplay policy is concerned, which is what an AudioContext requires.
await evaluate(`document.getElementById('play').click()`);
await sleep(2500);

const during = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  return {
    contextState: p.audio.context ? p.audio.context.state : 'no context',
    currentTime: p.audio.context ? p.audio.context.currentTime : 0,
    playing: p.audio.playing,
    position: p.audio.positionSeconds,
    scheduledMoments: p.audio.nextIndex,
    frame: p.index,
    playLabel: document.getElementById('play').textContent,
    note: document.getElementById('audio-note').textContent,
    // The two drawings of the score. Sampled DURING playback, from the same event list the
    // sound is coming from, because that is the only thing that proves they are following
    // the audio clock rather than a frame counter of their own.
    sounding: p.audio.notesSounding(p.audio.positionSeconds, 0.9).length,
    chordsDrawn: p.stage.chordsDrawn,
    litResidues: p.stage.glow ? [...p.stage.glow].filter(v => v > 0.02).length : 0,
    ribbonLit: p.ribbon ? [...p.ribbon.glow].filter(v => v > 0.02).length : 0,
    ribbonCells: p.ribbon ? p.ribbon.residueCount : 0,
  };
})()`);

// Style switching must keep its place rather than restart: a fold that reached its cadence
// must not be sent back to the opening chord.
await evaluate(`document.querySelector('#style-mode button[data-style="jazz"]').click()`);
await sleep(1200);
const afterStyle = await evaluate(`(() => {
  const p = window.buttfoldPlayer;
  return { style: p.styleId, position: p.audio.positionSeconds, playing: p.audio.playing,
           notes: p.scored.moments.reduce((s, m) => s + m.notes.length, 0) };
})()`);

/* Can this machine drive an audio clock at all?
 *
 * A bare AudioContext, in the same browser, with none of ButtFold in it. Measured because a
 * stalled clock and a broken sonifier look identical from the outside: the context reports
 * "running" either way and `currentTime` does not move. On this Mac, on 2026-09-01, a bare
 * context advanced 0.005 s in 2 s - one render quantum, which is what you get when the
 * render thread is created and then never driven - and the app's own gate had been reporting
 * that as "the audio clock advanced only 0.01 s in 2.5 s", which reads as ButtFold's fault
 * and is not. The clock assertions are skipped when this says so; everything else still
 * runs, so a real regression in the scoring is still caught. */
const clockProbe = await evaluate(`(async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const t0 = ctx.currentTime;
  await new Promise(r => setTimeout(r, 1500));
  const advanced = ctx.currentTime - t0;
  const state = ctx.state;      // read BEFORE closing, or it always reports "closed"
  ctx.close();
  return { state, advanced, sampleRate: ctx.sampleRate };
})()`);
const clockWorks = clockProbe.advanced > 0.5;
console.log(`clock probe   a bare AudioContext advanced `
            + `${clockProbe.advanced.toFixed(3)} s in 1.5 s`
            + (clockWorks ? '' : '  <- this browser has no audio clock'));

chrome.kill();

console.log(`fold          ${before.fold}, style ${before.style}`);
console.log(`score         ${before.moments} moments, ${before.notes.toLocaleString()} notes, `
            + `${before.durationSeconds.toFixed(1)} s`);
console.log(`summary line  "${before.summary}"`);
console.log(`context       ${during.contextState}, clock at ${during.currentTime.toFixed(2)} s`);
console.log(`after 2.5 s   position ${during.position.toFixed(2)} s, frame ${during.frame}, `
            + `${during.scheduledMoments} moments scheduled`);
console.log(`drawn         ${during.sounding} notes sounding, ${during.chordsDrawn} chords, `
            + `${during.litResidues} residues lit, ribbon ${during.ribbonLit}/${during.ribbonCells}`);
console.log(`style switch  ${before.style} -> ${afterStyle.style}, `
            + `position ${afterStyle.position.toFixed(2)} s, ${afterStyle.notes.toLocaleString()} notes`);
if (logs.length) logs.forEach(l => console.log(`  [page] ${l}`));

const failures = [];
if (!before.available) failures.push('the page reports no Web Audio at all');
if (!(before.moments > 10)) failures.push(`only ${before.moments} moments in the score`);
if (!(before.notes > 500)) failures.push(`only ${before.notes} notes in the score`);
if (!(before.durationSeconds > 20 && before.durationSeconds < 90)) {
  failures.push(`the piece is ${before.durationSeconds.toFixed(0)} s, nowhere near the 45 s target`);
}
if (!before.summary.includes('notes')) failures.push('the score summary line is empty');
if (during.contextState !== 'running') {
  failures.push(`the AudioContext is "${during.contextState}" after clicking Play: the score `
                + 'is correct and reaches no audio device');
}
if (!during.playing) failures.push('the audio engine is not playing after Play');
if (!(during.scheduledMoments > 0)) failures.push('no moments were scheduled');
// Everything below here needs a clock that moves, so it is asserted only where one does.
if (clockWorks) {
  if (!(during.position > 1.0)) {
    failures.push(`the audio clock advanced only ${during.position.toFixed(2)} s in 2.5 s`);
  }
  if (!(during.frame > 0)) {
    failures.push('the animation never advanced, so it is not following the audio clock');
  }
}
if (during.playLabel !== 'Pause') failures.push(`the button says "${during.playLabel}"`);
// The score drawn, not just heard. These only mean anything while the clock is moving, so
// they sit behind the same probe as the other timing assertions.
if (clockWorks) {
  if (!(during.sounding > 0)) {
    failures.push('nothing was sounding mid-playback, so neither drawing had anything to do');
  }
  if (!(during.chordsDrawn > 0)) {
    failures.push(`${during.sounding} notes were sounding and no chords were struck between `
                  + 'their residues');
  }
  if (!(during.litResidues > 0)) {
    failures.push('no residue was lit on the structure while notes were sounding');
  }
  if (during.ribbonCells !== before.residueCount) {
    failures.push(`the ribbon has ${during.ribbonCells} cells for a `
                  + `${before.residueCount} residue protein`);
  }
  if (!(during.ribbonLit > 0)) {
    failures.push('the residue ribbon lit nothing while notes were sounding');
  }
}
if (during.note) failures.push(`the page reported an audio problem: ${during.note}`);
if (afterStyle.style !== 'jazz') failures.push('the style pill did not switch');
if (clockWorks && !(afterStyle.position >= during.position)) {
  failures.push(`switching style sent playback backwards, from ${during.position.toFixed(2)} s `
                + `to ${afterStyle.position.toFixed(2)} s: that is a restart, which a listener hears`);
}
if (logs.some(l => l.startsWith('EXCEPTION'))) failures.push('the page threw');

if (failures.length) {
  console.error('\nFAIL');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
if (!clockWorks) {
  console.log('\nPASS, with the clock assertions SKIPPED: this browser reported an '
              + 'AudioContext in state "' + clockProbe.state + '" whose time did not move, '
              + 'with no page of ours loaded. The score, the scheduling and the transport '
              + 'were all checked; playback speed and the animation following it were not.');
} else {
  console.log('\nPASS');
}
