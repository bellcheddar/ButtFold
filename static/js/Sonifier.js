/* Turns a folding trajectory into music.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldAudio/Sonifier.swift`, commit
 * 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, and held to note-for-note agreement with the
 * shipped Swift by tests/sonifier_parity.test.mjs: pitch, velocity, beat, voice, residue,
 * for every note of two folds in all five styles.
 *
 * PLAN's core table, row for row. The whole argument is that the music comes from the
 * TRAJECTORY and not from the sequence, so the mapping has to be defensible and audible:
 *
 *   | Trajectory feature            | Musical parameter                 | Where            |
 *   | New contact event             | Note onset; separation sets register | contactNotes  |
 *   | Long-range hydrophobic contact| Bass note                         | contactNotes     |
 *   | Helix content                 | Sustained pad, stacked fourths    | padNotes         |
 *   | Sheet content                 | Staccato interlocking figure      | rhythmNotes      |
 *   | Coil content                  | Arpeggiation between chord tones  | arpeggioNotes    |
 *   | Mean confidence               | Low-pass cutoff, detune, reverb   | timbre           |
 *   | Per-residue confidence        | Note velocity for that residue    | velocity         |
 *   | Radius of gyration            | Tempo and register                | compaction       |
 *   | Convergence                   | Cadence, resolving to the tonic   | PlateauDetector  |
 *
 * **What "confidence" means depends on the engine, and this is honest about it.** For the
 * Gō model it is the fraction of native contacts a residue has formed, which is real
 * per-residue information: the hydrophobic core locks in first and completely while the
 * termini are still loose, and the murky-and-out-of-tune effect therefore means something.
 * The consequence PLAN wants in the copy follows directly: a region that never resolves
 * stays a detuned wash for the whole piece.
 *
 * **Float32 is emulated with Math.fround wherever the Swift uses `Float`.** That is not
 * pedantry. Mean confidence accumulates over 76 residues in single precision on the phone;
 * computing the same mean in a double gives a value a few ulps away, and it reaches the
 * output through `velocity` (30 + 90q, truncated) and through the plateau detector's
 * tolerance, where a few ulps is the difference between cadencing on this bar or the next.
 * Every fround call below marks a place the Swift is single-precision.
 */

import {
  MIDINote, MusicalScale, PitchLayer, SequenceSeed,
  CONTACT_RANGE, contactRange, isHydrophobic,
} from './MusicalScale.js';

const f32 = Math.fround;

/** Mean of an array in Float32, accumulating the way Swift's `reduce(0, +)` does. */
function meanFloat32(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum = f32(sum + f32(v));
  return f32(sum / f32(values.length));
}

export const VOICES = ['contact', 'pad', 'rhythm', 'arpeggio', 'bass'];
// Swift sorts by `Voice.rawValue`, a String, so ties in the note sort break alphabetically
// and not in declaration order. Getting this wrong reorders simultaneous notes, which is
// inaudible and fails parity, and it is exactly the sort of thing that would be "fixed" by
// loosening the test.
const VOICE_ORDER = [...VOICES].sort();
const voiceRank = v => VOICE_ORDER.indexOf(v);

export const BEATS_PER_BAR = 4.0;
/* One beat per raw readout, not one bar, and that is measured rather than chosen for
 * tidiness: at one bar each, a 180-readout fold is an eight-minute piece over an animation
 * played in twelve seconds. */
export const BEATS_PER_MOMENT = 1.0;
/* Four bars. Below that a trajectory does not produce a phrase, it produces a gesture. */
const MINIMUM_BEATS = 16.0;
/* Marc's call: about forty-five seconds. */
export const TARGET_SECONDS = 45.0;
/* The gap between contacts in a flurry, in beats. Semiquavers. */
const CONTACT_SPACING = 0.25;
/* The most contacts that can sound in one bar. Measured across the three engines:
 * structure-based p90 = 6 to 16 and p99 = 10 to 24. Sixteen leaves better than nine bars in
 * ten whole, and spread across four beats it is a run rather than a cluster. Overflow is
 * COUNTED into droppedContacts, never discarded quietly. */
