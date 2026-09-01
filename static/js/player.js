/* The one player. Everything downstream of "a stream of CA frames" lives here.
 *
 * PLAN.md section 2: the baked gallery, the live WASM fold and the droplet queue are three
 * frame *sources* and one player. Whatever produced a frame, by the time it reaches this
 * file it is `{points, ss, rg, q, newContacts}` and nothing here knows the difference. That
 * is the whole reason the artefact format and the worker's output shape are identical.
 *
 * Phase 1 wires the baked source. Phase 2 adds the sonifier to the same frame callback and
 * Phase 3 adds the live source; neither should need to touch the transport, the stage, the
 * readouts or the charts.
 */

import { Stage, COLOUR_MODES } from './stage.js';
import { runLengthDecode } from './PSEA.js';
import { score } from './Sonifier.js';
import { FoldAudio } from './audio.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';

const $ = id => document.getElementById(id);

/* The disclosure lines. Verbatim quotations from the shipped app, em dash included, and
 * the Phase 5 gate greps the served page for them. ButtFold's own prose uses no em dashes;
 * these are not ButtFold's own prose. PLAN.md section 7. */
export const DISCLOSURES = {
  go: 'Simulated on device toward a known structure — not a prediction',
  generative: 'Genie 2 invents a backbone from noise. Not a named protein',
};

const ENGINE_BADGE = {
  go: 'Gō model · toward a known structure',
  generative: 'Genie 2 · invented from noise',
};
const WHERE_BADGE = {
  baked: 'precomputed',
  live: 'in your browser',
  queued: 'on the server',
};

class Player {
  constructor() {
    this.frames = [];
    this.index = 0;
    this.playing = false;
    this.source = 'baked';
    this.engine = 'go';
    this.fold = null;
    this.residueCount = 0;
    this.lastTick = 0;
    this.framesPerSecond = 24;
    this.accumulator = 0;
    this.history = { helix: [], sheet: [], coil: [], rg: [] };
    this.audio = new FoldAudio();
    this.styleId = 'fantasy';
    this.styles = {};
    this.scored = null;
    this.worker = null;
    this.liveFrames = [];
    this.liveSupported = detectLiveSupport();
    // A different seed each time the server is asked, so "fold it again" is a genuinely
    // different trajectory rather than a cache hit that looks like a very fast fold. The
    // coil is fixed and only the random force changes, which is exactly the perturbation
    // P0-3b measured: same funnel, different path through it.
    this.queueSeed = 1 + Math.floor(Math.random() * 1_000_000);
    this._queueTimer = null;
  }

  async boot() {
    const [THREE] = await Promise.all([import(THREE_URL), this._loadStyles()]);
    this.stage = new Stage($('stage'), THREE);
    this._wireControls();
    this._applyLiveSupport();
    const first = document.querySelector('.card');
    await this.load(first?.dataset.foldId ?? 'trp_cage');
    requestAnimationFrame(t => this._loop(t));
  }

  async _loadStyles() {
    // Every style the page offers, loaded up front: they are a few kilobytes each and
    // switching style must be instant and beat-quantised, never a fetch and a stall.
    const ids = [...document.querySelectorAll('#style-mode button')]
      .map(b => b.dataset.style);
    const loaded = await Promise.all(ids.map(async id => {
      const response = await fetch(`/static/styles/${id}.json`);
      if (!response.ok) throw new Error(`style ${id}: HTTP ${response.status}`);
      return [id, await response.json()];
    }));
    this.styles = Object.fromEntries(loaded);
  }

  async load(foldId) {
    const response = await fetch(`/api/fold/${encodeURIComponent(foldId)}`);
    if (!response.ok) throw new Error(`fold ${foldId}: HTTP ${response.status}`);
    this._adoptFold(await response.json());
    this._setSource('baked');
    $('live-status').textContent = '';
    document.querySelectorAll('.card').forEach(card => {
      card.setAttribute('aria-pressed', String(card.dataset.foldId === foldId));
    });
  }

