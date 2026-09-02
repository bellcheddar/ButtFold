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
// The droplet streams raw Angstroms and the frames are built HERE, with the same builder the
// baker and the live worker use. Three engines, one definition of a frame.
import { LiveScale, buildFrame, centre, maxAbs, newTrajectoryState, roundHalfToEven,
         keptFrameIndices, QUANTISED_RANGE } from './frames.js';
import { nativeContacts, perResidueNativeFraction } from './native_contacts.js';
// The in-between poses, which the model never computed and the page says so.
import { morphFrames, newMorphScratch } from './morph.js';
// The two ways the score is drawn: chords struck across the structure between the residues
// that made each note, and the chain unrolled into a strip that lights as they sound.
import { ResidueRibbon } from './ribbon.js';
import { score, compaction } from './Sonifier.js';
import { FoldAudio } from './audio.js';

const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js';

const $ = id => document.getElementById(id);

/* How long a note goes on being drawn after it strikes.
 *
 * A visual decay, not the note's own length: a contact is a semiquaver, which at 96 BPM is
 * 60 ms of audio and would be a single frame on screen - a flicker rather than a strike.
 * 0.9 s is long enough to read and short enough that a sixteen-contact flurry has cleared
 * before the next bar's does, so a busy fold reads as a run of strokes rather than a mesh. */
const SOUNDING_TAIL_SECONDS = 0.9;

/** The chart series, empty. One definition because five places reset them, and a sixth that
 *  forgot a key would draw a chart of `undefined` rather than fail. */
function emptyHistory() {
  return { helix: [], sheet: [], coil: [], rg: [], compact: [], contacts: [], formed: 0 };
}

/* Where this build's assets live, from the tag that loaded this module. Everything fetched
 * at runtime goes through it, so a worker and a style file carry the same version as the
 * module graph and are cached on the same terms. */
const STATIC_BASE = document.currentScript?.dataset.staticBase
  ?? document.querySelector('script[data-static-base]')?.dataset.staticBase
  ?? '/static';

/* The engine badge, which is now where the page states what produced what is on the stage.
 *
 * The amber line under the title that used to carry the app's verbatim disclosure was
 * removed on Marc's instruction, 2026-09-01. The claim did not go with it: this badge sits
 * in the stage's corner, never scrolls away while anything is playing, and names both the
 * engine and where it ran; and the disclosure paragraph below the gallery says it in full,
 * as body text rather than behind a link. PLAN section 7 asked for three placements and
 * there are two. */
const ENGINE_BADGE = {
  go: 'Gō model · toward a known structure',
  generative: 'Genie 2 · invented from noise',
};
/* Keyed on the artefact's own `provenance`, because "toward a known structure" and "toward a
 * structure something predicted" are two different claims and only the artefact knows which
 * one it is. A fold toward a crystal structure cannot be wrong about where it is going; a
 * fold toward a prediction can. */
const PROVENANCE_BADGE = {
  'esmfold-prediction-go': 'ESMFold → Gō model · toward a predicted structure',
};
const WHERE_BADGE = {
  baked: 'precomputed',
  live: 'in your browser',
  queued: 'on the server',
};
/* The prediction does not happen on our server and the badge must not imply it does.
 * ESMFold v1 is an 8.44 GB checkpoint and the droplet has 3.9 GB with no swap, so it runs at
 * Meta's ESM Atlas and only the Gō model runs here. */
const PREDICTED_WHERE = 'predicted at Meta, folded here';