const MAXIMUM_CONTACT_NOTES = 16;
/* Four to a beat is semiquavers, as fast as the arpeggio can articulate at top tempo. */
const MAXIMUM_TEXTURE_NOTES = 4;

/* Octave offsets relative to the style's own root octave. Separation sets register: local
 * high, long-range low. */
const RANGE_OCTAVE = { [CONTACT_RANGE.local]: 1, [CONTACT_RANGE.medium]: 0,
                       [CONTACT_RANGE.longRange]: -1 };
const BASS_OCTAVE = -2;     // long-range hydrophobic contacts are core packing
const PAD_OCTAVE = 0;
const RHYTHM_OCTAVE = 1;
const ARPEGGIO_OCTAVE = 1;

/** Per-residue confidence to note velocity.
 *
 * Floored at 30 rather than 1: a note that is inaudible has not been played, and the point
 * of sounding a low-confidence residue is that it is heard *and* sounds wrong. */
export function velocity(confidence) {
  const q = Math.min(Math.max(f32(confidence) / 100, 0), 1);
  return Math.trunc(30 + 90 * q);
}

/** Mean confidence to cutoff, detune and reverb.
 *
 * Exponential cutoff because brightness is perceived in ratios: a linear sweep from the
 * floor would spend most of its travel in a range that already sounds bright. The floor is
 * 500 Hz rather than 300 because a one-pole filter is only 6 dB per octave, and at 300 Hz a
 * note is not dull, it is absent. */
export function timbre(meanConfidence) {
  const q = Math.min(Math.max(f32(meanConfidence) / 100, 0), 1);
  return {
    cutoff: 500 * Math.pow(28, q),      // 500 Hz murky, 14 kHz open
    detuneCents: 35 * (1 - q),          // a third of a semitone at worst
    reverb: 0.60 - 0.45 * q,            // a wash, drying to a room
  };
}

/**
 * How compact the chain is: 0 at the denatured radius of gyration, 1 at the native one.
 *
 * Both reference radii are measured scaling laws, not guesses:
 *   denatured       Rg = 1.927 N^0.598  (Kohn et al., PNAS 2004, 101(34):12491)
 *   native globular Rg = 2.2   N^0.38   (Flory scaling as fitted by Dima and Thirumalai,
 *                                        J. Phys. Chem. B 2004, 108(21):6564)
 *
 * Normalising by chain length matters: without it a 20-residue miniprotein reads as
 * permanently compact and a 300-residue one as permanently extended, and the accelerando
 * becomes a property of the protein's size rather than of its folding.
 */
export function compaction(radiusOfGyration, residueCount) {
  const rg = f32(radiusOfGyration);
  if (!(residueCount > 1) || !Number.isFinite(rg) || !(rg > 0)) return 0;
  const n = residueCount;
  const denatured = 1.927 * Math.pow(n, 0.598);
  const native = 2.2 * Math.pow(n, 0.38);
  if (!(denatured > native)) return 0;
  return Math.min(Math.max((denatured - rg) / (denatured - native), 0), 1);
}

/**
 * Where a beat position lands once the style's swing is applied.
 *
 * A piecewise-linear warp of each beat: the first half stretched, the second compressed, so
 * the pivot between them moves late. **The whole beat is warped rather than the offbeat
 * moved.** Delaying notes at 0.5 would swing the eighths and leave the semiquavers between
 * them straight, so a contact flurry would run in even sixteenths across a swung bar and
 * sound like two pieces at once.
 */
export function swung(beat, swing) {
  if (!(swing > 0) || !Number.isFinite(beat)) return beat;
  const amount = Math.min(Math.max(swing, 0), 0.5);
  const whole = Math.floor(beat);
  const within = beat - whole;
  const pivot = 0.5;
  const moved = 0.5 + amount * 0.5;
  const warped = within < pivot
    ? within / pivot * moved
    : moved + (within - pivot) / (1 - pivot) * (1 - moved);
  return whole + warped;
}