  /* Take a fold object - baked, queued, or finished live - and make it the current one.
   *
   * Everything below this line is source-agnostic by construction, which is the whole
   * reason a queued fold is baked server-side into the gallery's own artefact format
   * rather than streamed raw: there is one adoption path, so there is one thing to test
   * and nothing downstream can tell the three sources apart. */
  _adoptFold(fold) {
    this.fold = fold;
    this.engine = fold.engine ?? 'go';
    this.residueCount = fold.residueCount;
    // Decoded once here rather than per frame: the run-length string is compact on the
    // wire and expensive to expand sixty times a second.
    this.frames = fold.frames.map(frame => ({
      points: Float32Array.from(frame.points),
      ss: runLengthDecode(frame.ss),
      newContacts: frame.newContacts,
      // 0..100 per residue, as the artefact stores it, scaled to the 0..1 the confidence
      // colour ramp wants. Without this the ramp read `null` for every residue and painted
      // the whole ribbon the same "below 50" orange - a mode that looked implemented,
      // changed the colours, and showed nothing. The wiring audit cannot see this: the
      // module is imported, the button is wired, the function is called.
      confidence: frame.conf ? Float32Array.from(frame.conf, c => c / 100) : null,
      rg: frame.rg / 10,
      q: frame.q / 1000,
    }));
    this.index = 0;
    this.contactsSoFar = 0;
    this.history = { helix: [], sheet: [], coil: [], rg: [] };
    this.stage.setResidueCount(fold.residueCount);

    $('protein-name').textContent = fold.name;
    $('protein-sub').textContent = subtitleFor(fold);
    $('disclosure').textContent = DISCLOSURES[this.engine] ?? DISCLOSURES.go;
    this._updateBadge();
    $('seek').max = String(Math.max(this.frames.length - 1, 0));
    this._rescore();
    this._show(0);
  }

  /* Build the score for the current fold and style, and hand it to the audio engine.
   *
   * Done on load and on every style change, not on every frame: the whole trajectory is
   * scored at once because the sonifier's pacing needs to know how many readouts there
   * are before it can decide how many of them share a moment. */
  _rescore() {
    if (!this.fold) return;
    const style = this.styles[this.styleId];
    if (!style) return;
    this.scored = score({ ...this.fold, frames: this.fold.frames.map((f, i) => ({
      ...f, ssExpanded: this.frames[i].ss })) }, style);
    this.audio.loadScore(this.scored.moments, style,
                         (frameIndex, residue) => this._residuePosition(frameIndex, residue));
    const seconds = this.audio.durationSeconds ?? 0;
    const notes = this.scored.moments.reduce((sum, m) => sum + m.notes.length, 0);
    const dropped = this.scored.moments.reduce((sum, m) => sum + m.droppedContacts, 0);
    // Reported, not hidden: a trajectory that loses most of its events to the per-bar cap
    // should say so rather than just sounding thin. PLAN section 5.3's honesty rule applied
    // to the music.
    $('score-summary').textContent =
      `${notes.toLocaleString()} notes over ${seconds.toFixed(0)} s`
      + (dropped ? `, ${dropped.toLocaleString()} contacts past the per-bar cap` : '');
  }

  _residuePosition(frameIndex, residue) {
    const frame = this.frames[frameIndex];
    if (!frame || residue < 0 || residue * 3 + 2 >= frame.points.length) return null;
    return [frame.points[3 * residue], frame.points[3 * residue + 1],
            frame.points[3 * residue + 2]];
  }

  /* Feature detection decides what the engine pill offers. PLAN section 2: the page loads
   * and the baked gallery plays immediately, with no capability check and no compute; the
   * live control is enabled only where it can work. A disabled pill that says why is more
   * honest than a missing one. */
  _applyLiveSupport() {
    const button = document.querySelector('#engine-mode button[data-source="live"]');
    if (!button) return;
    if (this.liveSupported.ok) {
      button.disabled = false;
      button.title = 'Fold this protein in your browser, now';
    } else {
      button.disabled = true;
      button.title = `Not available here: no ${this.liveSupported.missing.join(', ')}`;
    }
  }