/* The badge reads as one sentence: engine, then where, then what is happening. So the status
 * has to agree with the place beside it. It used to be a separate paragraph under the
 * transport, which could say "folding on the server" while the badge said "precomputed" -
 * two lines contradicting each other about the same fold. `_status` is the only way anything
 * writes there, and it sets the place at the same time. */

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
    // Where silent playback has got to, as a fractional frame. Reset wherever the trajectory
    // frame is set from outside - a seek, a restart, a new fold - or it would resume from
    // where the last silent run stopped.
    this.silentPosition = 0;
    this.history = emptyHistory();
    this.audio = new FoldAudio();
    this.styleId = 'fantasy';
    this.styles = {};
    this.scored = null;
    this.worker = null;
    // Both drawings of the score, together, behind one control. On by default: they are
    // the point of the app, and a visitor who does not want them can say so.
    this.showMusic = true;
    this.streamedFrames = [];
    this.liveSupported = detectLiveSupport();
    // A different seed each time the server is asked, so "fold it again" is a genuinely
    // different trajectory rather than a cache hit that looks like a very fast fold. The
    // coil is fixed and only the random force changes, which is exactly the perturbation
    // P0-3b measured: same funnel, different path through it.
    this.queueSeed = 1 + Math.floor(Math.random() * 1_000_000);
    this._queueTimer = null;
  }

  async boot() {
    const [THREE] = await Promise.all([
      import(THREE_URL), this._loadStyles(), this._loadUniprot()]);
    this.stage = new Stage($('stage'), THREE);
    this.ribbon = new ResidueRibbon($('residue-ribbon'));
    this._wireControls();
    this._applyLiveSupport();
    const first = document.querySelector('.card');
    await this.load(first?.dataset.foldId ?? 'trp_cage');
    requestAnimationFrame(t => this._loop(t));
  }

  /* The ESMFold catalogue, into the pulldown.
   *
   * Fetched once at boot rather than when the engine is picked: it is a couple of kilobytes
   * and a pulldown that populates on click is a pulldown that is briefly empty. If the
   * route fails the control says so and disables itself, because an empty select beside an
   * enabled engine button is the worst of both.
   */
  async _loadUniprot() {
    const select = $('uniprot-pick');
    try {
      const response = await fetch('/api/uniprot');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      this.uniprot = body.entries ?? [];
      if (!this.uniprot.length) throw new Error('the catalogue is empty');
      select.innerHTML = '';
      for (const entry of this.uniprot) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = `${entry.name} · ${entry.residueCount} aa · ${entry.organism}`;
        select.appendChild(option);
      }
      this._pickUniprot(this.uniprot[0].id);
      select.addEventListener('change', () => this._pickUniprot(select.value));
    } catch (err) {
      select.disabled = true;
      $('uniprot-note').textContent = `the catalogue could not be loaded: ${err.message}`;
      const button = document.querySelector('#engine-mode button[data-source="queued"]');
      if (button) { button.disabled = true; button.title = 'The UniProt catalogue is unavailable'; }
    }
  }

  /** Turn the music's drawings on and off together.
   *
   * Off, the stage is the plain cartoon fold: no chords, no lit residues, no strip. The
   * clearing happens here rather than being left to the render loop, because a paused page
   * never reaches the loop's playing branch - a stage turned off mid-pause would otherwise
   * keep the last chord struck on it until something else moved.
   */
  setShowMusic(on) {
    this.showMusic = !!on;
    $('stage').classList.toggle('no-music', !this.showMusic);
    if (!this.showMusic) {
      this.stage.clearSounding();
      this.ribbon?.setSounding([]);
    }
    if (this.frames.length) this._showAt(this.rendered ?? this.index);
  }

  /* The row is above the stage, so showing it takes height from the stage rather than from
   * the page: without that the readouts went 42 px below the fold the moment this appeared. */
  _showUniprot(visible) {
    $('uniprot-row').hidden = !visible;
    document.body.classList.toggle('picking-uniprot', visible);
  }

  _pickUniprot(id) {
    const entry = this.uniprot?.find(e => e.id === id);
    if (!entry) return;
    this.uniprotId = id;
    $('uniprot-pick').value = id;
    // ESMFold's own confidence in the structure the Gō model will fold toward, stated where
    // the choice is made. It is the one number that says how much to trust the target.
    $('uniprot-note').textContent =
      `${entry.accession} · ESMFold pLDDT ${entry.meanPlddt.toFixed(2)}`
      + (entry.pdbs?.length ? ` · PDB ${entry.pdbs[0]}` : '');
  }

  async _loadStyles() {
    // Every style the page offers, loaded up front: they are a few kilobytes each and
    // switching style must be instant and beat-quantised, never a fetch and a stall.
    const ids = [...document.querySelectorAll('#style-mode button')]
      .map(b => b.dataset.style);
    const loaded = await Promise.all(ids.map(async id => {
      const response = await fetch(`${STATIC_BASE}/styles/${id}.json`);
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
    this._status('');
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
      // P-SEA's certainty per residue, which the cartoon sweeps its cross section from: it
      // is what makes a ribbon grow in rather than snap from cord to slab. A different
      // quantity from `confidence` above, which is how much of the fold has happened.
      ssConfidence: frame.ssConf ? Float32Array.from(frame.ssConf, c => c / 100) : null,
      rg: frame.rg / 10,
      q: frame.q / 1000,
    }));
    this.index = 0;
    this.silentPosition = 0;
    this._readoutsDrawn = false;
    this.contactsSoFar = 0;
    this.history = emptyHistory();
    this.stage.setResidueCount(fold.residueCount, fold.angstromsPerUnit);
    // A finished artefact is scaled so its widest frame touches the edge of the box, so the
    // box IS the extent. Set explicitly because the fold before this one may have been a
    // stream, which frames on less than the box.
    this.stage.setViewExtent(QUANTISED_RANGE);
    this.stage.setSequence(fold.sequence);

    $('protein-name').textContent = fold.name;
    $('protein-sub').textContent = subtitleFor(fold);
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
    // On the transport's own tooltip rather than in a line of body text, on Marc's
    // instruction, 2026-09-01. PLAN section 5.3's honesty rule is about the figure being
    // stated rather than hidden, and it still is: a trajectory that loses most of its
    // contact events to the per-bar cap says so, one hover from the Play button.
    $('score-summary').title =
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
    this.queuedStream = null;
    this._status('asking', 'queued');

    const response = await fetch('/api/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The UniProt pick when the ESMFold engine is chosen, and the loaded gallery protein
      // otherwise. Both go through one route and one queue: the only difference is where
      // the native state the model folds toward came from.
      body: JSON.stringify({ protein_id: this.uniprotId ?? this.fold.id,
                             seed: this.queueSeed }),
    });
    const body = await response.json().catch(() => ({}));

    if (response.status === 429) {
      // Not an error: it is the cap doing its job, and the gallery is right there.
      this._status(`queue full, try again shortly`);
      $('audio-note').textContent = body.error;
      return;
    }
    if (!response.ok && response.status !== 202) {
      this._status(`refused: ${body.error ?? response.status}`);
      return;
    }
    if (body.cached) {
      this._status('already computed, loading');
      await this._loadQueuedResult(body.result_url);
      return;
    }
    this._status('queued');
    this._pollQueue(body.job_id);
  }

  _pollQueue(jobId) {
    clearInterval(this._queueTimer);
    // 750 ms rather than the 2 s this used while it was polling a percentage. The droplet
    // writes about six frames a second under its CPU quota, so a tick brings four or five
    // and the structure turns and collapses at something close to the rate it is being
    // computed at. Each pull is a few kilobytes of coordinates the server has already
    // written to disk.
    this._queueTimer = setInterval(() => {
      // A tick now fetches frames as well as status, and a slow one must not have a second
      // started on top of it: two overlapping pulls would both ask from the same frame
      // index and each append the answer, so the trajectory would contain every frame
      // twice.
      if (this._queueTicking) return;
      this._queueTicking = true;
      this._queueTick(jobId).finally(() => { this._queueTicking = false; });
    }, 750);
  }

  async _queueTick(jobId) {
    let status;
    try {
      const response = await fetch(`/api/queue/${jobId}`);
      status = await response.json();
    } catch (err) {
      this._status(`lost contact: ${err.message}`);
      clearInterval(this._queueTimer);
      return;
    }

    if (status.state === 'queued') {
      // The badge already says "on the server", so the status says only what is new.
      this._status(`queued, position ${status.position} of one at a time`);
      return;
    }

    if (status.state === 'running') {
      try {
        if (!this.queuedStream) await this._openQueuedStream(status);
        await this._pullQueuedFrames(jobId);
      } catch (err) {
        // A stream that cannot be opened is not a fold that has failed. The job carries on
        // on the droplet and its finished artefact still arrives, so this drops back to
        // the percentage rather than throwing the fold away.
        this.queuedStream = null;
        console.warn('streaming the queued fold failed, falling back to progress', err);
      }
      const percent = status.frames_total
        ? Math.round(100 * status.frames_done / status.frames_total) : 0;
      this._status(this.frames.length
        ? `folding, ${percent}% (${this.frames.length} frames)`
        : `folding, ${percent}%`);
      return;
    }

    clearInterval(this._queueTimer);
    this.queuedStream = null;
    if (status.state === 'done') {
      // The finished artefact replaces the preview. It is the canonical result - scaled
      // from the widest frame of the whole trajectory, which a stream cannot know until it
      // ends - and adopting it is what gives the fold its sonification and its seek bar.
      await this._loadQueuedResult(status.result_url);
    } else {
      // Reported honestly, the timeout included. A job that was killed says so.
      this._status(`${status.state}${status.error ? `: ${status.error}` : ''}`);
    }
  }

  /* Open a stream onto a job the droplet is running, so its trajectory appears here as it
   * is computed rather than half a minute later.
   *
   * The server path used to be a percentage over a still picture: the droplet folded for
   * twenty-five seconds while a number climbed, and the same protein folding in the browser
   * beside it turned and collapsed the whole time. Two engines, and only one of them looked
   * like anything was happening.
   *
   * What comes back is raw Angstroms, not finished frames, so the browser runs the same
   * `frames.js` over them that the worker runs on its own output. Contacts, secondary
   * structure and per-residue confidence are computed here, on this thread: 76 residues is
   * a millisecond or so a frame and there are a few frames per tick. */
  async _openQueuedStream(status) {
    // A predicted native is not on disk here - it lives at Meta and then in the server's
    // own cache - so the stream asks the job for it rather than the gallery. Same shape,
    // same contact map, same builder.
    const source = status.protein_id?.startsWith('uniprot:')
      ? `/api/queue/${encodeURIComponent(status.job_id)}/native`
      : `/api/native/${encodeURIComponent(this.fold.id)}`;
    const response = await fetch(source);
    if (!response.ok) throw new Error(`native: HTTP ${response.status}`);
    const native = await response.json();
    const flat = Float64Array.from(native.ca.flat());
    const n = flat.length / 3;
    this.queuedStream = {
      n,
      // The same contact map the C built the model from, by the same rule.
      pairs: nativeContacts(flat, native.params.cutoff, native.params.minSep),
      state: newTrajectoryState(n),
      // The raw indices the artefact will keep. Everything else is read off the wire and
      // thrown away without being built, so the preview runs at the artefact's pace and
      // ends on the same number of frames rather than halving when the result lands.
      keep: keptFrameIndices(status.frames_total, status.frame_cap),
      scale: null,
      next: 0,
    };
    this.residueCount = n;
    this.frames = [];
    this.streamedFrames = [];
    this.history = emptyHistory();
    this.contactsSoFar = 0;
    this._readoutsDrawn = false;
  }

  async _pullQueuedFrames(jobId) {
    const stream = this.queuedStream;
    if (!stream) return;
    const response = await fetch(`/api/queue/${jobId}/frames?from=${stream.next}`);
    if (!response.ok) return;
    const raw = new Float32Array(await response.arrayBuffer());
    const stride = stream.n * 3;
    // The route only ever returns whole frames, but the floor is kept anyway: a torn frame
    // is half of one step's coordinates and half of the next's, which is a structure that
    // never existed, and it would be drawn without complaint.
    const count = Math.floor(raw.length / stride);
    const built = [];
    for (let f = 0; f < count; f++) {
      // Skipped before anything is computed: a dropped frame must not reach the contact
      // tracker or the hysteresis either, or the preview's secondary structure would be
      // smoothed over twice as many steps as the artefact's.
      if (stream.keep && !stream.keep.has(stream.next + f)) continue;
      // Float64 for the geometry, exactly as the worker does when it copies out of the
      // module's float32 heap. Same builder, same widths, same frames.
      const points = Float64Array.from(raw.subarray(f * stride, (f + 1) * stride));
      const extent = maxAbs(centre(points));
      stream.scale ??= new LiveScale(extent);
      const units = stream.scale.accommodate(extent);
      const { confidence, q } = perResidueNativeFraction(points, stream.pairs, stream.n);
      const frame = buildFrame(points, units, stream.state.tracker, stream.state.smoother,
                               confidence);
      frame.q = roundHalfToEven(q * 1000);
      built.push(frame);
    }
    stream.next += count;
    for (let i = 0; i < built.length; i++) {
      this._ingestFrame(built[i], stream.scale.angstromsPerUnit, stream.scale.occupiedUnits,
                        i === built.length - 1);
    }
  }

  async _loadQueuedResult(url) {
    const response = await fetch(url);
    if (!response.ok) {
      this._status(`could not load the result: HTTP ${response.status}`);
      return;
    }
    const fold = await response.json();
    // Straight into the ordinary adoption path: a queued fold is baked into the gallery's
    // own artefact format precisely so nothing downstream needs to know where it came from.
    this._adoptFold(fold);
    const seconds = fold.queued?.seconds;
    this._status(seconds ? `folded in ${seconds.toFixed(1)} s, seed ${fold.queued.seed}`
                         : 'loaded', 'queued');
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
    this.worker = new Worker(`${STATIC_BASE}/js/fold_worker.js`, { type: 'module' });
    this.streamedFrames = [];
    this.frames = [];
    this.history = emptyHistory();
    this.contactsSoFar = 0;
    // The first streamed frame is index 0, which is where the previous fold left `index`,
    // so without this the readouts would sit on the old fold's numbers until frame 2.
    this._readoutsDrawn = false;
    this._status('starting the model', 'live');

    // A fold the visitor cannot see is a fold the browser may stop. P0-2 measured Safari
    // suspending a worker whose page is hidden, at 0% CPU, and Chrome taking 1.9x as long
    // in a background tab. Neither is a bug ButtFold can fix, so the page says what
    // happened instead of appearing to hang.
    this._watchVisibility();

    const began = performance.now();
    this.worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'ready') {
        this._status('folding');
      } else if (message.type === 'frame') {
        this._acceptLiveFrame(message);
      } else if (message.type === 'done') {
        const wall = (performance.now() - began) / 1000;
        this._status(`folded ${message.frames} frames in ${message.seconds.toFixed(1)} s, `
                     + `final Q ${message.q.toFixed(3)}`);
        void wall;
        this._finishLive();
      } else if (message.type === 'cancelled') {
        this._status(`stopped after ${message.frames} frames`);
      } else if (message.type === 'error') {
        this._status(`the fold failed: ${message.message}`);
        console.error(message.message);
      }
    };
    // A worker that cannot load its own module graph fires `error` with an EMPTY message:
    // the browser will not say which import failed, for cross-origin reasons that apply
    // even same-origin. That is what "the worker failed to start: undefined" was, and the
    // cause was nginx serving `go_model.mjs` as application/octet-stream, which a browser
    // refuses to import as a module. So the message says where to look rather than
    // repeating a blank.
    this.worker.onerror = (e) => {
      const detail = e.message || 'the browser gave no reason, which usually means one of '
        + 'its imports was served with the wrong content type';
      this._status(`the fold could not start: ${detail}`);
      console.error('worker failed to start', e);
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
    // Drawn as it arrives: the fold IS the show, so a slow fold that streams frames is
    // content rather than a wait, and a progress bar over a blank stage would be the
    // opposite of the point.
    this._ingestFrame(message.frame, message.angstromsPerUnit, message.occupiedUnits);
    const percent = Math.round(100 * message.step / message.steps);
    this._status(`folding, ${percent}% (${this.frames.length} frames)`);
  }

  /* One frame from a source that streams: the live worker, or the droplet.
   *
   * Both call this, which is the point. A streamed frame reaches the stage through exactly
   * the conversion `_adoptFold` gives a baked one, so what a visitor watches during a fold
   * and what they play back afterwards are the same object built the same way. */
  _ingestFrame(frame, angstromsPerUnit, occupiedUnits, draw = true) {
    const decoded = {
      points: Float32Array.from(frame.points),
      ss: runLengthDecode(frame.ss),
      newContacts: frame.newContacts,
      // These two were dropped, and dropping them cost the live fold its cartoon. The
      // ribbon's cross section is swept from `ssConf`, so with no certainty to sweep every
      // residue drew as coil: a live fold was a wriggling string until the last frame, at
      // which point `_finishLive` re-adopted the trajectory through the path above and the
      // helices and sheets all appeared at once. `conf` is the other half, and without it
      // the confidence colour mode painted the whole chain one flat below-fifty orange.
      confidence: frame.conf?.length ? Float32Array.from(frame.conf, c => c / 100) : null,
      ssConfidence: frame.ssConf?.length
        ? Float32Array.from(frame.ssConf, c => c / 100) : null,
      rg: frame.rg / 10,
      q: frame.q / 1000,
    };
    this.frames.push(decoded);
    this.streamedFrames.push(frame);
    // BEFORE `_show`, which draws the charts from it. The whole point of a streamed fold is
    // that the secondary structure and the radius of gyration are drawn as they happen.
    this._appendHistory(decoded);
    // A changed ruler rebuilds the mesh, so both of these are no-ops unless the scale
    // actually moved, which `LiveScale` is built to make rare.
    if (angstromsPerUnit) this.stage.setResidueCount(this.residueCount, angstromsPerUnit);
    if (occupiedUnits) this.stage.setViewExtent(occupiedUnits);
    // A batch of frames arriving together is drawn ONCE. The droplet delivers four or five
    // per tick and they are ingested in a single task, so the browser composites after the
    // last of them either way: drawing the first four is work whose result is overwritten
    // before it can reach the screen. The live worker posts one frame per message and
    // always draws.
    if (draw) {
      this._show(this.frames.length - 1);
      $('seek').max = String(this.frames.length - 1);
    }
  }

  _finishLive() {
    // The live fold becomes an ordinary fold: same frame objects, same player, same
    // sonifier. Nothing downstream knows where the frames came from.
    this.fold = { ...this.fold, frames: this.streamedFrames };
    this.history = emptyHistory();
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
          this._status(`paused while the tab was hidden for ${away.toFixed(0)} s, resumed`);
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
    const provenance = this.fold?.provenance;
    $('badge-engine').textContent =
      PROVENANCE_BADGE[provenance] ?? ENGINE_BADGE[this.engine] ?? ENGINE_BADGE.go;
    $('badge-where').textContent = provenance === 'esmfold-prediction-go'
      ? PREDICTED_WHERE
      : (WHERE_BADGE[this.source] ?? WHERE_BADGE.baked);
  }

  /** Say what is happening, in the badge, beside what is producing it.
   *
   * `where` is set here rather than left to drift: the place and the status are one claim,
   * and a status of "folding" next to a place of "precomputed" is a page arguing with
   * itself. Passing null leaves the place alone, for a message about the current source.
   */
  _status(text, where = null) {
    if (where) this._setSource(where);
    $('live-status').textContent = text ?? '';
  }

  /** Show a whole frame. Everything that navigates - seeking, loading, stepping - lands
   *  here, and only playback asks for anything in between. */
  _show(index) {
    this._showAt(Math.round(index));
  }

  /**
   * Draw the trajectory at a fractional frame position.
   *
   * At a whole number this is the frame itself and nothing is invented. In between it is a
   * morph: see `morph.js` for why a lerp alone tears the chain and what is done about it.
   * The READOUTS do not move with it - they are per-frame measurements of the model, not
   * of the picture, so they change when the frame does and not sixty times a second. Which
   * also keeps seven DOM writes out of the render loop.
   */
  _showAt(position) {
    if (!this.frames.length) return;
    const last = this.frames.length - 1;
    const clamped = Math.max(0, Math.min(last, position));
    const index = Math.min(Math.floor(clamped), last);
    const t = clamped - index;
    const frame = this.frames[index];

    if (t > 1e-4 && index < last) {
      const n = this.residueCount ?? frame.ss.length;
      if (!this._morph || this._morph.n !== n) this._morph = newMorphScratch(n);
      const pose = morphFrames(frame, this.frames[index + 1], t, this._morph);
      this.stage.render(pose.points, pose.ss, pose.confidence, pose.ssConfidence);
    } else {
      this.stage.render(frame.points, frame.ss, frame.confidence, frame.ssConfidence);
    }
    this.rendered = clamped;
    // The strip is a sequence view of the structure as well as a note display, so it
    // follows the frame whether or not anything is playing: at rest it re-forms as the fold
    // does, which is why it is drawn on a paused page rather than being blank until Play.
    if (this.ribbon && this.showMusic) {
      this.ribbon.setStructure(frame.ss);
      this.ribbon.draw();
    }

    if (index !== this.index || !this._readoutsDrawn) {
      this.index = index;
      this._readoutsDrawn = true;
      this._readouts(frame);
      $('seek').value = String(index);
      $('frame-count').textContent =
        `${String(index + 1).padStart(3, ' ')} / ${this.frames.length}`;
    }
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

    // **Two engines, two questions, so two sets of labels.**
    //
    // "Compact" and "Native" are answers about a fold: how far along the collapse is, and
    // how much of the known structure has formed. A Genie 2 trajectory has no native to be
    // near and does not collapse - it starts as a ball of noise tighter than any protein and
    // opens out - so `compaction` clamps to 1 on frame one and both readouts sat at a
    // motionless 100% while the picture changed completely. Reading "NATIVE 100%" about a
    // structure that never existed is the sort of quiet false claim this app exists not to
    // make, so the generative engine gets the two measures that do move for it: how near the
    // size of a folded protein of this length it has reached, and how much of its own final
    // geometry is in place.
    const generative = this.engine === 'generative';
    $('k-compact').textContent = generative ? 'Size' : 'Compact';
    $('k-q').textContent = generative ? 'Emerged' : 'Native';
    // The legend is the colour key now, so the engine-specific word lives in the title:
    // "compaction" is the wrong noun for a trajectory that opens out.
    $('rg-title').textContent = generative
      ? 'Radius, size and contacts over time'
      : 'Radius, compaction and contacts over time';

    $('r-rg').textContent = frame.rg.toFixed(1);
    // The other standard measure of a chain's size, and the one that says something the
    // radius of gyration does not: a chain can compact while its termini stay apart, which
    // is what a two-domain collapse looks like on the way in. Computed here from the frame's
    // own quantised coordinates and the stage's ruler rather than baked into the artefact,
    // so it needed no re-bake of the gallery and it is the same arithmetic for a streamed
    // frame as for a stored one.
    $('r-ends').textContent = endToEnd(frame.points, this.stage.angstromsPerUnit).toFixed(1);
    // 0 at the denatured radius of gyration for a chain this length and 1 at the native
    // one, both from measured scaling laws. The same function the sonifier drives its
    // accelerando from, so the number on screen and the tempo cannot disagree.
    $('r-compact').textContent = generative
      // Against the folded-globule scaling for this length, which is the same law the
      // catalogue screen and the sonifier both use. It runs from about 9% to 100%.
      ? `${Math.round(100 * frame.rg / (2.2 * Math.pow(this.residueCount, 0.38)))}%`
      : `${Math.round(compaction(frame.rg, this.residueCount) * 100)}%`;
    $('r-q').textContent = `${Math.round(frame.q * 100)}%`;
    $('r-contacts').textContent = String(this.contactsSoFar);
    $('r-helix').textContent = `${Math.round(100 * helix / n)}%`;
    $('r-sheet').textContent = `${Math.round(100 * sheet / n)}%`;
    $('r-coil').textContent = `${Math.round(100 * coil / n)}%`;

    // The charts are drawn from the whole trajectory, not from what has played, so seeking
    // backwards does not erase them and the shape of the fold is legible before you press
    // play. The playhead marks where you are.
    //
    // For a fold that ARRIVES a frame at a time this is filled in by `_appendHistory` as
    // each frame lands, so the two charts draw themselves during the fold. The lazy build
    // here is for a whole trajectory adopted at once, and it used to be the only one: a
    // live fold built the history from its single first frame, found it non-empty ever
    // after, and drew the same two points for the whole fold while the structure collapsed
    // beside them.
    if (!this.history.rg.length) this._buildHistory();
    drawSSChart($('chart-ss'), this.history, this.index);
    drawRgChart($('chart-rg'), this.history, this.index);
  }

  _buildHistory() {
    for (const frame of this.frames) this._appendHistory(frame);
  }

  /** One frame's contribution to the two charts. The only place they are computed, so a
   *  streamed fold and an adopted one plot the same quantity. */
  _appendHistory(frame) {
    const n = frame.ss.length || 1;
    const helix = count(frame.ss, 'H'), sheet = count(frame.ss, 'E');
    this.history.helix.push(helix / n);
    this.history.sheet.push(sheet / n);
    this.history.coil.push((n - helix - sheet) / n);
    this.history.rg.push(frame.rg);
    // Compaction on the 0..1 axis the fractions already use. For a generative fold that
    // measure is pinned at 1 for the whole trajectory, so it plots the same thing the
    // readout does there: how near the size of a folded protein of this length it has got.
    this.history.compact.push(this.engine === 'generative'
      ? Math.min(frame.rg / (2.2 * Math.pow(this.residueCount || 1, 0.38)), 1)
      : compaction(frame.rg, this.residueCount));
    // A running total, which is what the readout beside it counts. Normalised at draw time
    // rather than here, because a streamed fold does not know its final total yet.
    this.history.formed += frame.newContacts.length;
    this.history.contacts.push(this.history.formed);
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
      // A FRACTIONAL frame position, so the structure moves on every redraw rather than
      // once every fifteen. 150 frames across about forty seconds of music is four frames a
      // second, and holding each pose for fifteen redraws is exactly what looked like
      // jumping. The clock is still the audio's, so a machine that cannot sweep at 60 Hz
      // draws fewer poses and stays in time rather than sliding out of it.
      // **Asked of the audio clock, not pushed by the scheduler.** The scheduler queues a
      // second ahead, so a visual driven from it would run ahead of its own music; asking
      // what is sounding NOW cannot drift, because it is the same clock the frame comes
      // from. Both drawings take the same event list, so a chord and its two lit cells are
      // by construction the same note.
      // Said out loud rather than left as a mystery: a context can report "running", take
      // every note the scheduler gives it, and produce nothing. The page has no way to hear
      // itself, so the one thing it can do is notice and say so.
      const trouble = this.audio.diagnose();
      if (trouble !== this._audioTrouble) {
        this._audioTrouble = trouble;
        $('audio-note').textContent = trouble ?? '';
      }

      if (this.showMusic) {
        const heard = this.audio.notesSounding(this.audio.positionSeconds,
                                               SOUNDING_TAIL_SECONDS);
        this.stage.setSounding(heard);
        this.ribbon?.setSounding(heard);
      }

      // Drawn every frame while playing, rather than only when the trajectory position
      // moves: the chords and the lit cells change on every one of them even when the
      // structure has not, and since interpolation landed the position changes on nearly
      // every frame anyway, so the old skip was saving almost nothing.
      //
      // `setSounding` above ran against the pose drawn LAST frame, so a chord's endpoints
      // trail the structure by one frame - about sixteen milliseconds, over which an alpha
      // carbon moves well under an Angstrom. Setting the glow before the sweep is what lets
      // the sweep paint it in one pass instead of painting the mesh twice.
      this._showAt(this.audio.frameAtFractional(this.audio.positionSeconds));
      if (this.audio.positionSeconds >= (this.audio.durationSeconds ?? 0)) {
        this.playing = false;
        $('play').textContent = 'Play';
      }
    } else if (this.playing && this.frames.length) {
      // Report here too. This is the branch a browser that refused the audio ends up in,
      // and it was the one branch that never asked what went wrong - which is why a Safari
      // that would not play showed no message at all.
      const trouble = this.audio.diagnose();
      if (trouble !== this._audioTrouble) {
        this._audioTrouble = trouble;
        $('audio-note').textContent = trouble ?? '';
      }
      // Silent playback, for a browser with no Web Audio or before the first gesture. A
      // float rather than a whole-frame step, for the same reason as above: there is no
      // audio clock to follow here, so this one advances itself and is still drawn in
      // between.
      this.silentPosition = (this.silentPosition ?? this.index)
                            + delta * this.framesPerSecond;
      if (this.silentPosition >= this.frames.length - 1) {
        this.silentPosition = this.frames.length - 1;
        this.playing = false;
        $('play').textContent = 'Play';
      }
      this._showAt(this.silentPosition);
    } else if (this.frames.length) {
      // The camera moved, not the protein: draw the scene again without re-sweeping it.
      // The chords are cleared once on the way into this state rather than every frame,
      // because a paused page should hold its structure and not its last chord.
      if (this.stage.chordsDrawn) {
        this.stage.clearSounding();
        this.ribbon?.setSounding([]);
        this._showAt(this.rendered);
      }
      this.stage.redraw();
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
      if (this._audioTrouble) { this._audioTrouble = null; $('audio-note').textContent = ''; }
      return;
    }
    // Restart from the beginning if it has run to the end, so Play always plays something.
    const restart = this.index >= this.frames.length - 1;
    if (restart) { this.contactsSoFar = 0; this._show(0); }
    this.silentPosition = restart ? 0 : this.index;

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
    $('music-toggle').addEventListener('change', (e) => this.setShowMusic(e.target.checked));
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
      this.silentPosition = target;
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
          this._showUniprot(false);
          this.foldLive().catch(err => this._status(`could not start: ${err.message}`));
        } else if (button.dataset.source === 'queued') {
          this._showUniprot(true);
          this.foldQueued().catch(err => this._status(`could not reach the server: ${err.message}`));
        } else if (button.dataset.source === 'baked') {
          this._showUniprot(false);
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
        // A colour change repaints, which means a sweep: the paint is written into the same
        // buffers the sweep fills.
        this.rendered = -1;
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

/**
 * A centred moving average.
 *
 * The radius of gyration of a Langevin trajectory is genuinely noisy - the chain rattles
 * against its own thermal energy at every step - so the raw trace is a band of hair with the
 * collapse buried in it. Averaging shows the collapse, which is what the chart is for.
 *
 * **Centred, and the window is stated on the chart.** A trailing average would shift the
 * collapse later than it happened, which on a plot whose whole subject is when things
 * occurred would be a lie. The ends shrink the window rather than padding, so nothing is
 * invented outside the data.
 */
function smoothed(values, window) {
  if (values.length < 3 || window < 2) return values;
  const half = Math.floor(window / 2);
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length - 1, i + half);
    let total = 0;
    for (let k = from; k <= to; k++) total += values[k];
    out[i] = total / (to - from + 1);
  }
  return out;
}