/** How many notes a texture voice places for a given content fraction. */
function textureCount(fraction) {
  if (!(fraction > 0)) return 0;
  // Swift's `.rounded()` is half-away-from-zero; JS Math.round is half-up, which differs
  // for negatives only. Fractions here are non-negative, so they agree.
  const n = Math.round(f32(fraction) * MAXIMUM_TEXTURE_NOTES);
  // Any content at all sounds at least once: rounding a small fraction to zero would make
  // a two-residue strand silent, and silence reads as "no sheet" rather than "a little".
  return Math.min(Math.max(n, 1), MAXIMUM_TEXTURE_NOTES);
}

/** `count` indices spread evenly across a list, repeating only if it is shorter. */
function spread(indices, count) {
  if (!indices.length || count <= 0) return [];
  if (indices.length <= count) {
    return Array.from({ length: count }, (_, i) => indices[i % indices.length]);
  }
  const step = indices.length / count;
  return Array.from({ length: count },
                    (_, i) => indices[Math.min(Math.trunc(i * step), indices.length - 1)]);
}

/**
 * Detects the confidence plateau that PLAN calls convergence.
 *
 * A sliding window over the raw frames' mean confidence: converged when the window's whole
 * SPAN sits inside the tolerance. A span rather than a slope, because a trajectory that
 * oscillates around a flat mean has a slope near zero and is plainly not converged.
 *
 * The floor exists because below it a flat confidence means the structure never got
 * anywhere rather than that it arrived, and a piece should not cadence onto a chain that
 * stayed a coil.
 */
export class PlateauDetector {
  constructor(window = 6, tolerance = 1.5, floor = 50) {
    this.window = Math.max(window, 2);
    this.tolerance = tolerance;
    this.floor = floor;
    this.recent = [];
  }

  update(value) {
    if (!Number.isFinite(value)) return false;
    this.recent.push(value);
    if (this.recent.length > this.window) {
      this.recent.splice(0, this.recent.length - this.window);
    }
    if (this.recent.length !== this.window) return false;
    const low = Math.min(...this.recent), high = Math.max(...this.recent);
    return (high - low) <= this.tolerance && high >= this.floor;
  }
}

/** How a trajectory of a given length is laid out in musical time.
 *
 * Two knobs rather than one, because one is too coarse. Readouts are grouped into moments so
 * a long trajectory does not become a long piece, then each moment's length in beats is
 * trimmed so the result lands on the target rather than on whatever the integer grouping
 * happened to give. */
export function pacing(readouts, style, targetSeconds = TARGET_SECONDS) {
  if (!(readouts > 0)) {
    return { readoutsPerMoment: 1, beatsPerMoment: BEATS_PER_MOMENT, moments: 0 };
  }
  const tempo = (style.tempoSlow + style.tempoFast) / 2;
  const targetBeats = Math.max(targetSeconds * tempo / 60, MINIMUM_BEATS);
  const group = Math.max(Math.round(readouts / targetBeats), 1);
  const moments = Math.ceil(readouts / group);
  // Clamped: a very short trajectory would ask for a nine-beat moment, and a moment longer
  // than a bar has no musical shape. A very long one would ask for a fraction of a beat,
  // and the texture voices cannot articulate four notes inside a third of one.
  const beats = Math.min(Math.max(targetBeats / moments, 0.5), 4);
  return { readoutsPerMoment: group, beatsPerMoment: beats, moments };
}

export class Sonifier {
  /**
   * @param style    a decoded style JSON, unchanged from the app's own file
   * @param sequence the protein's one-letter sequence
   */
  constructor(style, sequence, { beatsPerMoment = BEATS_PER_MOMENT,
                                 readoutsPerMoment = 1, seed = null,
                                 plateau = null } = {}) {
    this.style = style;
    this.sequence = sequence;
    this.residues = Array.from(sequence);
    this.seed = seed ?? new SequenceSeed(sequence);
    this.scale = new MusicalScale(style.root, style.mode);
    this.pitchLayer = new PitchLayer(this.scale, style.octaveShiftResidues ?? []);
    this.beatsPerMoment = Math.max(beatsPerMoment, 0.05);
    this.readoutsPerMoment = Math.max(readoutsPerMoment, 1);

    this.chordIndex = 0;
    this.hasEstablished = false;
    this.hasCadenced = false;
    this.readoutsSinceMoment = 0;
    this.carriedContacts = [];
    // The plateau is a RATE of change, and grouping changes how much trajectory a window
    // covers: six moments of two readouts is twelve readouts, so the same rate must allow
    // twice the span. Leaving the tolerance alone stopped a morph resolving at all;
    // shrinking the window instead let a Genie 2 run cadence, which a generative sample
    // must never do, having nothing to converge on.
    this.plateau = plateau
      ?? new PlateauDetector(6, 1.5 * Math.max(this.readoutsPerMoment, 1));
  }