  /* Ask the droplet to fold this protein, and follow it. Architecture B.
   *
   * The fallback for a browser that cannot run the module, and the path for anything too
   * heavy for a phone. It is one worker at nice 19 behind a residue cap, a depth cap and a
   * per-IP cap, so the honest failures - a full queue, a protein too large - are ordinary
   * answers rather than errors, and the page shows them as such. */
  async foldQueued() {
    if (!this.fold) return;
    this.playing = false;
    this.audio.stop();
    $('play').textContent = 'Play';
    this.worker?.postMessage({ type: 'cancel' });
    this._setSource('queued');
    $('live-status').textContent = 'asking the server';

    const response = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protein_id: this.fold.id, seed: this.queueSeed }),
    });
    const body = await response.json().catch(() => ({}));

    if (response.status === 429) {
      // Not an error: it is the cap doing its job, and the gallery is right there.
      $('live-status').textContent =
        `${body.error} Try again shortly, or play the gallery version.`;
      return;
    }
    if (!response.ok && response.status !== 202) {
      $('live-status').textContent = body.error ?? `the server said ${response.status}`;
      return;
    }
    if (body.cached) {
      $('live-status').textContent = 'this fold was already computed; loading it';
      await this._loadQueuedResult(body.result_url);
      return;
    }
    $('live-status').textContent = 'queued';
    this._pollQueue(body.job_id);
  }

  _pollQueue(jobId) {
    clearInterval(this._queueTimer);
    this._queueTimer = setInterval(async () => {
      let status;
      try {
        const response = await fetch(`/api/queue/${jobId}`);
        status = await response.json();
      } catch (err) {
        $('live-status').textContent = `lost contact with the server: ${err.message}`;
        clearInterval(this._queueTimer);
        return;
      }
      if (status.state === 'queued') {
        $('live-status').textContent =
          `queued, position ${status.position} - this server folds one at a time`;
      } else if (status.state === 'running') {
        // Progress is the growing frame file's byte count, which maps to frames exactly.
        const percent = status.frames_total
          ? Math.round(100 * status.frames_done / status.frames_total) : 0;
        $('live-status').textContent = `folding on the server, ${percent}%`;
      } else if (status.state === 'done') {
        clearInterval(this._queueTimer);
        await this._loadQueuedResult(status.result_url);
      } else {
        clearInterval(this._queueTimer);
        // Reported honestly, the timeout included. A job that was killed says so.
        $('live-status').textContent =
          `the server ${status.state} this fold${status.error ? `: ${status.error}` : ''}`;
      }
    }, 2000);
  }

  async _loadQueuedResult(url) {
    const response = await fetch(url);
    if (!response.ok) {
      $('live-status').textContent = `could not load the result: HTTP ${response.status}`;
      return;
    }
    const fold = await response.json();
    // Straight into the ordinary adoption path: a queued fold is baked into the gallery's
    // own artefact format precisely so nothing downstream needs to know where it came from.
    this._adoptFold(fold);
    const seconds = fold.queued?.seconds;
    $('live-status').textContent = seconds
      ? `folded on the server in ${seconds.toFixed(1)} s, seed ${fold.queued.seed}`
      : 'loaded from the server';
  }

  /* Fold the current protein live, in a worker, streaming frames into the same player. */
  async foldLive() {
    if (!this.liveSupported.ok || !this.fold) return;
    this.playing = false;
    this.audio.stop();
    $('play').textContent = 'Play';
    this._setSource('live');

    const response = await fetch(`/api/native/${encodeURIComponent(this.fold.id)}`);
    if (!response.ok) throw new Error(`native ${this.fold.id}: HTTP ${response.status}`);
    const native = await response.json();

    this.worker?.terminate();
    this.worker = new Worker('/static/js/fold_worker.js', { type: 'module' });
    this.liveFrames = [];
    this.frames = [];
    this.history = { helix: [], sheet: [], coil: [], rg: [] };
    this.contactsSoFar = 0;
    $('live-status').textContent = 'starting the model';

    // A fold the visitor cannot see is a fold the browser may stop. P0-2 measured Safari
    // suspending a worker whose page is hidden, at 0% CPU, and Chrome taking 1.9x as long
    // in a background tab. Neither is a bug ButtFold can fix, so the page says what
    // happened instead of appearing to hang.
    this._watchVisibility();

    const began = performance.now();
    this.worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') {
        $('live-status').textContent = 'folding';
      } else if (message.type === 'frame') {
        this._acceptLiveFrame(message);
      } else if (message.type === 'done') {
        const wall = (performance.now() - began) / 1000;
        $('live-status').textContent =
          `folded ${message.frames} frames in ${message.seconds.toFixed(1)} s `
          + `(${wall.toFixed(1)} s of wall clock), final Q ${message.q.toFixed(3)}`;
        this._finishLive();
      } else if (message.type === 'cancelled') {
        $('live-status').textContent = `stopped after ${message.frames} frames`;
      } else if (message.type === 'error') {
        $('live-status').textContent = `the fold failed: ${message.message}`;
        console.error(message.message);
      }
    };
    this.worker.onerror = (e) => {
      $('live-status').textContent = `the worker failed to start: ${e.message}`;
    };

    this.worker.postMessage({
      type: 'fold',
      foldId: native.id,
      sequence: native.sequence,
      native: native.ca.flat(),
      start: native.coil.flat(),
      steps: native.steps,
      frames: 150,
      params: native.params,
    });
  }

  _acceptLiveFrame(message) {
    const frame = message.frame;
    this.frames.push({
      points: Float32Array.from(frame.points),
      ss: runLengthDecode(frame.ss),
      newContacts: frame.newContacts,
      rg: frame.rg / 10,
      q: frame.q / 1000,
    });
    this.liveFrames.push(frame);
    // Drawn as it arrives: the fold IS the show, so a slow fold that streams frames is
    // content rather than a wait, and a progress bar over a blank stage would be the
    // opposite of the point.
    this._show(this.frames.length - 1);
    $('seek').max = String(this.frames.length - 1);
    const percent = Math.round(100 * message.step / message.steps);
    $('live-status').textContent = `folding, ${percent}% (${this.frames.length} frames)`;
  }

  _finishLive() {
    // The live fold becomes an ordinary fold: same frame objects, same player, same
    // sonifier. Nothing downstream knows where the frames came from.
    this.fold = { ...this.fold, frames: this.liveFrames };
    this.history = { helix: [], sheet: [], coil: [], rg: [] };
    this._rescore();
    this._show(0);
    this.contactsSoFar = 0;
  }

  _watchVisibility() {
    if (this._visibilityWatched) return;
    this._visibilityWatched = true;
    document.addEventListener('visibilitychange', () => {
      if (!this.worker) return;
      if (document.hidden) {
        this._hiddenAt = performance.now();
        this._framesAtHide = this.frames.length;
      } else if (this._hiddenAt) {
        const away = (performance.now() - this._hiddenAt) / 1000;
        const progressed = this.frames.length - this._framesAtHide;
        if (away > 3 && progressed === 0) {
          $('live-status').textContent =
            `your browser paused the fold while this tab was hidden `
            + `(${away.toFixed(0)} s, no frames); it has resumed`;
        }
        this._hiddenAt = null;
      }
    });
  }

  _setSource(source) {
    this.source = source;
    document.querySelectorAll('#engine-mode button').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.source === source)));
    this._updateBadge();
  }

  _updateBadge() {
    $('badge-engine').textContent = ENGINE_BADGE[this.engine] ?? ENGINE_BADGE.go;
    $('badge-where').textContent = WHERE_BADGE[this.source] ?? WHERE_BADGE.baked;
  }

  _show(index) {
    if (!this.frames.length) return;
    this.index = Math.max(0, Math.min(this.frames.length - 1, index));
    const frame = this.frames[this.index];
    this.stage.render(frame.points, frame.ss, frame.confidence);
    this._readouts(frame);
    $('seek').value = String(this.index);
    $('frame-count').textContent =
      `${String(this.index + 1).padStart(3, ' ')} / ${this.frames.length}`;
  }

  _readouts(frame) {
    const n = frame.ss.length || 1;
    const helix = count(frame.ss, 'H'), sheet = count(frame.ss, 'E');
    const coil = n - helix - sheet;
    // Contacts held is a running total of what has formed, which is what the readout is
    // about: the count of onsets so far, not a live geometric recount.
    this.contactsSoFar = this.index === 0
      ? frame.newContacts.length
      : (this.contactsSoFar ?? 0) + frame.newContacts.length;

    $('r-rg').textContent = frame.rg.toFixed(1);
    $('r-q').textContent = `${Math.round(frame.q * 100)}%`;
    $('r-contacts').textContent = String(this.contactsSoFar);
    $('r-helix').textContent = `${Math.round(100 * helix / n)}%`;
    $('r-sheet').textContent = `${Math.round(100 * sheet / n)}%`;
    $('r-coil').textContent = `${Math.round(100 * coil / n)}%`;

    // The charts are drawn from the whole trajectory, not from what has played, so seeking
    // backwards does not erase them and the shape of the fold is legible before you press
    // play. The playhead marks where you are.
    if (!this.history.rg.length) this._buildHistory();
    drawSSChart($('chart-ss'), this.history, this.index);
    drawRgChart($('chart-rg'), this.history.rg, this.index);
  }

  _buildHistory() {
    for (const frame of this.frames) {
      const n = frame.ss.length || 1;
      const helix = count(frame.ss, 'H'), sheet = count(frame.ss, 'E');
      this.history.helix.push(helix / n);
      this.history.sheet.push(sheet / n);
      this.history.coil.push((n - helix - sheet) / n);
      this.history.rg.push(frame.rg);
    }
  }

  _loop(now) {
    const delta = this.lastTick ? (now - this.lastTick) / 1000 : 0;
    this.lastTick = now;
    this.stage.spin(delta);

    if (this.playing && this.frames.length && this.audio.playing) {
      // **The audio clock drives the animation, not the other way round.** A requestAnimationFrame
      // loop and an AudioContext are two independent clocks: rAF is throttled when the tab
      // is not visible and drifts against the sample clock even when it is not, so an
      // animation that advanced itself would slide out of sync with its own soundtrack over
      // the course of a forty-five second piece. Asking the audio where it is costs nothing
      // and cannot drift.
      const frame = this.audio.frameAt(this.audio.positionSeconds);
      if (frame !== this.index) this._show(frame);
      $('seek').value = String(this.index);
      if (this.audio.positionSeconds >= (this.audio.durationSeconds ?? 0)) {
        this.playing = false;
        $('play').textContent = 'Play';
      }
    } else if (this.playing && this.frames.length) {
      // Silent playback, for a browser with no Web Audio or before the first gesture.
      this.accumulator += delta;
      const step = 1 / this.framesPerSecond;
      while (this.accumulator >= step) {
        this.accumulator -= step;
        if (this.index >= this.frames.length - 1) {
          this.playing = false;
          $('play').textContent = 'Play';
          break;
        }
        this._show(this.index + 1);
      }
    } else if (this.frames.length) {
      // Still re-render, because the idle spin moved the camera.
      const frame = this.frames[this.index];
      this.stage.render(frame.points, frame.ss, frame.confidence);
    }
    requestAnimationFrame(t => this._loop(t));
  }

  /* Called straight from the click handler. A browser refuses an AudioContext before a
   * user gesture, and "inside the gesture" means synchronously in the handler: awaiting
   * something first and then constructing the context is too late in Safari. */
  async toggle() {
    if (!this.frames.length) return;
    if (this.playing) {
      this.playing = false;
      this.audio.pause();
      $('play').textContent = 'Play';
      return;
    }
    // Restart from the beginning if it has run to the end, so Play always plays something.
    const restart = this.index >= this.frames.length - 1;
    if (restart) { this.contactsSoFar = 0; this._show(0); }

    this.playing = true;
    $('play').textContent = 'Pause';
    try {
      if (this.audio.available && await this.audio.start()) {
        this.audio.play(restart ? 0 : this._secondsForFrame(this.index));
      }
    } catch (err) {
      // Silent playback rather than no playback: the animation is the point and the sound
      // is the reward, so a browser that refuses an AudioContext still gets the fold.
      $('audio-note').textContent = `Sound unavailable: ${err.message}`;
      console.warn(err);
    }
  }

  _secondsForFrame(index) {
    const entry = this.audio.timeline.find(t => t.moment.frameIndex >= index);
    return entry ? entry.startSeconds : 0;
  }

  _wireControls() {
    $('play').addEventListener('click', () => this.toggle());
    $('volume').addEventListener('input', (e) => {
      this.audio.setVolume(Number(e.target.value) / 100);
    });
    document.querySelectorAll('#style-mode button').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('#style-mode button').forEach(b =>
          b.setAttribute('aria-pressed', String(b === button)));
        this.styleId = button.dataset.style;
        const seconds = this.audio.positionSeconds;
        const wasPlaying = this.playing && this.audio.playing;
        this.audio.pause();
        this._rescore();
        // Style switching keeps its place rather than restarting: a fold that had reached
        // its cadence must not be sent back to the opening chord, which is the one thing a
        // listener hears as a restart even if nothing else changed.
        if (wasPlaying) this.audio.play(Math.min(seconds, this.audio.durationSeconds ?? 0));
        else this.audio.offsetSeconds = Math.min(seconds, this.audio.durationSeconds ?? 0);
      });
    });
    $('seek').addEventListener('input', (e) => {
      this.playing = false;
      this.audio.pause();
      $('play').textContent = 'Play';
      // Recompute the running contact total for the frame seeked to, rather than leaving
      // it wherever playback happened to stop.
      const target = Number(e.target.value);
      this.contactsSoFar = this.frames.slice(0, target + 1)
        .reduce((sum, f) => sum + f.newContacts.length, 0);
      this.audio.seek(this._secondsForFrame(target));
      this._show(target);
    });
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', () => {
        this.playing = false;
        this.audio.stop();
        $('play').textContent = 'Play';
        this.contactsSoFar = 0;
        this.load(card.dataset.foldId);
      });
    });
    document.querySelectorAll('#engine-mode button').forEach(button => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        if (button.dataset.source === 'live') {
          this.foldLive().catch(err => {
            $('live-status').textContent = `could not start: ${err.message}`;
          });
        } else if (button.dataset.source === 'queued') {
          this.foldQueued().catch(err => {
            $('live-status').textContent = `could not reach the server: ${err.message}`;
          });
        } else if (button.dataset.source === 'baked') {
          this.worker?.postMessage({ type: 'cancel' });
          clearInterval(this._queueTimer);
          this.load(this.fold.id);
        }
      });
    });
    document.querySelectorAll('#colour-mode button').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('#colour-mode button').forEach(b =>
          b.setAttribute('aria-pressed', String(b === button)));
        this.stage.setColourMode(button.dataset.mode);
        this._show(this.index);
      });
    });
  }
}

