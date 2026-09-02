/* The Web Audio engine: what a ScoreMoment actually sounds like.
 *
 * A reimplementation of PhoneFold's `Synthesiser`, not a port. AVAudioEngine and Web Audio
 * are different graphs, and PLAN.md section 2 says so plainly: "The synthesiser is a
 * reimplementation in Web Audio, not a port." What IS a port, and what the parity test
 * pins, is the score - the notes, their pitches, velocities, beats and voices. Those are
 * guaranteed identical. The timbre is as close as two different synthesis stacks get, and
 * Marc's ear is the gate on it.
 *
 * The style files are consumed unchanged, every field of them:
 *   waveform + harmonics  -> a PeriodicWave, or two-operator FM for `fm`
 *   attack/decay/sustain/release -> a GainNode envelope per note
 *   detuneCents           -> a second oscillator, detuned, summed
 *   drive                 -> WaveShaperNode, soft saturation rather than a hard clip
 *   tremoloHz/Depth       -> an LFO on a gain stage
 *   gain                  -> the voice's level in the mix
 *
 * Three things that are Web Audio facts rather than choices:
 *
 * 1. **An AudioContext cannot start without a user gesture.** So the fold does not
 *    auto-sound; the play button is the gesture, and `start()` must be called from inside
 *    the click handler, not from a promise chain after it.
 * 2. **Notes are scheduled ahead of the clock, not on it.** setTimeout jitter is tens of
 *    milliseconds and would be plainly audible on a semiquaver run; a lookahead scheduler
 *    hands the audio thread exact `currentTime`-relative start times and lets it be
 *    precise. This is Chris Wilson's standard pattern, and no AudioWorklet is needed
 *    because notes are discrete events rather than a continuous process.
 * 3. **Spatialisation is per note, at its residue's position.** PannerNode with
 *    panningModel 'HRTF' is the direct equivalent of PhoneFold's AVAudioEnvironmentNode,
 *    and it is the reason every NoteEvent carries its residue: the fold collapses around
 *    the listener as the structure collapses.
 */

const LOOKAHEAD_SECONDS = 0.12;   // how far ahead notes are scheduled
const TICK_MS = 25;               // how often the scheduler looks

/* The stage is drawn in the artefact's +/-1000 quantised box. Web Audio's panner works in
 * metres-ish units around a listener at the origin, and the whole structure should sit
 * within a couple of metres or the HRTF cues collapse to "everything is far away". */
const SPATIAL_SCALE = 1.6 / 1000;