  residue(index) {
    return index >= 0 && index < this.residues.length ? this.residues[index] : 'X';
  }

  static confidenceAt(index, frame) {
    return index >= 0 && index < frame.confidence.length
      ? frame.confidence[index] : frame.meanConfidence;
  }

  /**
   * The music for one frame, or null if the frame is not a musical event.
   *
   * @param frame {index, confidence[], meanConfidence, ss, radiusOfGyration,
   *               residueCount, newContacts[[i,j]]}
   */
  moment(frame) {
    if (!(frame.residueCount > 0)) return null;

    // Several readouts can share one moment. Their contacts ACCUMULATE: grouping must not
    // lose events, only gather them, and the moment finally emitted carries every contact
    // its readouts saw.
    this.carriedContacts.push(...frame.newContacts);
    this.readoutsSinceMoment += 1;
    if (this.readoutsSinceMoment < this.readoutsPerMoment) return null;
    this.readoutsSinceMoment = 0;
    const contacts = this.carriedContacts;
    this.carriedContacts = [];

    // A Gō fold has no trunk recycles, so nothing modulates on a recycle boundary. The
    // branch is kept because the artefact format allows a recycle and a future generative
    // entry may carry one; it is reported rather than silently absent.
    const isModulation = false;

    let isCadence = false;
    if (this.plateau.update(frame.meanConfidence)) {
      if (!this.hasCadenced) { isCadence = true; this.hasCadenced = true; }
      this.chordIndex = this.style.progression.length - 1;
    }
    const degree = this.style.progression[this.chordIndex];

    // **How far through the fold we are, which is not the same question for both engines.**
    //
    // For the Gō model it is compaction: 0 at the denatured radius of gyration for this
    // length and 1 at the native one, so the music accelerates as the chain comes together.
    //
    // For a diffusion trajectory that measure is not merely wrong but constant. Genie 2
    // starts with every residue piled into a ball of radius 1.1 Angstroms, far tighter than
    // any native structure, so `compaction` clamps to 1 on the first frame and stays there:
    // maximum tempo from beginning to end, no accelerando, and a piece that says nothing
    // about what is happening. What IS happening is that the final structure is resolving
    // out of noise, and `progress` carries exactly that - the fraction of the end structure
    // already at its final geometry, which the baker measured frame by frame.
    const compact = frame.progress ?? compaction(frame.radiusOfGyration, frame.residueCount);
    const tempo = this.style.tempoSlow
      + (this.style.tempoFast - this.style.tempoSlow) * Math.min(Math.max(compact, 0), 1);
    // A single octave of lift across the whole fold. More would put the texture off the top
    // of the pad's range by the time it converged.
    const register = compact >= 0.5 ? 1 : 0;

    // The voicing, chosen deterministically from the frame's own position, so that
    // scrubbing to a frame gives the same chord as playing to it.
    const rng = this.seed.stream(frame.index);
    const voicing = rng.pick(this.style.voicings) ?? [0, 2, 4];
    const chord = voicing.map(v => degree + v);

    // The first raw frame is the starting state, not an event. Its contacts are whatever is
    // already in contact when the trajectory begins - for a Gō fold, the local pairs of a
    // random coil. Sounding those as onsets would open every piece with a crash that says
    // nothing about folding. They are reported as established rather than dropped, because
    // nothing went wrong.
    let established = 0, dropped = 0;
    let notes = [];
    if (this.hasEstablished) {
      const produced = this.contactNotes(contacts, frame, register);
      notes = produced.notes;
      dropped = produced.dropped;
    } else {
      established = contacts.length;
      this.hasEstablished = true;
    }
    notes = notes.concat(this.padNotes(frame, chord, register),
                         this.rhythmNotes(frame, chord, register),
                         this.arpeggioNotes(frame, chord, register));

    // The style's swing, applied to every voice at once so nothing is left straight against
    // a swung bar.
    if (this.style.swing > 0) {
      notes = notes.map(n => ({ ...n, beatOffset: swung(n.beatOffset, this.style.swing) }));
    }

    // In beat order, which is the order they will be played in. The clock walks a bar's
    // notes with a single watermark rather than searching, so a note out of order would not
    // be late, it would be SKIPPED until the playhead passed it, and a pad written after the
    // contacts would never sound at all. Ties break by voice, pitch and residue so the order
    // is fully determined and a piece cannot differ between runs by the sort alone.
    notes.sort((a, b) =>
      (a.beatOffset - b.beatOffset)
      || (voiceRank(a.voice) - voiceRank(b.voice))
      || (a.note.pitch - b.note.pitch)
      || (a.residue - b.residue));

    return {
      frameIndex: frame.index,
      tempo,
      beats: Math.max(this.beatsPerMoment, 0.05),
      notes,
      timbre: timbre(frame.meanConfidence),
      degree,
      isCadence,
      isModulation,
      compaction: compact,
      droppedContacts: dropped,
      establishedContacts: established,
    };
  }