/* What the live fold needs from the browser. Checked once, up front, and reported: a
 * disabled control that says why is more honest than one that is simply absent. */
export function detectLiveSupport() {
  const missing = [];
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof (window.AudioContext ?? window.webkitAudioContext) === 'undefined') {
    missing.push('Web Audio');
  }
  return { ok: missing.length === 0, missing };
}

function count(text, character) {
  let total = 0;
  for (const ch of text) if (ch === character) total++;
  return total;
}

/** "76 residues · Homo sapiens", or "20 residues · designed" for a designed protein. */
export function subtitleFor(fold) {
  if (fold.engine === 'generative') return 'a protein that has never existed';
  const organism = fold.organism || 'designed';
  return `${fold.residueCount} residues · ${organism}`;
}

/* Two sparklines, plain canvas. Two lines do not need a chart library, and pulling one in
 * would be 200 kB to draw 300 points. */

function prepare(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 72;
  if (canvas.width !== w * ratio || canvas.height !== h * ratio) {
    canvas.width = w * ratio;
    canvas.height = h * ratio;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function polyline(ctx, values, w, h, low, high, colour) {
  if (values.length < 2) return;
  const span = (high - low) || 1;
  ctx.beginPath();
  values.forEach((value, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((value - low) / span) * (h - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function playhead(ctx, index, total, w, h) {
  if (total < 2) return;
  const x = (index / (total - 1)) * w;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export function drawSSChart(canvas, history, index) {
  const { ctx, w, h } = prepare(canvas);
  const palette = COLOUR_MODES.structure;
  const hex = v => `#${v.toString(16).padStart(6, '0')}`;
  polyline(ctx, history.coil, w, h, 0, 1, hex(palette.C));
  polyline(ctx, history.sheet, w, h, 0, 1, hex(palette.E));
  polyline(ctx, history.helix, w, h, 0, 1, hex(palette.H));
  playhead(ctx, index, history.helix.length, w, h);
}

export function drawRgChart(canvas, rg, index) {
  const { ctx, w, h } = prepare(canvas);
  if (!rg.length) return;
  // Scaled to the trajectory's own range, so the collapse fills the panel. A fixed 0-to-30
  // axis would draw every fold as a nearly flat line near the top.
  const low = Math.min(...rg), high = Math.max(...rg);
  polyline(ctx, rg, w, h, low, high, '#8FB4FF');
  playhead(ctx, index, rg.length, w, h);
}

const player = new Player();
window.buttfoldPlayer = player;      // the headless screenshot check drives it through this
player.boot().catch(err => {
  document.body.classList.add('no-wasm');
  const note = $('boot-error');
  if (note) note.textContent = `Could not start: ${err.message}`;
  console.error(err);
});