/** A soft saturation curve for `drive`. Adds harmonics without adding a rectangle. */
function driveCurve(amount) {
  if (!(amount > 0)) return null;
  const k = amount * 60;
  const samples = 1024;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** A PeriodicWave from a style's harmonic amplitudes, cached per voice. */
function periodicWave(context, spec, cache) {
  const key = `${spec.waveform}:${(spec.harmonics ?? []).join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const harmonics = spec.harmonics ?? [];
  let wave = null;
  if (harmonics.length) {
    // Index 0 of a PeriodicWave is the DC term and must stay zero; the fundamental is
    // index 1. Writing the fundamental into slot 0 gives a silent oscillator with an
    // offset, which reads as "the synth is broken" rather than as a wrong timbre.
    const real = new Float32Array(harmonics.length + 1);
    const imag = new Float32Array(harmonics.length + 1);
    harmonics.forEach((amplitude, i) => { imag[i + 1] = amplitude; });
    wave = context.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  cache.set(key, wave);
  return wave;
}

export class FoldAudio {
  constructor() {
    this.context = null;
    this.moments = [];
    this.timeline = [];
    this.events = [];
    this.style = null;
    this.positionsFor = null;   // (frameIndex, residue) -> [x, y, z] in quantised units
    this.playing = false;
    this.startedAt = 0;         // context time at which timeline second 0 sits
    this.offsetSeconds = 0;     // where in the timeline we resumed from
    this.nextIndex = 0;
    this.timer = null;
    this.waveCache = new Map();
    this.volume = 0.7;
  }

  get available() {
    return typeof (window.AudioContext ?? window.webkitAudioContext) !== 'undefined';
  }

  /** Must be called from inside a user gesture. */
  async start() {
    if (!this.context) {
      const Ctor = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctor) throw new Error('this browser has no Web Audio');
      this.context = new Ctor();
      this._buildGraph();
    }
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context.state === 'running';
  }

  _buildGraph() {
    const ctx = this.context;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    // One low-pass for the whole mix, driven by mean confidence. A murky structure sounds
    // murky; a resolved one opens up.
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 14000;
    this.lowpass.Q.value = 0.7;

    // Reverb from a synthesised impulse response: no asset to fetch, no licence, and the
    // CSP forbids loading one from anywhere but the allowlisted CDNs anyway.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._impulseResponse(2.4, 2.6);
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet.gain.value = 0.25;
    this.dry.gain.value = 0.75;

    this.lowpass.connect(this.dry).connect(this.master);
    this.lowpass.connect(this.convolver).connect(this.wet).connect(this.master);
    this.master.connect(ctx.destination);

    if (ctx.listener?.forwardX) {
      ctx.listener.forwardX.value = 0; ctx.listener.forwardY.value = 0;
      ctx.listener.forwardZ.value = -1;
      ctx.listener.upX.value = 0; ctx.listener.upY.value = 1; ctx.listener.upZ.value = 0;
    } else if (ctx.listener?.setOrientation) {
      ctx.listener.setOrientation(0, 0, -1, 0, 1, 0);   // Safari's older API
    }
  }

  _impulseResponse(seconds, decay) {
    const ctx = this.context;
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  /**
   * Lay the score out on an absolute timeline in seconds.
   *
   * **Absolute, not a bar at a time.** A moment's contacts can run past its own beat: a
   * flurry of sixteen is a four-beat run at semiquaver spacing, and at one beat per moment
   * that overlaps the three moments after it. Scheduling bar by bar would truncate exactly
   * the gesture the flurry exists to make. It also means the animation can be driven from
   * the audio clock rather than the other way round, which is what keeps them together.
   */
  loadScore(moments, style, positionsFor) {
    this.moments = moments;
    this.style = style;
    this.positionsFor = positionsFor;
    this.waveCache.clear();
    this.timeline = [];
    let seconds = 0;
    for (const moment of moments) {
      const secondsPerBeat = 60 / Math.max(moment.tempo, 1);
      this.timeline.push({ moment, startSeconds: seconds, secondsPerBeat });
      seconds += moment.beats * secondsPerBeat;
    }
    this.durationSeconds = seconds;
    this.nextIndex = 0;
    this._layOutEvents();
  }

  /**
   * Every note in the piece, flattened onto one time-sorted array.
   *
   * **This is how the page finds out what is sounding, and it is a query rather than a
   * callback.** The obvious way to drive a visual from audio is to have the scheduler
   * announce each note as it queues it - but the scheduler runs a LOOKAHEAD, so it queues
   * notes up to a second before they are audible, and a visual driven from it would run
   * ahead of its own music. It also queues nothing while paused, so scrubbing would show an
   * empty stage.
   *
   * Asking "what is sounding at this instant" instead costs a binary search, cannot drift
   * from the audio clock because it IS the audio clock, and answers the same when paused as
   * when playing. It is the same shape as `frameAtFractional`, which drives the structure
   * for the same reasons.
   */
  _layOutEvents() {
    this.events = [];
    for (const entry of this.timeline) {
      for (const note of entry.moment.notes) {
        this.events.push({
          at: entry.startSeconds + note.beatOffset * entry.secondsPerBeat,
          seconds: Math.max(note.duration * entry.secondsPerBeat, 0.05),
          voice: note.voice,
          residue: note.residue,
          partner: note.partner,
          // 1 to 127 from the sonifier; 0 to 1 here, because everything downstream of this
          // is an opacity or a line width.
          velocity: note.note.velocity / 127,
        });
      }
    }
    // A contact flurry runs past its own moment, so the events are NOT already in order.
    this.events.sort((a, b) => a.at - b.at);
    // The longest note in the piece, which is how far back the search below has to look.
    this.longestEvent = this.events.reduce((m, e) => Math.max(m, e.seconds), 0);
  }

  /**
   * The notes sounding at `seconds`, each with how far through its life it is.
   *
   * A note is drawn for the LONGER of its own duration and `minimumTail`, and that is not a
   * detail. The five voices differ by more than an order of magnitude in length: a contact
   * is a semiquaver, 60 ms at this tempo, which on its own would be a single frame on screen
   * and read as a flicker rather than a strike; a pad chord is held for the whole bar, four
   * seconds, and cutting it off after a fixed tail would take the light off a residue while
   * the listener can plainly still hear it. So the floor is a visual decay for the short
   * notes, and the long ones are drawn for exactly as long as they sound.
   *
   * `age` runs 0 to 1 across whichever of the two won, so a caller's fade does not have to
   * know which kind of note it has.
   */
  notesSounding(seconds, minimumTail = 0.9) {
    const events = this.events ?? [];
    if (!events.length) return [];
    // Back far enough to catch the longest note in the piece still ringing.
    const from = seconds - Math.max(this.longestEvent ?? 0, minimumTail);
    let low = 0, high = events.length - 1, start = events.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (events[mid].at >= from) { start = mid; high = mid - 1; } else low = mid + 1;
    }
    const out = [];
    for (let i = start; i < events.length && events[i].at <= seconds; i++) {
      const event = events[i];
      const span = Math.max(event.seconds, minimumTail);
      const age = (seconds - event.at) / span;
      if (age >= 1) continue;
      out.push({ ...event, age });
    }
    return out;
  }

  /** Where in the timeline playback currently is. */
  get positionSeconds() {
    if (!this.playing || !this.context) return this.offsetSeconds;
    return this.offsetSeconds + (this.context.currentTime - this.startedAt);
  }

  /** Which trajectory frame that position corresponds to, for the animation. */
  frameAt(seconds) {
    if (!this.timeline.length) return 0;
    let low = 0, high = this.timeline.length - 1, best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.timeline[mid].startSeconds <= seconds) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
    return this.timeline[best].moment.frameIndex;
  }

  /**
   * Where playback is between two trajectory frames, as a fractional frame index.
   *
   * The same search as `frameAt`, carried on into the gap: how far through the interval
   * between this moment and the next one the clock has got, applied to the frames those two
   * moments point at. Moments are musical events rather than a fixed grid, so the mapping is
   * uneven and this reads it rather than assuming a rate - and it still reaches the next
   * moment's frame exactly when that moment sounds, so the picture and the note land
   * together as they did before.
   */
  frameAtFractional(seconds) {
    if (!this.timeline.length) return 0;
    let low = 0, high = this.timeline.length - 1, best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.timeline[mid].startSeconds <= seconds) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
    const here = this.timeline[best];
    const next = this.timeline[best + 1];
    if (!next) return here.moment.frameIndex;
    const span = next.startSeconds - here.startSeconds;
    if (!(span > 0)) return here.moment.frameIndex;
    const t = Math.min(Math.max((seconds - here.startSeconds) / span, 0), 1);
    return here.moment.frameIndex + t * (next.moment.frameIndex - here.moment.frameIndex);
  }

  play(fromSeconds = null) {
    if (!this.context || !this.timeline.length) return;
    this.offsetSeconds = fromSeconds ?? this.offsetSeconds;
    this.startedAt = this.context.currentTime;
    this.playing = true;
    this._clockSeenAt = null;      // the watchdog measures from here, not from load
    // Resume scheduling from the first moment at or after the resume point, so seeking does
    // not replay everything before it in a burst.
    this.nextIndex = this.timeline.findIndex(t => t.startSeconds >= this.offsetSeconds);
    if (this.nextIndex < 0) this.nextIndex = this.timeline.length;
    this._tick();
    this.timer = setInterval(() => this._tick(), TICK_MS);
  }

  pause() {
    this.offsetSeconds = this.positionSeconds;
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.pause();
    this.offsetSeconds = Math.max(0, Math.min(seconds, this.durationSeconds ?? 0));
    if (wasPlaying) this.play();
  }

  setVolume(value) {
    this.volume = Math.min(Math.max(value, 0), 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  /**
   * Is the audio actually running, or only claiming to be?
   *
   * A context can report `running`, accept every note the scheduler queues, and produce
   * silence. Two ways that happens and neither raises anything: the render thread never gets
   * driven, so `currentTime` sits where it started - measured on this Mac, a bare
   * AudioContext with no page of ours in it advanced 0.005 s in 1.5 s, one render quantum -
   * or Safari puts the context into `interrupted`, which is a state the spec does not have
   * and no `catch` will ever see.
   *
   * Both look identical from the outside: the transport says Pause, the structure folds, the
   * chords strike, and nothing comes out. That is exactly the kind of quiet failure this app
   * is not supposed to have, so it is detected and said out loud.
   */
  diagnose() {
    if (!this.context) return null;
    if (this.context.state === 'interrupted') {
      return 'Safari has interrupted the audio. Playing anything else and coming back, or '
           + 'reloading the tab, usually restores it.';
    }
    if (this.context.state !== 'running') {
      return `The audio context is "${this.context.state}", so nothing will be heard. `
           + 'Press Play again.';
    }
    if (!this.playing) return null;
    const now = this.context.currentTime;
    if (this._clockSeenAt == null) { this._clockSeenAt = now; this._clockSeenWall = Date.now(); }
    // Half a second of wall clock is far longer than a render quantum, so a clock that has
    // not moved in that time is not merely between buffers.
    if (Date.now() - this._clockSeenWall < 500) return null;
    const advanced = now - this._clockSeenAt;
    this._clockSeenAt = now;
    this._clockSeenWall = Date.now();
    if (advanced < 0.05) {
      return 'The browser started the audio but is not running its clock, so the notes are '
           + 'being scheduled into silence. Reloading the tab usually clears it.';
    }
    return null;
  }

  _tick() {
    if (!this.playing) return;
    const horizon = this.positionSeconds + LOOKAHEAD_SECONDS;
    while (this.nextIndex < this.timeline.length
           && this.timeline[this.nextIndex].startSeconds <= horizon) {
      const entry = this.timeline[this.nextIndex++];
      this._scheduleMoment(entry);
    }
    if (this.nextIndex >= this.timeline.length
        && this.positionSeconds >= (this.durationSeconds ?? 0)) {
      this.pause();
      this.onEnded?.();
    }
  }

  _scheduleMoment(entry) {
    const { moment, startSeconds, secondsPerBeat } = entry;
    const when = this.startedAt + (startSeconds - this.offsetSeconds);
    const ctx = this.context;
    if (when < ctx.currentTime - 0.05) return;   // already gone by; do not fire it late

    // The timbre layer, ramped rather than stepped: a filter cutoff that jumps on every
    // moment boundary clicks.
    const at = Math.max(when, ctx.currentTime);
    this.lowpass.frequency.setTargetAtTime(moment.timbre.cutoff, at, 0.08);
    this.wet.gain.setTargetAtTime(moment.timbre.reverb, at, 0.15);
    this.dry.gain.setTargetAtTime(1 - moment.timbre.reverb * 0.6, at, 0.15);

    for (const note of moment.notes) {
      this._scheduleNote(note, when + note.beatOffset * secondsPerBeat,
                         note.duration * secondsPerBeat, moment);
    }
  }

  _scheduleNote(note, when, duration, moment) {
    const ctx = this.context;
    if (when < ctx.currentTime) when = ctx.currentTime;
    const spec = this.style.voices?.[note.voice] ?? {};
    const frequency = 440 * Math.pow(2, (note.note.pitch - 69) / 12);
    const level = (note.note.velocity / 127) * (spec.gain ?? 0.4);

    const envelope = ctx.createGain();
    envelope.gain.value = 0;

    // Spatial placement at the note's residue, or at the midpoint of a contact's two
    // partners, which is where the event actually happens.
    let destination = envelope;
    const position = this._positionOf(note, moment.frameIndex);
    if (position && ctx.createPanner) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 12;
      if (panner.positionX) {
        panner.positionX.value = position[0];
        panner.positionY.value = position[1];
        panner.positionZ.value = position[2];
      } else {
        panner.setPosition(position[0], position[1], position[2]);   // Safari's older API
      }
      envelope.connect(panner);
      destination = panner;
    }

    // Waveshaping, then tremolo, then the shared filter.
    let tail = destination;
    const curve = driveCurve(spec.drive ?? 0);
    if (curve) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = curve;
      shaper.oversample = '2x';
      tail.connect(shaper);
      tail = shaper;
    }
    if ((spec.tremoloHz ?? 0) > 0 && (spec.tremoloDepth ?? 0) > 0) {
      const tremolo = ctx.createGain();
      const depth = Math.min(spec.tremoloDepth, 1);
      tremolo.gain.value = 1 - depth;
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = spec.tremoloHz;
      lfoGain.gain.value = depth;
      lfo.connect(lfoGain).connect(tremolo.gain);
      lfo.start(when);
      lfo.stop(when + duration + (spec.release ?? 0.3) + 0.1);
      tail.connect(tremolo);
      tail = tremolo;
    }
    tail.connect(this.lowpass);

    const sources = [];
    // Detune is a second oscillator rather than a parameter, because that is what makes it
    // thicken: one oscillator detuned from itself is just out of tune.
    const detunes = (spec.detuneCents ?? 0) > 0
      ? [-spec.detuneCents / 2, spec.detuneCents / 2] : [0];

    for (const cents of detunes) {
      if (spec.waveform === 'fm') {
        // Two-operator FM, for bells and plucks that additive shapes do poorly.
        const carrier = ctx.createOscillator();
        carrier.type = 'sine';
        carrier.frequency.value = frequency;
        carrier.detune.value = cents;
        const modulator = ctx.createOscillator();
        modulator.type = 'sine';
        modulator.frequency.value = frequency * (spec.fmRatio ?? 2);
        const index = ctx.createGain();
        index.gain.value = frequency * (spec.fmIndex ?? 1);
        modulator.connect(index).connect(carrier.frequency);
        carrier.connect(envelope);
        sources.push(carrier, modulator);
      } else {
        const oscillator = ctx.createOscillator();
        const wave = periodicWave(ctx, spec, this.waveCache);
        if (wave) oscillator.setPeriodicWave(wave);
        else oscillator.type = spec.waveform ?? 'sine';
        oscillator.frequency.value = frequency;
        oscillator.detune.value = cents;
        oscillator.connect(envelope);
        sources.push(oscillator);
      }
    }

    // ADSR. Ramps rather than steps throughout: a gain that jumps produces a click, which
    // on a bar of sixteen semiquavers is the loudest thing in the mix.
    const attack = Math.max(spec.attack ?? 0.01, 0.001);
    const decay = Math.max(spec.decay ?? 0.1, 0.001);
    const sustain = Math.min(Math.max(spec.sustain ?? 0.7, 0), 1);
    const release = Math.max(spec.release ?? 0.3, 0.01);
    const peak = level / Math.max(detunes.length, 1);
    const held = Math.max(duration, 0.05);

    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(peak, when + attack);
    envelope.gain.linearRampToValueAtTime(peak * sustain, when + attack + decay);
    // A percussive voice has sustain 0, so it has already decayed to silence and there is
    // nothing to release; ramping again from zero would be a no-op with a scheduled node
    // left running.
    const releaseAt = when + held;
    if (sustain > 0) {
      envelope.gain.setValueAtTime(peak * sustain, releaseAt);
      envelope.gain.linearRampToValueAtTime(0, releaseAt + release);
    }
    const stopAt = releaseAt + release + 0.02;
    for (const source of sources) { source.start(when); source.stop(stopAt); }
    // Disconnect on the last source ending, so a long piece does not accumulate thousands
    // of dead nodes hanging off the filter.
    sources[0].onended = () => {
      try { envelope.disconnect(); tail.disconnect(); } catch { /* already gone */ }
    };
  }

  _positionOf(note, frameIndex) {
    if (!this.positionsFor) return null;
    const residues = note.partner == null ? [note.residue] : [note.residue, note.partner];
    let x = 0, y = 0, z = 0, found = 0;
    for (const residue of residues) {
      const p = this.positionsFor(frameIndex, residue);
      if (!p) continue;
      x += p[0]; y += p[1]; z += p[2]; found++;
    }
    if (!found) return null;
    return [x / found * SPATIAL_SCALE, y / found * SPATIAL_SCALE,
            z / found * SPATIAL_SCALE];
  }

  stop() {
    this.pause();
    this.offsetSeconds = 0;
    this.nextIndex = 0;
  }
}