/** A line through the points, rounded at every joint.
 *
 * Each segment is drawn as a quadratic through the midpoints of consecutive spans, which is
 * the standard way to round a polyline without it departing from the data: the curve passes
 * through every midpoint and is pulled toward every sample. Straight `lineTo` segments left
 * visible corners at 150 points across 400 pixels. */
/** Distance between the first and last alpha carbon, in Angstroms.
 *
 * `points` are quantised units, which is what everything downstream of the frame builder
 * carries, so the stage's ruler converts back. A frame drawn against the wrong ruler would
 * show a wrong distance rather than a wrong size, which is exactly why the ruler now travels
 * with a streamed frame instead of being read off the previously loaded artefact. */
export function endToEnd(points, angstromsPerUnit) {
  const last = points.length - 3;
  if (last < 3 || !(angstromsPerUnit > 0)) return 0;
  const dx = points[last] - points[0];
  const dy = points[last + 1] - points[1];
  const dz = points[last + 2] - points[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * angstromsPerUnit;
}

function polyline(ctx, values, w, h, low, high, colour, window = 1) {
  const series = window > 1 ? smoothed(values, window) : values;
  if (series.length < 2) return;
  const span = (high - low) || 1;
  const px = i => (i / (series.length - 1)) * w;
  const py = i => h - ((series[i] - low) / span) * (h - 4) - 2;

  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  for (let i = 1; i < series.length - 1; i++) {
    const midX = (px(i) + px(i + 1)) / 2;
    const midY = (py(i) + py(i + 1)) / 2;
    ctx.quadraticCurveTo(px(i), py(i), midX, midY);
  }
  ctx.lineTo(px(series.length - 1), py(series.length - 1));
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.7;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

/* How many frames each chart averages over. Five for secondary structure, which changes in
 * whole residues and is already smoothed in time by the assigner's own hysteresis, and nine
 * for the radius of gyration, which is the noisier of the two by far. Both are a small
 * fraction of a 150-frame trajectory, so a real feature cannot be averaged away: the
 * collapse takes tens of frames. */
export const SS_SMOOTHING = 5;
export const RG_SMOOTHING = 9;

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
  polyline(ctx, history.coil, w, h, 0, 1, hex(palette.C), SS_SMOOTHING);
  polyline(ctx, history.sheet, w, h, 0, 1, hex(palette.E), SS_SMOOTHING);
  polyline(ctx, history.helix, w, h, 0, 1, hex(palette.H), SS_SMOOTHING);
  playhead(ctx, index, history.helix.length, w, h);
}

/* Three traces that measure three different things, on one panel.
 *
 * The radius is a length in Angstroms with no natural zero, so it is scaled to its own
 * SMOOTHED range - scaling to the raw range leaves the smoothed trace in a thin band up the
 * middle with nothing above and below it but the noise that was just removed. Compaction is
 * already a 0 to 1 fraction. Contacts is a running total, normalised to however many have
 * formed by the last frame drawn.
 *
 * So the axis means "each trace across its own range", which the legend says on hover
 * rather than in a line of type: this is a sparkline panel, and what it is for is the SHAPE
 * of the three curves against each other and against the playhead. The numbers themselves
 * are in the readouts under the stage, to the pixel.
 */
export const RG_COLOURS = { radius: '#8FB4FF', compact: '#FCB900', contacts: '#3DDC97' };

export function drawRgChart(canvas, history, index) {
  const { ctx, w, h } = prepare(canvas);
  const rg = history.rg ?? [];
  if (!rg.length) return;
  const series = smoothed(rg, RG_SMOOTHING);
  const low = Math.min(...series), high = Math.max(...series);
  const total = history.contacts[history.contacts.length - 1] || 1;
  // Radius last, so the trace the panel is named for is the one on top where they cross.
  polyline(ctx, history.contacts.map(v => v / total), w, h, 0, 1,
           RG_COLOURS.contacts, RG_SMOOTHING);
  polyline(ctx, history.compact, w, h, 0, 1, RG_COLOURS.compact, RG_SMOOTHING);
  polyline(ctx, rg, w, h, low, high, RG_COLOURS.radius, RG_SMOOTHING);
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
