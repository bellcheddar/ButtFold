/* Notes, keys, and the seed that makes a protein always sound like itself.
 *
 * Ported from PhoneFold's `PhoneFoldKit/Sources/FoldAudio/MusicalScale.swift` and
 * `NoteEvent.swift`, commit 6f44c8a1ac7684da93668a580b29cbe9a67cfc5e, and held to
 * note-for-note agreement with the shipped Swift by tests/sonifier_parity.test.mjs.
 *
 * **Two things here are BigInt and have to be**, and both would be silently wrong in
 * doubles: the FNV-1a sequence hash and the SplitMix64 generator are 64-bit integer
 * arithmetic that overflows on almost every step. A double holds 53 bits exactly, so the
 * low bits - which is where all the entropy is - would be rounded away and the piece would
 * still sound like music, just not like PhoneFold's music. Nothing else in the audio path
 * uses BigInt, and none of it runs per sample.
 */

const MASK64 = (1n << 64n) - 1n;

/** A note, as a MIDI pitch and how hard it is struck. */
export class MIDINote {
  constructor(pitch, velocity) {
    this.pitch = Math.min(Math.trunc(pitch), 127);
    // 1, not 0: zero would be a note-off, which this type does not represent.
    this.velocity = Math.min(Math.max(Math.trunc(velocity), 1), 127);
  }

  /** Concert pitch, for a synthesiser that wants hertz. A' = 440 Hz at MIDI 69. */
  get frequency() { return 440 * Math.pow(2, (this.pitch - 69) / 12); }
}

/* Semitone offsets from the root for each degree. Stored as intervals rather than names,
 * because everything downstream asks "what is the fourth degree of this scale" and never
 * "is this Dorian". Aeolian IS the natural minor; both names are kept because a style file
 * should be able to say what it means. */
export const MODES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  aeolian:    [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
};

export class MusicalScale {
  constructor(root = 57, mode = 'minor') {
    this.root = root;
    this.mode = mode;
    this.intervals = MODES[mode] ?? MODES.minor;
  }

  /**
   * The pitch of a scale degree, where 0 is the tonic.
   *
   * Degrees run past the ends of the scale in both directions: degree 7 is the tonic an
   * octave up and degree -1 is the seventh below. That matters because the trajectory
   * drives register directly - a long-range contact asks for a note far below the tonic -
   * and a mapping that clamped at the octave would flatten exactly the contrast it shows.
   */
  pitch(degree, octaveShift = 0) {
    const steps = this.intervals.length;
    // Floor division. JS `%` and Swift `/` both truncate toward zero, which for a negative
    // degree lands on the tonic instead of on the seventh below.
    let octave = Math.floor(degree / steps);
    let index = degree - octave * steps;
    if (index < 0) { index += steps; octave -= 1; }
    const semitones = this.root + this.intervals[index] + 12 * (octave + octaveShift);
    return Math.min(Math.max(semitones, 0), 127);
  }

  /** The nearest scale degree at or below a chromatic pitch, for snapping a free choice
   *  into the key rather than letting it sound accidental. */
  snap(pitch) {
    const semitone = (pitch - this.root) % 12;
    const normalised = semitone < 0 ? semitone + 12 : semitone;
    let below = 0;
    for (const interval of this.intervals) if (interval <= normalised) below = interval;
    return Math.min(Math.max(pitch - (normalised - below), 0), 127);
  }
}

/**
 * The seed that makes a protein always sound like itself.
 *
 * FNV-1a over the uppercased sequence bytes. **Not a JS string hash and not any of the
 * usual 32-bit tricks**: the value has to match PhoneFold's byte for byte or the same
 * protein is a different piece in the browser than on the phone, which is the one thing
 * this must never be.
 */
export class SequenceSeed {
  constructor(sequence) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(String(sequence).toUpperCase())) {
      hash ^= BigInt(byte);
      hash = (hash * 0x100000001b3n) & MASK64;
    }
    // A protein with no sequence still needs a seed, and zero is a poor one: it makes the
    // generator's first outputs degenerate.
    this.value = hash === 0n ? 0x9e3779b97f4a7c15n : hash;
  }

  generator() { return new SplitMix64Music(this.value); }

  /**
   * A generator for one *position* in the trajectory.
   *
   * Not the same as advancing a single stream frame by frame. A single stream makes every
   * choice depend on how many frames came before it, so scrubbing to frame 400 would give a
   * different chord than playing to frame 400 - the same protein sounding like two pieces
   * depending on how it was reached. Deriving the stream from the position makes the score
   * seekable, which the scrubber needs.
   */
  stream(position) {
    // Swift takes `UInt64(bitPattern: Int64(position))`, so a negative position wraps
    // rather than throwing. BigInt.asUintN is the same reinterpretation.
    const p = BigInt.asUintN(64, BigInt(position));
    return new SplitMix64Music(this.value ^ ((p * 0x9E3779B97F4A7C15n) & MASK64));
  }
}