  /** Note onsets for the contacts that formed on this frame. */
  contactNotes(contacts, frame, register) {
    // Ordered so that if the bar cannot hold them all, what survives is what carries the
    // fold: core packing first, then the longest-range contacts. Fully deterministic - the
    // indices break every tie.
    const decorated = contacts.map(([i, j]) => {
      const separation = j - i;
      const range = contactRange(separation);
      const hydrophobic = isHydrophobic(this.residue(i)) && isHydrophobic(this.residue(j));
      return { i, j, separation, range,
               core: hydrophobic && range === CONTACT_RANGE.longRange };
    });
    decorated.sort((a, b) => {
      if (a.core !== b.core) return a.core ? -1 : 1;
      if (a.separation !== b.separation) return b.separation - a.separation;
      if (a.i !== b.i) return a.i - b.i;
      return a.j - b.j;
    });
    const kept = decorated.slice(0, MAXIMUM_CONTACT_NOTES);

    // A run of semiquavers rather than a stack on the downbeat. A single contact still lands
    // on the beat; a flurry of sixteen becomes a four-beat run, which is audible as sixteen
    // events where a sixteen-note cluster is audible as one noise.
    const notes = kept.map((contact, position) => {
      const voice = contact.core ? 'bass' : 'contact';
      const octave = (contact.core ? BASS_OCTAVE : RANGE_OCTAVE[contact.range]) + register;
      // The event belongs to both partners, so its velocity is their mean confidence rather
      // than one end's.
      const confidence = f32(f32(Sonifier.confidenceAt(contact.i, frame)
                                 + Sonifier.confidenceAt(contact.j, frame)) / 2);
      return {
        voice,
        note: new MIDINote(this.pitchLayer.pitch(this.residue(contact.i), octave),
                           velocity(confidence)),
        residue: contact.i,
        partner: contact.j,
        beatOffset: position * CONTACT_SPACING,
        duration: contact.core ? 2 : 1,
      };
    });
    return { notes, dropped: decorated.length - kept.length };
  }

  /** Helix content: a sustained chord, held for the whole bar. */
  padNotes(frame, chord, register) {
    const helix = residuesIn(frame.ss, 'H');
    if (!helix.length) return [];
    return spread(helix, chord.length).map((residueIndex, k) => ({
      voice: 'pad',
      note: new MIDINote(this.scale.pitch(chord[k], PAD_OCTAVE + register),
                         velocity(Sonifier.confidenceAt(residueIndex, frame))),
      residue: residueIndex,
      partner: null,
      beatOffset: 0,
      duration: BEATS_PER_BAR,
    }));
  }

