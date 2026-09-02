/* The residue ribbon: the chain unrolled into a strip, lighting as each residue sounds.
 *
 * One cell per residue, in the colours the cartoon is already using, along the bottom edge
 * of the stage. It does two jobs at once and the second is the reason it earns its space.
 *
 * While the music plays it answers the question a visitor actually has - WHICH PART of this
 * protein am I hearing - which the stage cannot answer, because a note's residue is
 * somewhere in a turning three-dimensional tangle and might be facing away. Here it cannot
 * hide behind anything: the chain is laid out in one dimension, in order, and the cell that
 * sounded is the cell that lit.
 *
 * At rest it is a sequence view of the secondary structure, which reforms as the fold does:
 * grey coil giving way to magenta helix and cyan sheet in the same places and at the same
 * moments as the ribbon in the viewer, read left to right instead of in space. That is why
 * it is drawn even when nothing is playing.
 *
 * All five voices light it, not only the contacts. Every note the sonifier emits carries the
 * residue it came from - the pad picks helix residues, the rhythm picks sheet ones - so the
 * strip shows the whole texture rather than the contact voice alone.
 */

/* The cartoon's own structure colours, so the strip and the ribbon cannot disagree. */
const SS_COLOUR = { H: '#FF3D9A', E: '#22E5FF', C: '#5A6782' };

/* How far above the strip a sounding residue's flare reaches, as a fraction of the strip's
 * height. Above the strip rather than inside it: a cell that brightens in place is hard to
 * see against its own colour, and a flare that leaves the strip is visible at four pixels a
 * cell, which is what a phone gives you for a 76 residue protein. */
const FLARE = 1.15;

export class ResidueRibbon {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ss = '';
    this.glow = new Float32Array(0);
    this.residueCount = 0;
  }

  /** The structure for this frame, as the run-length-decoded string the stage renders. */
  setStructure(ss) {
    this.ss = ss ?? '';
    if (this.glow.length !== this.ss.length) this.glow = new Float32Array(this.ss.length);
    this.residueCount = this.ss.length;
  }

  /** The notes sounding, from `audio.notesSounding`. Same events the chords are struck from. */
  setSounding(events) {
    this.glow.fill(0);
    for (const event of events ?? []) {
      const envelope = Math.max(1 - event.age, 0) ** 1.8 * event.velocity;
      if (envelope <= 0.02) continue;
      for (const residue of [event.residue, event.partner]) {
        if (residue == null || residue < 0 || residue >= this.glow.length) continue;
        const value = residue === event.residue ? envelope : envelope * 0.7;
        if (value > this.glow[residue]) this.glow[residue] = value;
      }
    }
  }

  draw() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const n = this.residueCount;
    // Device pixels, so a four-pixel cell is four real pixels and not a blurred three.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (!n) return;

    const cellW = w / n;
    const strip = h * 0.46;
    const top = h - strip;
    for (let i = 0; i < n; i++) {
      const x = i * cellW;
      const lit = this.glow[i] ?? 0;
      ctx.globalAlpha = 0.34 + lit * 0.66;
      ctx.fillStyle = SS_COLOUR[this.ss[i]] ?? SS_COLOUR.C;
      // A hairline gap only where the cells are wide enough to have one. Below about three
      // device pixels the gap eats the cell and the strip reads as a dotted line.
      const gap = cellW > 3 ? 0.5 : 0;
      ctx.fillRect(x + gap, top, Math.max(cellW - gap * 2, 0.75), strip);
      if (lit > 0.03) {
        ctx.globalAlpha = lit;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(x + gap, top - strip * FLARE * lit,
                     Math.max(cellW - gap * 2, 0.75), strip * FLARE * lit);
      }
    }
    ctx.globalAlpha = 1;
  }
}
