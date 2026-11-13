// Section viewer: a window with the live 2D cut of one section plane, next to the 3D view.
// Step through the sections (‹ › or the arrow keys) while the model shows where the cut is.
// The window floats over the viewport and can be popped out into a browser window of its own
// (e.g. on a second screen); its controls keep working there.
import { sectionPaths } from './drawing.js';

const SVG = 'http://www.w3.org/2000/svg';
const niceSteps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export class SectionViewer {
  /**
   * ctx: {t, h, compute(plane) -> section, title(plane) -> string, station(plane) -> string|null,
   *       step(plane, dir), setStation(plane, text) -> bool, getStep() -> m, setStep(m), colors() -> opts,
   *       planes() -> current plane list, container (element to dock into)}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.plane = null;
    this.section = null;
    this.view = null; // {x, y, w, h} viewBox in drawing metres (y flipped)
    this.win = null;
    try { this.showPoints = localStorage.getItem('onlineifc.sv.points') === '1'; } catch { this.showPoints = false; }
    try { this.showKey = localStorage.getItem('onlineifc.sv.key') !== '0'; } catch { this.showKey = true; }
    this.busy = false;
    this.pending = false;
    this.#build();
  }

  #build() {
    const { h, t } = this.ctx;
    this.titleEl = h('b', { class: 'sv-title' });
    this.stationIn = h('input', { type: 'text', inputmode: 'decimal', class: 'sv-station', title: t('st.title') });
    this.stepIn = h('input', { type: 'number', min: '0.01', step: 'any', class: 'sv-step', title: t('planes.stepTitle') });
    const btn = (text, title, fn, cls = '') => h('button', { class: `btn xs ${cls}`, text, title, onclick: fn });
    this.popBtn = btn('⧉', t('sv.popOut'), () => (this.win ? this.dock() : this.popOut()));
    this.head = h('div', { class: 'sv-head' },
      this.titleEl,
      h('span', { class: 'sv-ctrl' },
        btn('‹', t('sv.prev'), () => this.step(-1), 'step'),
        this.stationIn,
        btn('›', t('sv.next'), () => this.step(1), 'step'),
        h('label', { class: 'sv-steplbl' }, h('span', { text: t('sv.step') }), this.stepIn, h('span', { text: 'm' })),
        btn('⤢', t('sv.fit'), () => { this.fit(); this.render(); }),
        btn('⟳', t('sv.refresh'), () => this.update()),
        this.ptsBtn = btn('⌖', t('sv.points'), () => { this.showPoints = !this.showPoints; try { localStorage.setItem('onlineifc.sv.points', this.showPoints ? '1' : ''); } catch { /* ignore */ } this.update(); }),
        this.keyBtn = btn('▦', t('sv.keyPlan'), () => { this.showKey = !this.showKey; try { localStorage.setItem('onlineifc.sv.key', this.showKey ? '1' : '0'); } catch { /* ignore */ } this.renderKey(); }),
        this.popBtn,
        btn('✕', t('common.close'), () => this.close())));
    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('class', 'sv-svg');
    this.body = h('div', { class: 'sv-body' });
    this.keySvg = document.createElementNS(SVG, 'svg');
    this.keySvg.setAttribute('class', 'sv-key');
    this.body.append(this.svg, this.keySvg);
    this.coord = h('span', { class: 'sv-coord' });
    this.info = h('span', { class: 'sv-info' });
    this.el = h('div', { class: 'secview', tabindex: '0' }, this.head, this.body, h('div', { class: 'sv-foot' }, this.coord, this.info));
    this.el.hidden = true;
    this.ctx.container.append(this.el);

    this.stationIn.addEventListener('change', () => { if (this.plane && !this.ctx.setStation(this.plane, this.stationIn.value)) this.#updateHead(); });
    this.stationIn.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.step(e.key === 'ArrowUp' ? 1 : -1); } });
    this.stepIn.addEventListener('change', () => { const v = +this.stepIn.value; if (v > 0) this.ctx.setStep(v); });
    this.onKey = (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); this.step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.step(-1); }
      else if (e.key === 'f' || e.key === 'F') { this.fit(); this.render(); }
    };
    // popped out, the window itself listens (see popOut), otherwise the floating window
    this.el.addEventListener('keydown', (e) => { if (!this.win) this.onKey(e); });
    // zoom (wheel, at the cursor) and pan (drag)
    this.body.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.view) return;
      const p = this.#toModel(e);
      const f = Math.pow(1.0015, e.deltaY);
      const v = this.view;
      this.view = { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f };
      this.render();
    }, { passive: false });
    let drag = null;
    this.body.addEventListener('pointerdown', (e) => { if (!this.view) return; drag = { x: e.clientX, y: e.clientY, v: { ...this.view } }; this.body.setPointerCapture(e.pointerId); this.el.focus({ preventScroll: true }); });
    this.body.addEventListener('pointermove', (e) => {
      const p = this.#toModel(e);
      if (p) this.coord.textContent = this.ctx.t('sv.coord', { x: p.x.toFixed(3), z: (-p.y).toFixed(3) });
      if (!drag) return;
      const r = this.body.getBoundingClientRect();
      const k = this.#scale(r);
      this.view = { ...drag.v, x: drag.v.x - (e.clientX - drag.x) / k, y: drag.v.y - (e.clientY - drag.y) / k };
      this.render();
    });
    this.body.addEventListener('pointerup', () => { drag = null; });
    this.body.addEventListener('pointerleave', () => { this.coord.textContent = ''; });
    // move the floating window by its header
    let mv = null;
    this.head.addEventListener('pointerdown', (e) => {
      if (this.win || e.target.closest('button, input, label')) return;
      const r = this.el.getBoundingClientRect(), pr = this.el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
      mv = { dx: e.clientX - r.left + pr.left, dy: e.clientY - r.top + pr.top };
      this.head.setPointerCapture(e.pointerId);
    });
    this.head.addEventListener('pointermove', (e) => {
      if (!mv) return;
      Object.assign(this.el.style, { left: `${Math.max(0, e.clientX - mv.dx)}px`, top: `${Math.max(0, e.clientY - mv.dy)}px`, right: 'auto', bottom: 'auto' });
    });
    this.head.addEventListener('pointerup', () => { mv = null; });
    new ResizeObserver(() => this.render()).observe(this.body);
  }

  get isOpen() { return !this.el.hidden; }

  open(plane) {
    const fresh = plane !== this.plane;
    this.plane = plane;
    this.ctx.onPlane?.(plane);
    this.el.hidden = false;
    if (fresh) this.view = null;
    this.update();
    if (!this.win) this.el.focus({ preventScroll: true });
    else this.win.focus();
  }

  close() {
    if (this.win) { const w = this.win; this.dock(); w.close(); }
    this.el.hidden = true;
    this.plane = null;
    this.section = null;
    this.ctx.onClose?.();
  }

  step(dir) { if (this.plane) this.ctx.step(this.plane, dir); }

  /** Called when planes change: recompute the cut (at most one at a time, the latest wins). */
  planesChanged() {
    if (!this.isOpen) return;
    if (!this.ctx.planes().includes(this.plane)) {
      const next = this.ctx.planes().find((p) => p.station) || this.ctx.planes()[0];
      if (!next) return this.close();
      this.plane = next;
      this.view = null;
      this.ctx.onPlane?.(next);
    }
    this.update();
  }

  update() {
    if (!this.plane) return;
    this.#updateHead();
    this.renderKey();
    if (this.busy) { this.pending = true; return; }
    this.busy = true;
    setTimeout(() => {
      if (!this.plane) { this.busy = false; this.pending = false; return; }
      try {
        const t0 = performance.now();
        this.section = this.ctx.compute(this.plane, this.showPoints);
        this.ms = Math.round(performance.now() - t0);
      } catch (e) {
        console.error(e);
        this.section = null;
      }
      if (!this.view) this.fit();
      this.render();
      this.busy = false;
      if (this.pending) { this.pending = false; this.update(); }
    }, 0);
  }

  #updateHead() {
    const p = this.plane;
    if (!p) return;
    this.titleEl.textContent = this.ctx.title(p);
    const st = this.ctx.station(p);
    if (document.activeElement !== this.stationIn && this.win?.document.activeElement !== this.stationIn) this.stationIn.value = st ?? '';
    this.stepIn.value = String(this.ctx.getStep());
    if (this.win) this.win.document.title = `${this.ctx.title(p)} – Vispecta`;
  }

  fit() {
    const b = this.section?.bounds;
    if (!b || !Number.isFinite(b.minX)) { this.view = { x: -10, y: -10, w: 20, h: 20 }; return; }
    const pad = 0.08 * Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);
    const r = this.body.getBoundingClientRect();
    let w = b.maxX - b.minX + 2 * pad, hh = b.maxY - b.minY + 2 * pad;
    const aspect = (r.width || 600) / (r.height || 400);
    if (w / hh < aspect) w = hh * aspect; else hh = w / aspect;
    const cx = (b.minX + b.maxX) / 2, cy = -(b.minY + b.maxY) / 2;
    this.view = { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  }

  #scale(r) { return Math.min(r.width / this.view.w, r.height / this.view.h); }

  #toModel(e) {
    if (!this.view) return null;
    const r = this.body.getBoundingClientRect();
    const k = this.#scale(r);
    // the viewBox is centred in the element (preserveAspectRatio xMidYMid meet)
    const ox = (r.width - this.view.w * k) / 2, oy = (r.height - this.view.h * k) / 2;
    return { x: this.view.x + (e.clientX - r.left - ox) / k, y: this.view.y + (e.clientY - r.top - oy) / k };
  }

  render() {
    if (!this.isOpen || !this.view) return;
    const v = this.view;
    const svg = this.svg;
    const r = this.body.getBoundingClientRect();
    if (!r.width || !r.height) return;
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    svg.replaceChildren();
    const mk = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val); return e; };
    const px = v.w / r.width; // metres per pixel (about)
    // grid with labels: offset along, height up
    const step = niceSteps.find((s) => s / px >= 70) || 1000;
    const g = mk('g', { class: 'sv-grid' });
    const fs = 11 * px;
    for (let x = Math.ceil(v.x / step) * step; x <= v.x + v.w; x += step) {
      g.append(mk('line', { x1: x, y1: v.y, x2: x, y2: v.y + v.h, 'vector-effect': 'non-scaling-stroke' }));
      const tx = mk('text', { x: x + 3 * px, y: v.y + v.h - 4 * px, 'font-size': fs });
      tx.textContent = `${+x.toFixed(3)}`;
      g.append(tx);
    }
    for (let y = Math.ceil(v.y / step) * step; y <= v.y + v.h; y += step) {
      g.append(mk('line', { x1: v.x, y1: y, x2: v.x + v.w, y2: y, 'vector-effect': 'non-scaling-stroke' }));
      const tx = mk('text', { x: v.x + 4 * px, y: y - 3 * px, 'font-size': fs });
      tx.textContent = `${+(-y).toFixed(3)}`;
      g.append(tx);
    }
    svg.append(g);
    const sec = this.section;
    if (sec) {
      // hatching of the cut faces, like in the 3D view: dark diagonal lines a few pixels apart
      const hatch = this.ctx.hatch?.() !== false;
      if (hatch) {
        const sz = 7 * px;
        const pat = mk('pattern', { id: 'sv-hatch', patternUnits: 'userSpaceOnUse', width: sz, height: sz, patternTransform: 'rotate(45)' });
        pat.append(mk('rect', { x: 0, y: 0, width: 1.3 * px, height: sz, fill: '#000', 'fill-opacity': 0.42, stroke: 'none' }));
        const defs = mk('defs', {});
        defs.append(pat);
        svg.append(defs);
      }
      for (const p of sectionPaths(sec, this.ctx.colors())) {
        svg.append(mk('path', { d: p.d, fill: p.fill, stroke: p.stroke, 'stroke-width': 1.2, 'fill-rule': 'evenodd', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
        if (hatch && p.fill && p.fill !== 'none') svg.append(mk('path', { d: p.d, fill: 'url(#sv-hatch)', stroke: 'none', 'fill-rule': 'evenodd' }));
      }
      // marks: the alignment axis
      for (const m of sec.marks || []) {
        if (!m.line) continue;
        svg.append(mk('path', { d: `M${m.line.map((q) => `${q[0]} ${-q[1]}`).join('L')}`, fill: 'none', stroke: m.color || '#c0392b', 'stroke-width': 1.2, 'stroke-dasharray': '10 3 2 3', 'vector-effect': 'non-scaling-stroke' }));
      }
    }
    this.ptsBtn.classList.toggle('on', !!this.showPoints);
    // break points of the top outline with offset / height (not closer than the labels need)
    const A = sec?.annot;
    if (this.showPoints && A?.runs) {
      const dec = A.dec || '.';
      const num = (v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3).replace('.', dec);
      const pts = A.runs.flat().sort((a, b) => b.sig - a.sig);
      const used = [];
      const gp = mk('g', { class: 'sv-points' });
      for (const p of pts) {
        if (used.some((q) => Math.abs(q.x - p.x) < 16 * px && Math.abs(q.y - p.y) < 60 * px)) continue;
        used.push(p);
        gp.append(mk('circle', { cx: p.x, cy: -p.y, r: 3 * px }));
        const tx = mk('text', { x: p.x + 2 * px, y: -p.y - 6 * px, 'font-size': 10.5 * px, transform: `rotate(-90 ${p.x + 2 * px} ${-p.y - 6 * px})` });
        tx.textContent = `${num(p.x - A.originX)} / ${num(p.y)}`;
        gp.append(tx);
      }
      svg.append(gp);
    }
    let n = 0;
    for (const L of sec?.layers?.values() || []) n += L.elements;
    this.info.textContent = sec ? this.ctx.t('sv.info', { n, ms: this.ms ?? 0 }) : '';
    if (sec && !n) this.info.textContent = this.ctx.t('drw.empty');
  }

  /**
   * Key plan in the corner: the visible models (outlines), alignments and the cut line with its
   * view direction, so it is clear where the section is taken.
   */
  renderKey() {
    const svg = this.keySvg;
    this.keyBtn.classList.toggle('on', !!this.showKey);
    const k = this.showKey && this.plane ? this.ctx.keyPlan?.(this.plane) : null;
    svg.style.display = k ? '' : 'none';
    svg.replaceChildren();
    if (!k) return;
    const mk = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [a, val] of Object.entries(attrs)) e.setAttribute(a, val); return e; };
    const xs = [], ys = [];
    const add = (q) => { xs.push(q[0]); ys.push(q[1]); };
    for (const b of k.boxes) { add([b[0], b[1]]); add([b[2], b[3]]); }
    for (const l of k.lines) for (const q of l) add(q);
    if (k.cut) { add(k.cut.A); add(k.cut.B); }
    if (!xs.length) { svg.style.display = 'none'; return; }
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const W = 180, H = 130;
    let w = Math.max(x1 - x0, 1), hh = Math.max(y1 - y0, 1);
    if (w / hh < W / H) w = hh * W / H; else hh = w * H / W;
    const pad = 0.1 * w;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    w += 2 * pad; hh += 2 * pad * H / W;
    svg.setAttribute('viewBox', `${cx - w / 2} ${-cy - hh / 2} ${w} ${hh}`);
    const u = w / W; // metres per pixel
    const ns = { 'vector-effect': 'non-scaling-stroke' };
    for (const b of k.boxes) svg.append(mk('rect', { x: b[0], y: -b[3], width: Math.max(b[2] - b[0], u), height: Math.max(b[3] - b[1], u), class: 'kp-box', ...ns }));
    for (const l of k.lines) if (l.length > 1) svg.append(mk('path', { d: `M${l.map((q) => `${q[0]} ${-q[1]}`).join('L')}`, class: 'kp-line', ...ns }));
    if (k.cut) {
      const { A, B, v } = k.cut;
      svg.append(mk('path', { d: `M${A[0]} ${-A[1]}L${B[0]} ${-B[1]}`, class: 'kp-cut', ...ns }));
      // arrows at both ends in the view direction
      const s = 9 * u, nx = v[0], ny = v[1], px = -ny, py = nx;
      for (const E of [A, B]) {
        const tip = [E[0] + nx * s * 1.6, E[1] + ny * s * 1.6];
        svg.append(mk('path', { d: `M${E[0] + px * s * 0.55} ${-(E[1] + py * s * 0.55)}L${tip[0]} ${-tip[1]}L${E[0] - px * s * 0.55} ${-(E[1] - py * s * 0.55)}Z`, class: 'kp-arrow' }));
        if (k.cut.letter) {
          const tx = mk('text', { x: E[0] + nx * s * 2.8, y: -(E[1] + ny * s * 2.8) + 3.5 * u, 'font-size': 10 * u, 'text-anchor': 'middle', class: 'kp-letter' });
          tx.textContent = k.cut.letter;
          svg.append(tx);
        }
      }
    }
    if (k.note) {
      const tx = mk('text', { x: cx - w / 2 + 5 * u, y: -cy + hh / 2 - 5 * u, 'font-size': 9.5 * u, class: 'kp-note' });
      tx.textContent = k.note;
      svg.append(tx);
    }
  }

  /** Into a browser window of its own (e.g. a second screen). */
  popOut() {
    const w = window.open('', 'vispecta-section', 'width=960,height=640');
    if (!w) { this.ctx.toast?.(this.ctx.t('sv.blocked')); return; }
    let css = '';
    for (const sh of document.styleSheets) { try { for (const rule of sh.cssRules) css += `${rule.cssText}\n`; } catch { /* other origin (fonts) */ } }
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Vispecta</title><style>${css}</style></head><body class="sv-popup"></body></html>`);
    w.document.close();
    for (const a of ['data-theme', 'lang']) { const val = document.documentElement.getAttribute(a); if (val) w.document.documentElement.setAttribute(a, val); }
    this.saved = this.el.getAttribute('style') || '';
    this.el.removeAttribute('style');
    w.document.body.append(w.document.adoptNode(this.el));
    this.el.classList.add('popped');
    this.popBtn.textContent = '⊡';
    this.popBtn.title = this.ctx.t('sv.dock');
    this.win = w;
    w.addEventListener('keydown', this.onKey);
    w.addEventListener('pagehide', () => { if (this.win === w) this.dock(); });
    this.#updateHead();
    setTimeout(() => { this.fit(); this.render(); }, 50);
  }

  /** Back into the main window. */
  dock() {
    const w = this.win;
    if (!w) return;
    this.win = null;
    this.ctx.container.append(document.adoptNode(this.el));
    this.el.classList.remove('popped');
    if (this.saved) this.el.setAttribute('style', this.saved);
    this.popBtn.textContent = '⧉';
    this.popBtn.title = this.ctx.t('sv.popOut');
    setTimeout(() => { this.fit(); this.render(); }, 30);
  }
}
