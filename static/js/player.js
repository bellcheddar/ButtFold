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
  }

  async boot() {
    const THREE = await import(THREE_URL);
    this.stage = new Stage($('stage'), THREE);
    this._wireControls();
    const first = document.querySelector('.card');
    await this.load(first?.dataset.foldId ?? 'trp_cage');
    requestAnimationFrame(t => this._loop(t));
  }

  async load(foldId) {
    const response = await fetch(`/api/fold/${encodeURIComponent(foldId)}`);
    if (!response.ok) throw new Error(`fold ${foldId}: HTTP ${response.status}`);
    const fold = await response.json();

    this.fold = fold;
    this.engine = fold.engine ?? 'go';
    this.residueCount = fold.residueCount;
    // Decoded once here rather than per frame: the run-length string is compact on the
    // wire and expensive to expand sixty times a second.
    this.frames = fold.frames.map(frame => ({
      points: Float32Array.from(frame.points),
      ss: runLengthDecode(frame.ss),
      newContacts: frame.newContacts,
      rg: frame.rg / 10,
      q: frame.q / 1000,
    }));
    this.index = 0;
    this.history = { helix: [], sheet: [], coil: [], rg: [] };
    this.stage.setResidueCount(fold.residueCount);

    $('protein-name').textContent = fold.name;
    $('protein-sub').textContent = subtitleFor(fold);
    $('disclosure').textContent = DISCLOSURES[this.engine] ?? DISCLOSURES.go;
    this._updateBadge();
    document.querySelectorAll('.card').forEach(card => {
      card.setAttribute('aria-pressed', String(card.dataset.foldId === foldId));
    });
    $('seek').max = String(this.frames.length - 1);
    this._show(0);
  }

  _updateBadge() {
    $('badge-engine').textContent = ENGINE_BADGE[this.engine] ?? ENGINE_BADGE.go;
    $('badge-where').textContent = WHERE_BADGE[this.source] ?? WHERE_BADGE.baked;
  }

  _show(index) {
    if (!this.frames.length) return;
    this.index = Math.max(0, Math.min(this.frames.length - 1, index));
    const frame = this.frames[this.index];
    this.stage.render(frame.points, frame.ss, null);
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

    if (this.playing && this.frames.length) {
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
      this.stage.render(frame.points, frame.ss, null);
    }
    requestAnimationFrame(t => this._loop(t));
  }

  toggle() {
    if (!this.frames.length) return;
    // Restart from the beginning if it has run to the end, so Play always plays something.
    if (!this.playing && this.index >= this.frames.length - 1) {
      this.contactsSoFar = 0;
      this._show(0);
    }
    this.playing = !this.playing;
    $('play').textContent = this.playing ? 'Pause' : 'Play';
    // Phase 2 hooks the AudioContext resume here: browsers refuse an AudioContext before a
    // user gesture, and this button is that gesture.
  }

  _wireControls() {
    $('play').addEventListener('click', () => this.toggle());
    $('seek').addEventListener('input', (e) => {
      this.playing = false;
      $('play').textContent = 'Play';
      // Recompute the running contact total for the frame seeked to, rather than leaving
      // it wherever playback happened to stop.
      const target = Number(e.target.value);
      this.contactsSoFar = this.frames.slice(0, target + 1)
        .reduce((sum, f) => sum + f.newContacts.length, 0);
      this._show(target);
    });
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', () => {
        this.playing = false;
        $('play').textContent = 'Play';
        this.contactsSoFar = 0;
        this.load(card.dataset.foldId);
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