  /** Sheet content: a staccato figure, evenly across the bar. */
  rhythmNotes(frame, chord, register) {
    const sheet = residuesIn(frame.ss, 'E');
    const count = textureCount(fractionOf(frame.ss, 'E'));
    if (count <= 0 || !sheet.length) return [];
    const step = this.beatsPerMoment / count;
    return spread(sheet, count).map((residueIndex, position) => ({
      voice: 'rhythm',
      note: new MIDINote(
        this.scale.pitch(chord[position % chord.length], RHYTHM_OCTAVE + register),
        velocity(Sonifier.confidenceAt(residueIndex, frame))),
      residue: residueIndex,
      partner: null,
      beatOffset: position * step,
      duration: 0.2,
    }));
  }

  /** Coil content: arpeggiation between chord tones, offset half a step from the sheet
   *  figure so the two interlock rather than double each other. */
  arpeggioNotes(frame, chord, register) {
    const coil = residuesIn(frame.ss, 'C');
    const count = textureCount(fractionOf(frame.ss, 'C'));
    if (count <= 0 || !coil.length) return [];
    const step = this.beatsPerMoment / count;
    return spread(coil, count).map((residueIndex, position) => {
      // Climbing through the chord and on into the octave above, which is what makes it
      // figuration rather than a repeated arpeggio.
      const degree = chord[position % chord.length]
        + 7 * Math.trunc(position / chord.length);
      return {
        voice: 'arpeggio',
        note: new MIDINote(this.scale.pitch(degree, ARPEGGIO_OCTAVE + register),
                           velocity(Sonifier.confidenceAt(residueIndex, frame))),
        residue: residueIndex,
        partner: null,
        beatOffset: (position + 0.5) * step,
        duration: 0.25,
      };
    });
  }
}

function residuesIn(ss, state) {
  const out = [];
  for (let i = 0; i < ss.length; i++) if (ss[i] === state) out.push(i);
  return out;
}

/* Single precision, matching FoldFrame.structureFractions, and coil is computed as the
 * REMAINDER rather than counted: `1 - hf - ef` in Float32 is not the same number as the
 * coil count over the total, and the difference can cross a rounding boundary in
 * textureCount and add or remove an arpeggio note. */
function fractionOf(ss, state) {
  if (!ss.length) return 0;
  let h = 0, e = 0;
  for (const ch of ss) { if (ch === 'H') h++; else if (ch === 'E') e++; }
  const total = f32(ss.length);
  const hf = f32(f32(h) / total), ef = f32(f32(e) / total);
  if (state === 'H') return hf;
  if (state === 'E') return ef;
  return f32(f32(1 - hf) - ef);
}

/**
 * Every moment in a trajectory, for the player and for the tests.
 *
 * @param fold  a baked fold as `/api/fold/<id>` returns it
 * @param style a decoded style JSON
 */
export function score(fold, style, targetSeconds = TARGET_SECONDS) {
  const frames = fold.frames;
  const plan = pacing(frames.length, style, targetSeconds);
  const sonifier = new Sonifier(style, fold.sequence, {
    beatsPerMoment: plan.beatsPerMoment,
    readoutsPerMoment: plan.readoutsPerMoment,
  });
  const moments = [];
  frames.forEach((frame, index) => {
    const confidence = frame.conf;
    const moment = sonifier.moment({
      index,
      confidence,
      meanConfidence: meanFloat32(confidence),
      ss: frame.ssExpanded,
      // The recorded integer, in Angstroms, taken to Float32: the Swift's
      // FoldFrame.radiusOfGyration is a Float and compaction is sensitive enough that the
      // difference between 21.3 and its single-precision neighbour reaches the tempo.
      radiusOfGyration: f32(frame.rg / 10),
      residueCount: fold.residueCount,
      // Only for a generative fold, where compaction cannot say anything: see `moment`.
      // Left undefined for the Gō engines so their pacing is byte for byte what it was,
      // which tests/sonifier_parity.test.mjs pins against the Swift.
      progress: fold.engine === 'generative' ? frame.q / 1000 : undefined,
      newContacts: frame.newContacts,
    });
    if (moment) moments.push(moment);
  });
  return { pacing: plan, moments };
}

export { meanFloat32 };
