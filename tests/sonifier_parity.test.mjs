/* Does the browser play the same piece as the phone?
 *
 * The Phase 2 exit gate. `tests/fixtures/score/*.json` was produced by PhoneFold's OWN
 * `FoldAudio.Sonifier`, compiled from PhoneFoldKit at commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, run over ButtFold's committed baked gallery
 * (tools/swift_score_dump/run.sh). This asserts that `Sonifier.js` produces the same score
 * note for note: voice, pitch, velocity, residue, partner, beat offset and duration, for
 * every note of two folds in all five styles.
 *
 * A JS sonifier tested against a JS fixture proves only that it has not changed. Tested
 * against the shipped Swift it proves the thing PLAN actually requires: someone who plays
 * with ButtFold and then downloads PhoneFold hears the same music.
 *
 *   node --test tests/sonifier_parity.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { score, swung, compaction, velocity, timbre, pacing } from '../static/js/Sonifier.js';
import { runLengthDecode } from '../static/js/PSEA.js';
import { SequenceSeed, MusicalScale, PitchLayer } from '../static/js/MusicalScale.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCORES = join(REPO, 'tests/fixtures/score');
const STYLES = join(REPO, 'static/styles');
const GALLERY = join(REPO, 'static/baked/gallery.json');

const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));

function loadFold(id) {
  const gallery = readJSON(GALLERY);
  const fold = gallery.folds.find(f => f.id === id);
  assert.ok(fold, `no baked fold ${id}`);
  // The player expands the run-length secondary structure once per fold rather than per
  // frame; the sonifier is handed the expanded form, so the test does the same.
  return { ...fold, frames: fold.frames.map(f => ({ ...f, ssExpanded: runLengthDecode(f.ss) })) };
}

test('the Swift reference scores exist and cover every style', () => {
  assert.ok(existsSync(join(SCORES, 'index.json')),
            'missing reference scores - run tools/swift_score_dump/run.sh');
  const { cases } = readJSON(join(SCORES, 'index.json'));
  const styles = readdirSync(STYLES).filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', '')).sort();
  const covered = [...new Set(cases.map(c => c.style))].sort();
  assert.deepEqual(covered, styles,
                   'the reference dump does not cover every shipped style');
  assert.ok(cases.length >= 10, `only ${cases.length} reference scores`);
});

test('Sonifier.js reproduces PhoneFold note for note', () => {
  const { cases } = readJSON(join(SCORES, 'index.json'));
  let totalNotes = 0;

  for (const entry of cases) {
    const reference = readJSON(join(SCORES, entry.file));
    const style = readJSON(join(STYLES, `${entry.style}.json`));
    const fold = loadFold(entry.fold);
    const label = `${entry.fold}/${entry.style}`;

    assert.equal(fold.sequence, reference.sequence, `${label}: sequence`);

    const produced = score(fold, style);
    assert.equal(produced.pacing.readoutsPerMoment, reference.readoutsPerMoment,
                 `${label}: readouts per moment`);
    assert.ok(Math.abs(produced.pacing.beatsPerMoment - reference.beatsPerMoment) < 1e-9,
              `${label}: beats per moment`);
    assert.equal(produced.moments.length, reference.moments.length,
                 `${label}: moment count`);

    reference.moments.forEach((expected, m) => {
      const got = produced.moments[m];
      const where = `${label} moment ${m} (frame ${expected.frameIndex})`;
      assert.equal(got.frameIndex, expected.frameIndex, `${where}: frame index`);
      assert.equal(got.degree, expected.degree, `${where}: degree`);
      assert.equal(got.isCadence, expected.isCadence, `${where}: cadence`);
      assert.equal(got.isModulation, expected.isModulation, `${where}: modulation`);
      assert.equal(got.droppedContacts, expected.droppedContacts, `${where}: dropped`);
      assert.equal(got.establishedContacts, expected.establishedContacts,
                   `${where}: established`);
      // Continuous quantities: compared to a tolerance, because Swift computes these in
      // Float and JS in double even where the inputs are identical. 1e-4 relative is far
      // below anything audible and far above the precision gap.
      close(got.tempo, expected.tempo, `${where}: tempo`);
      close(got.compaction, expected.compaction, `${where}: compaction`);
      close(got.beats, expected.beats, `${where}: beats`);
      close(got.timbre.cutoff, expected.cutoff, `${where}: cutoff`);
      close(got.timbre.detuneCents, expected.detuneCents, `${where}: detune`);
      close(got.timbre.reverb, expected.reverb, `${where}: reverb`);

      assert.equal(got.notes.length, expected.notes.length, `${where}: note count`);
      expected.notes.forEach((want, n) => {
        const have = got.notes[n];
        const at = `${where} note ${n}`;
        // Discrete and exact. These are the things a listener hears as a wrong note.
        assert.equal(have.voice, want.voice, `${at}: voice`);
        assert.equal(have.note.pitch, want.pitch, `${at}: pitch`);
        assert.equal(have.note.velocity, want.velocity, `${at}: velocity`);
        assert.equal(have.residue, want.residue, `${at}: residue`);
        assert.equal(have.partner ?? null, want.partner ?? null, `${at}: partner`);
        close(have.beatOffset, want.beatOffset, `${at}: beat offset`);
        close(have.duration, want.duration, `${at}: duration`);
        totalNotes++;
      });
    });
  }
  // A test that compared zero notes would pass every assertion above.
  assert.ok(totalNotes > 10_000, `only ${totalNotes} notes compared`);
});

function close(got, want, message) {
  const tolerance = Math.max(1e-4 * Math.abs(want), 1e-6);
  assert.ok(Math.abs(got - want) <= tolerance,
            `${message}: ${got} vs ${want} (tolerance ${tolerance})`);
}

test('the score is deterministic and seekable', () => {
  const fold = loadFold('trp_cage');
  const style = readJSON(join(STYLES, 'fantasy.json'));
  const a = score(fold, style), b = score(fold, style);
  assert.equal(JSON.stringify(a.moments), JSON.stringify(b.moments),
               'two runs of the same fold produced different scores');

  // Seekable: the voicing for a frame is derived from the frame's POSITION, not from a
  // stream advanced frame by frame, so scrubbing to a frame gives the same chord as
  // playing to it. A single advancing stream would make these differ.
  const seed = new SequenceSeed(fold.sequence);
  for (const position of [0, 7, 74, 149]) {
    assert.equal(seed.stream(position).uniform(), seed.stream(position).uniform(),
                 `stream at ${position} is not reproducible`);
  }
  const values = [0, 1, 2, 3].map(p => seed.stream(p).uniform());
  assert.equal(new Set(values).size, values.length,
               'consecutive positions produced identical streams');
});

test('the same protein always yields the same piece, and different ones do not', () => {
  assert.equal(new SequenceSeed('MQIFVKTLTGK').value, new SequenceSeed('mqifvktltgk').value,
               'the seed is case sensitive');
  assert.notEqual(new SequenceSeed('MQIFVKTLTGK').value, new SequenceSeed('MQIFVKTLTGA').value,
                  'one substitution did not change the seed');
  // FNV-1a over an empty string is the offset basis, which is non-zero, so the
  // zero-guard is not what makes this non-degenerate.
  assert.equal(new SequenceSeed('').value, 0xcbf29ce484222325n);
});

test('the musical primitives behave at the edges', () => {
  const scale = new MusicalScale(57, 'minor');
  assert.equal(scale.pitch(0), 57, 'the tonic');
  assert.equal(scale.pitch(7), 69, 'degree 7 is the tonic an octave up');
  // Degree -1 must land on the seventh below, not back on the tonic. Truncating division
  // gets this wrong and flattens the register contrast that long-range contacts depend on.
  assert.equal(scale.pitch(-1), 55, 'degree -1 is the seventh below');
  assert.equal(scale.pitch(-7), 45, 'degree -7 is the tonic an octave down');
  assert.ok(scale.pitch(-200) >= 0 && scale.pitch(200) <= 127, 'pitch stays in MIDI range');

  assert.equal(velocity(0), 30, 'a zero-confidence note is audible, not silent');
  assert.equal(velocity(100), 120);
  assert.ok(velocity(50) > 30 && velocity(50) < 120);

  // Swing: at 0 it is the identity; at 1/3 the offbeat eighth lands on 2/3 of the beat.
  assert.equal(swung(0.5, 0), 0.5);
  assert.ok(Math.abs(swung(0.5, 1 / 3) - (0.5 + (1 / 3) * 0.5)) < 1e-12);
  // And the warp is applied to every subdivision, not only the offbeat: a semiquaver in
  // the first half of the beat must move too, or a contact flurry runs straight across a
  // swung bar and sounds like two pieces at once.
  assert.ok(swung(0.25, 1 / 3) > 0.25, 'the semiquaver did not move under swing');
  assert.equal(swung(1.0, 1 / 3), 1.0, 'the downbeat moved');

  // Compaction is normalised by chain length, so a miniprotein is not permanently compact.
  // Compared to a tolerance because compaction frounds its input to Float32 first, matching
  // the Swift's `Float` radius of gyration, so the exact native Rg lands a few ulps off 1.
  assert.equal(compaction(1.927 * Math.pow(76, 0.598), 76), 0, 'denatured Rg is not 0');
  assert.ok(Math.abs(compaction(2.2 * Math.pow(76, 0.38), 76) - 1) < 1e-6,
            'native Rg is not 1');
  // Normalisation is the point: the same Rg means different things at different lengths.
  assert.ok(compaction(12, 20) < compaction(12, 300),
            '12 A reads the same for a miniprotein and a 300-residue chain');
  assert.ok(compaction(0, 76) === 0 && compaction(NaN, 76) === 0, 'bad Rg is not guarded');

  const murky = timbre(0), open = timbre(100);
  assert.ok(open.cutoff > murky.cutoff * 20, 'confidence does not open the filter');
  assert.ok(murky.detuneCents > open.detuneCents, 'low confidence is not detuned');
  assert.ok(murky.reverb > open.reverb, 'low confidence is not washed out');

  // The pitch layer must be a real ranking, not a constant.
  const layer = new PitchLayer(scale, ['R', 'K', 'D', 'E']);
  const degrees = new Set(Object.keys({ I: 0, L: 0, K: 0, R: 0, G: 0, W: 0 })
    .map(code => layer.degree(code)));
  assert.ok(degrees.size > 1, 'every residue maps to the same degree');
  assert.ok(layer.pitch('R', 0) > layer.pitch('X', 0), 'the octave-shift residue did not lift');
});

test('the pacing lands near the target duration', () => {
  const style = readJSON(join(STYLES, 'fantasy.json'));
  const midTempo = (style.tempoSlow + style.tempoFast) / 2;
  for (const readouts of [8, 32, 150, 180, 600]) {
    const plan = pacing(readouts, style);
    const seconds = plan.moments * plan.beatsPerMoment * 60 / midTempo;
    assert.ok(plan.readoutsPerMoment >= 1 && plan.moments >= 1, `${readouts}: degenerate pacing`);
    assert.ok(plan.beatsPerMoment >= 0.5 && plan.beatsPerMoment <= 4,
              `${readouts}: ${plan.beatsPerMoment} beats per moment is outside the clamp`);
    // A short trajectory cannot reach 45 s without stretching a moment past a bar, which is
    // clamped, so the floor is what the clamp allows rather than the target.
    if (readouts >= 150) {
      assert.ok(Math.abs(seconds - 45) < 12,
                `${readouts} readouts gives a ${seconds.toFixed(0)} s piece`);
    }
  }
});