/* The generator behind every stochastic musical choice. Kept separate from the physics
 * generator: reseeding the physics must never alter the music, and a change to a musical
 * decision must never move a fold. */
export class SplitMix64Music {
  constructor(seed) {
    this.state = (BigInt.asUintN(64, BigInt(seed)) * 6364136223846793005n
                  + 1442695040888963407n) & MASK64;
    for (let i = 0; i < 8; i++) this.next();
  }

  next() {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /** 0 up to but not including 1. */
  uniform() { return Number(this.next() >> 11n) * (1.0 / 9007199254740992.0); }

  /** A choice from a list, deterministic for a given seed. */
  pick(options) {
    if (!options || options.length === 0) return null;
    return options[Math.trunc(this.uniform() * options.length) % options.length];
  }
}

/* Kyte-Doolittle hydropathy (J. Mol. Biol. 1982, 157(1):105-132), which drives both the
 * pitch layer and the classification of a contact as core packing. */
export const HYDROPATHY = {
  I: 4.5, V: 4.2, L: 3.8, F: 2.8, C: 2.5, M: 1.9, A: 1.8, G: -0.4, T: -0.7, S: -0.8,
  W: -0.9, Y: -1.3, P: -1.6, H: -3.2, E: -3.5, Q: -3.5, D: -3.5, N: -3.5, K: -3.9, R: -4.5,
  X: 0.0,
};

export const isHydrophobic = code => (HYDROPATHY[code] ?? 0) > 0;

/**
 * The pitch layer: which note a residue *is*, before the trajectory does anything to it.
 *
 * The Tay et al. approach (Heliyon 2021, 7(9):e07933) as PLAN asks: an amino acid property
 * mapping with charged residues as octave-shift triggers. The property is Kyte-Doolittle
 * hydropathy; residues are ranked by it and the rank taken modulo the scale, so residues of
 * similar character sit on adjacent degrees and a run of like residues moves stepwise
 * rather than leaping. That is what makes it sound like a melody instead of a lookup table.
 */
export class PitchLayer {
  constructor(scale, octaveShiftResidues = []) {
    this.scale = scale;
    this.octaveShiftResidues = new Set(
      octaveShiftResidues.map(s => String(s)[0]).filter(Boolean));
  }

  /* The twenty acids most to least hydrophobic, ties broken by one-letter code so the
   * order is fixed. `X` is excluded: it is not an amino acid, and it is given the tonic
   * rather than a rank of its own. */
  static get order() {
    if (!this._order) {
      this._order = Object.keys(HYDROPATHY).filter(c => c !== 'X')
        .sort((a, b) => (HYDROPATHY[b] - HYDROPATHY[a]) || (a < b ? -1 : a > b ? 1 : 0));
    }
    return this._order;
  }

  static get degrees() {
    if (!this._degrees) {
      this._degrees = { X: 0 };
      PitchLayer.order.forEach((code, rank) => { this._degrees[code] = rank % 7; });
    }
    return this._degrees;
  }

  degree(code) { return PitchLayer.degrees[code] ?? 0; }

  /** The pitch for a residue, in a given octave relative to the scale's own. */
  pitch(code, octave) {
    const shift = this.octaveShiftResidues.has(code) ? 1 : 0;
    return this.scale.pitch(this.degree(code), octave + shift);
  }
}

/** How far apart in sequence a contact's partners are. The axis that sets register. */
export const CONTACT_RANGE = { local: 0, medium: 1, longRange: 2 };

export function contactRange(separation) {
  const s = Math.abs(separation);
  if (s < 6) return CONTACT_RANGE.local;      // helix-turn scale
  if (s < 12) return CONTACT_RANGE.medium;
  return CONTACT_RANGE.longRange;             // tertiary structure; the ones that matter
}
