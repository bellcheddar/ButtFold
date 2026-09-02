/* What is sounding right now, and the two drawings that read it.
 *
 * The whole point of `notesSounding` is that it is a QUERY on the timeline rather than a
 * callback from the scheduler, so it is testable without an audio device - which is just as
 * well, because this Mac's headless Chrome currently has no audio clock at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FoldAudio } from '../static/js/audio.js';
import { ResidueRibbon } from '../static/js/ribbon.js';

/** Two moments, the second of which carries a contact flurry running past its own beat. */
function score() {
  const note = (voice, residue, partner, beatOffset, velocity, duration = 1) => ({
    voice, residue, partner, beatOffset, duration, note: { pitch: 60, velocity },
  });
  return [
    { tempo: 60, beats: 1, notes: [note('pad', 3, null, 0, 127, 4)] },
    { tempo: 60, beats: 1, notes: [
      note('contact', 10, 40, 0, 64),
      note('contact', 11, 41, 0.25, 64),
      // Two beats past a one-beat moment: a flurry outlives its own bar, which is why the
      // event list has to be sorted rather than assumed to be in order.
      note('bass', 12, 42, 2.0, 127, 2),
    ] },
  ];
}

function loaded() {
  const audio = new FoldAudio();
  audio.loadScore(score(), { name: 'test' }, () => null);
  return audio;
}

test('every note in the piece is laid out on one sorted timeline', () => {
  const audio = loaded();
  assert.equal(audio.events.length, 4);
  for (let i = 1; i < audio.events.length; i++) {
    assert.ok(audio.events[i].at >= audio.events[i - 1].at,
              'the events are not in time order, so a binary search over them is wrong');
  }
  // At 60 BPM a beat is a second: moment 1 starts at 0, moment 2 at 1, and the flurry's
  // last note is two beats into the second moment.
  assert.deepEqual(audio.events.map(e => Math.round(e.at * 100) / 100), [0, 1, 1.25, 3]);
});

test('velocity arrives as a fraction, because everything downstream is an opacity', () => {
  const audio = loaded();
  for (const event of audio.events) {
    assert.ok(event.velocity > 0 && event.velocity <= 1, `velocity ${event.velocity}`);
  }
  assert.equal(audio.events[0].velocity, 1);
});

test('a note is drawn for the longer of its own length and the minimum tail', () => {
  const audio = loaded();
  const at1 = audio.notesSounding(1.05, 0.9);
  assert.equal(at1.length, 2, 'the held pad and the fresh contact should both be sounding');

  // The pad is four beats at 60 BPM, so four seconds: a fixed tail would have taken the
  // light off it a tenth of a second ago, while it is plainly still audible.
  const pad = at1.find(e => e.voice === 'pad');
  assert.ok(Math.abs(pad.age - 1.05 / 4) < 1e-9, `pad age ${pad.age}`);

  // The contact is one beat, so one second, which already beats the 0.9 floor.
  const contact = at1.find(e => e.residue === 10);
  assert.ok(Math.abs(contact.age - 0.05) < 1e-9, `contact age ${contact.age}`);

  // And a semiquaver gets the floor rather than 60 ms of visibility.
  const short = new FoldAudio();
  short.loadScore([{ tempo: 60, beats: 1, notes: [{
    voice: 'contact', residue: 1, partner: 2, beatOffset: 0, duration: 0.06,
    note: { pitch: 60, velocity: 100 } }] }], {}, () => null);
  assert.equal(short.notesSounding(0.5, 0.9).length, 1);
  assert.equal(short.notesSounding(0.95, 0.9).length, 0);
});

test('everything has stopped sounding once the piece is over', () => {
  const audio = loaded();
  assert.equal(audio.notesSounding(20, 0.9).length, 0);
});

test('nothing sounds before the piece starts, and querying an empty score is safe', () => {
  assert.deepEqual(new FoldAudio().notesSounding(3, 0.9), []);
  assert.deepEqual(loaded().notesSounding(-1, 0.9), []);
});

/* A canvas the ribbon can be built against without a browser. It only ever needs a 2D
 * context that accepts calls, because what is under test is which cells it decides to
 * light, not the pixels it paints. */
function stubCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_t, key) => (key === 'canvas' ? {} : (...args) => calls.push([key, args])),
    set: () => true,
  });
  return { clientWidth: 400, clientHeight: 34, width: 0, height: 0,
           getContext: () => ctx, calls };
}

test('the ribbon lights every voice, not only the contacts', () => {
  const audio = loaded();
  const ribbon = new ResidueRibbon(stubCanvas());
  ribbon.setStructure('C'.repeat(50));
  ribbon.setSounding(audio.notesSounding(1.0, 0.9));

  // The pad note is residue 3 with no partner; the contact is 10 paired with 40.
  assert.ok(ribbon.glow[3] > 0, 'a pad note did not light its residue');
  assert.ok(ribbon.glow[10] > 0, 'a contact did not light its residue');
  assert.ok(ribbon.glow[40] > 0, 'a contact did not light its partner');
  assert.ok(ribbon.glow[40] < ribbon.glow[10],
            'both ends of a contact were lit equally; the partner should be the quieter');
  assert.equal(ribbon.glow[7], 0);
});

test('a residue past the end of the chain is ignored rather than written past the array', () => {
  const ribbon = new ResidueRibbon(stubCanvas());
  ribbon.setStructure('CCC');
  ribbon.setSounding([{ residue: 99, partner: -4, age: 0, velocity: 1, voice: 'contact' }]);
  assert.equal(ribbon.glow.length, 3);
  assert.ok([...ribbon.glow].every(v => v === 0));
});

test('the glow decays to nothing over the tail', () => {
  const ribbon = new ResidueRibbon(stubCanvas());
  ribbon.setStructure('C'.repeat(20));
  const event = (age) => [{ residue: 5, partner: null, age, velocity: 1, voice: 'pad' }];
  ribbon.setSounding(event(0));    const fresh = ribbon.glow[5];
  ribbon.setSounding(event(0.5));  const half = ribbon.glow[5];
  ribbon.setSounding(event(1));    const gone = ribbon.glow[5];
  assert.ok(fresh > half && half > gone, 'the decay is not monotone');
  assert.equal(fresh, 1);
  assert.equal(gone, 0);
});

test('setSounding replaces rather than accumulates', () => {
  const ribbon = new ResidueRibbon(stubCanvas());
  ribbon.setStructure('C'.repeat(20));
  ribbon.setSounding([{ residue: 5, partner: null, age: 0, velocity: 1, voice: 'pad' }]);
  ribbon.setSounding([{ residue: 6, partner: null, age: 0, velocity: 1, voice: 'pad' }]);
  assert.equal(ribbon.glow[5], 0, 'the previous frame\'s note is still lit');
  assert.equal(ribbon.glow[6], 1);
});

/* ------------------------------------------------------------------ the watchdog -------
 *
 * A context that reports "running" and produces silence is the failure this exists for, so
 * the states are exercised against a stub rather than against a real device: the point is
 * what the page SAYS, and none of these conditions can be provoked on demand in a browser.
 */
function withContext(state, clock = () => 0) {
  const audio = new FoldAudio();
  audio.context = { get state() { return state; }, get currentTime() { return clock(); } };
  return audio;
}

test('a context that is not running is reported rather than left silent', () => {
  assert.match(withContext('suspended').diagnose(), /suspended/);
  // `interrupted` is Safari's, it is not in the spec, and no catch will ever see it.
  assert.match(withContext('interrupted').diagnose(), /Safari/);
  assert.equal(withContext('running').diagnose(), null, 'a healthy context should say nothing');
});

test('a running context whose clock does not move is reported', () => {
  let wall = Date.now();
  const audio = withContext('running', () => 0.005);
  audio.playing = true;
  assert.equal(audio.diagnose(), null, 'it must not complain before it has watched for a while');
  // Wind the wall clock past the half second the watchdog waits for.
  audio._clockSeenWall = wall - 900;
  assert.match(audio.diagnose(), /not running its clock/);
});

test('a running context whose clock advances is left alone', () => {
  let t = 0;
  const audio = withContext('running', () => t);
  audio.playing = true;
  audio.diagnose();
  audio._clockSeenWall = Date.now() - 900;
  t = 1.2;
  assert.equal(audio.diagnose(), null);
});

test('nothing is diagnosed before there is a context at all', () => {
  assert.equal(new FoldAudio().diagnose(), null);
});
