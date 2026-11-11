// Measuring: point-to-point distance, chained lengths (polyline) and spot measurements
// (coordinates and elevation). Points snap to vertices, edge midpoints and edges.
import * as THREE from 'three';
import { t, fmtNum } from './i18n.js';

const SNAP_VERTEX_PX = 12;
const SNAP_MID_PX = 10;
const SNAP_EDGE_PX = 7;
const SNAP_PROBES = [[8, 0], [-8, 0], [0, 8], [0, -8]];
const COLORS = { distance: 0x2f7de1, chain: 0x8e44ad, spot: 0x1fa971 };

let seq = 1;

export class MeasureTool extends EventTarget {
  constructor(viewer, container) {
    super();
    this.viewer = viewer;
    this.container = container;
    this.mode = null; // 'distance' | 'chain' | 'spot' | null
    this.snapOn = true;
    this.unit = 'm'; // 'm' | 'mm'
    this.lockXY = false;
    // Which coordinates the spot label shows in the 3D view
    this.spotShow = { x: false, y: false, z: true };
    try { Object.assign(this.spotShow, JSON.parse(localStorage.getItem('onlineifc.spotLabel') || '{}')); } catch { /* ignore */ }
    this.items = []; // finished measurements
    this.current = null; // measurement in progress {type, points: []}
    this.hover = null; // {point, kind, hit}

    this.group = new THREE.Group();
    this.group.renderOrder = 20;
    viewer.scene.add(this.group);

    this.layer = document.createElement('div');
    this.layer.className = 'measure-layer';
    container.append(this.layer);
    this.marker = document.createElement('div');
    this.marker.className = 'snap-marker';
    this.marker.hidden = true;
    this.layer.append(this.marker);

    this.rubber = this.#line([new THREE.Vector3(), new THREE.Vector3()], 0xff9f1a, true);
    this.rubber.visible = false;
    this.group.add(this.rubber);

    viewer.renderHooks.push(() => this.#updateLabels());
    this.#bindPointer();
  }

  // ------------------------------------------------------------------- modes
  setMode(mode) {
    if (this.current) this.#finishCurrent();
    this.mode = mode;
    this.viewer.dblclickCenters = !mode;
    this.container.classList.toggle('measuring', !!mode);
    if (!mode) this.#clearHover();
    this.#emit();
  }

  #emit() { this.dispatchEvent(new Event('change')); }

  // ----------------------------------------------------------------- pointer
  #bindPointer() {
    const el = this.viewer.renderer.domElement;
    let raf = 0;
    let last = null;
    el.addEventListener('pointermove', (e) => {
      if (!this.mode || e.buttons) { if (this.mode) this.#clearHover(); return; }
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        this.#updateHover(last.clientX, last.clientY);
      });
    });
    el.addEventListener('pointerleave', () => this.#clearHover());
    el.addEventListener('dblclick', (e) => {
      if (this.mode === 'chain' && this.current) {
        e.preventDefault();
        this.#finishCurrent();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!this.mode || e.target.closest?.('input, textarea, select, .cm-editor')) return;
      if (e.key === 'Enter' && this.current) { this.#finishCurrent(); e.preventDefault(); }
      if (e.key === 'Backspace' && this.current?.points.length) {
        this.current.points.pop();
        if (!this.current.points.length) this.#discard(this.current);
        this.#redraw(this.current);
        e.preventDefault();
      }
    });
  }

  /** Called by the UI for a click in the viewport while measuring. */
  handleClick(clientX, clientY) {
    const s = this.#snap(clientX, clientY);
    if (!s) return;
    const p = this.#locked(s.point);
    if (this.mode === 'spot') {
      this.#add({ type: 'spot', points: [p], info: this.#spotInfo(p, s.hit) });
      return;
    }
    if (!this.current) {
      this.current = { id: seq++, type: this.mode, points: [], objects: null };
      this.items.push(this.current);
    }
    const pts = this.current.points;
    if (pts.length && pts[pts.length - 1].distanceTo(p) < 1e-9) return; // double click on the same point
    pts.push(p);
    if (this.mode === 'distance' && pts.length === 2) {
      const m = this.current;
      this.current = null;
      this.#redraw(m);
      this.#emit();
      return;
    }
    this.#redraw(this.current);
    this.#emit();
  }

  /** Esc: cancels the measurement in progress, or leaves the mode. Returns true if handled. */
  cancel() {
    if (this.current) {
      if (this.current.type === 'chain' && this.current.points.length >= 2) this.#finishCurrent();
      else this.#discard(this.current);
      this.#emit();
      return true;
    }
    if (this.mode) { this.setMode(null); return true; }
    return false;
  }

  #finishCurrent() {
    const m = this.current;
    this.current = null;
    if (!m) return;
    if (m.points.length < 2) this.#discard(m);
    else this.#redraw(m);
    this.rubber.visible = false;
    this.#emit();
  }

  #discard(m) {
    this.#disposeObjects(m);
    this.items = this.items.filter((x) => x !== m);
    if (this.current === m) this.current = null;
    this.rubber.visible = false;
  }

  #add(m) {
    m.id = seq++;
    this.items.push(m);
    this.#redraw(m);
    this.#emit();
  }

  remove(id) {
    const m = this.items.find((x) => x.id === id);
    if (m) this.#discard(m);
    this.#emit();
  }

  clear() {
    for (const m of [...this.items]) this.#discard(m);
    this.current = null;
    this.#emit();
  }

  // ------------------------------------------------------------------ snapping
  #snap(clientX, clientY) {
    const center = this.viewer.pick(clientX, clientY);
    if (!this.snapOn) return center ? { point: center.point, kind: 'face', hit: center } : null;
    // Also look at the surfaces just around the cursor, so corners can be caught from either side.
    const hits = center ? [center] : [];
    for (const [dx, dy] of SNAP_PROBES) {
      const h = this.viewer.pick(clientX + dx, clientY + dy);
      if (h?.face && !hits.some((x) => x.object === h.object && x.face.a === h.face.a && x.face.b === h.face.b)) hits.push(h);
    }
    if (!hits.length) return null;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const mouse = { x: clientX - rect.left, y: clientY - rect.top };
    const px = (p) => {
      const s = this.viewer.toScreen(p);
      return s ? Math.hypot(s.x - mouse.x, s.y - mouse.y) : Infinity;
    };
    const tris = hits.filter((h) => h.face).map((h) => {
      const pos = h.object.geometry.getAttribute('position');
      const mw = h.object.matrixWorld;
      return { hit: h, v: [h.face.a, h.face.b, h.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mw)) };
    });
    // vertices
    let best = null;
    for (const tri of tris) {
      for (const p of tri.v) {
        const d = px(p);
        if (d <= SNAP_VERTEX_PX && (!best || d < best.d)) best = { d, point: p, kind: 'vertex', hit: tri.hit };
      }
    }
    if (best) return best;
    if (!center?.face) return center ? { point: center.point, kind: 'face', hit: center } : null;
    const hit = center;
    const v = tris[0].v;
    // edge midpoints and edges (of the triangle under the cursor)
    const edges = [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]];
    for (const [a, b] of edges) {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const d = px(mid);
      if (d <= SNAP_MID_PX && (!best || d < best.d)) best = { d, point: mid, kind: 'mid' };
    }
    if (best) return { ...best, hit };
    const line = new THREE.Line3();
    for (const [a, b] of edges) {
      line.set(a, b);
      const c = line.closestPointToPoint(hit.point, true, new THREE.Vector3());
      const d = px(c);
      if (d <= SNAP_EDGE_PX && (!best || d < best.d)) best = { d, point: c, kind: 'edge' };
    }
    if (best) return { ...best, hit };
    return { point: hit.point, kind: 'face', hit };
  }

  /**
   * "Lock XY": the second point of a distance keeps the X/Y of the first point, so only the
   * height difference (Z) is measured, on a vertical line through the first point.
   */
  #locked(p) {
    const a = this.current?.points[0];
    if (!this.lockXY || this.mode !== 'distance' || !a) return p.clone();
    return new THREE.Vector3(a.x, p.y, a.z); // three.js Y is IFC Z (up)
  }

  #updateHover(clientX, clientY) {
    const raw = this.#snap(clientX, clientY);
    const s = raw ? { ...raw, point: this.#locked(raw.point) } : null;
    this.hover = s;
    if (!s) { this.#clearHover(); return; }
    this.marker.hidden = false;
    this.marker.dataset.kind = s.kind;
    this.marker.title = t(`measure.snap.${s.kind}`);
    const pts = this.current?.points;
    if (pts?.length) {
      const a = pts[pts.length - 1];
      this.#setLine(this.rubber, [a, s.point]);
      this.rubber.visible = true;
    } else this.rubber.visible = false;
    this.#positionMarker();
    this.#updatePreviewLabel();
  }

  #clearHover() {
    this.hover = null;
    this.marker.hidden = true;
    this.rubber.visible = false;
    if (this.previewLabel) this.previewLabel.hidden = true;
  }

  #positionMarker() {
    if (!this.hover) return;
    const s = this.viewer.toScreen(this.hover.point);
    if (!s) { this.marker.hidden = true; return; }
    this.marker.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }

  #updatePreviewLabel() {
    if (!this.previewLabel) {
      this.previewLabel = this.#label('preview');
    }
    const pts = this.current?.points;
    if (!this.hover || !pts?.length) { this.previewLabel.hidden = true; return; }
    const a = pts[pts.length - 1];
    this.previewLabel.hidden = false;
    this.previewLabel.textContent = this.fmtLen(a.distanceTo(this.hover.point));
    this.previewLabel._anchor = a.clone().add(this.hover.point).multiplyScalar(0.5);
  }

  // ------------------------------------------------------------------ geometry
  #line(points, color, dashed = false) {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.15, gapSize: 0.1, depthTest: false, transparent: true, opacity: 0.95 })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const l = new THREE.Line(g, mat);
    l.renderOrder = 30;
    l.frustumCulled = false;
    if (dashed) l.computeLineDistances();
    return l;
  }

  #setLine(line, points) {
    line.geometry.setFromPoints(points);
    if (line.material.isLineDashedMaterial) line.computeLineDistances();
  }

  #label(cls) {
    const el = document.createElement('div');
    el.className = `m-label ${cls}`;
    this.layer.append(el);
    return el;
  }

  #dot(kind) {
    const el = document.createElement('div');
    el.className = `m-dot ${kind}`;
    this.layer.append(el);
    return el;
  }

  #disposeObjects(m) {
    if (!m.objects) return;
    for (const o of m.objects.lines) { this.group.remove(o); o.geometry.dispose(); o.material.dispose(); }
    for (const el of m.objects.labels) el.el.remove();
    for (const el of m.objects.dots) el.el.remove();
    m.objects = null;
  }

  #redraw(m) {
    this.#disposeObjects(m);
    const color = COLORS[m.type];
    const o = { lines: [], labels: [], dots: [] };
    m.objects = o;
    const pts = m.points;
    for (const p of pts) o.dots.push({ el: this.#dot(m.type), at: p });
    if (m.type === 'spot') {
      const el = this.#label('spot');
      el.textContent = this.#spotLabel(m.info);
      o.labels.push({ el, at: pts[0], offset: -18 });
    } else if (pts.length >= 2) {
      const main = this.#line(pts, color);
      this.group.add(main);
      o.lines.push(main);
      for (let i = 1; i < pts.length; i++) {
        const el = this.#label(m.type);
        el.textContent = this.fmtLen(pts[i - 1].distanceTo(pts[i]));
        o.labels.push({ el, at: pts[i - 1].clone().add(pts[i]).multiplyScalar(0.5) });
      }
      if (m.type === 'distance') {
        // helper legs: horizontal and vertical component
        const [a, b] = pts;
        const corner = new THREE.Vector3(b.x, a.y, b.z);
        if (Math.abs(b.y - a.y) > 1e-4 && a.distanceTo(corner) > 1e-4) {
          const legs = this.#line([a, corner, b], color, true);
          legs.material.opacity = 0.45;
          this.group.add(legs);
          o.lines.push(legs);
        }
      }
      if (m.type === 'chain' && pts.length > 2 && this.current !== m) {
        const el = this.#label('chain total');
        el.textContent = `Σ ${this.fmtLen(this.length(m))}`;
        o.labels.push({ el, at: pts[pts.length - 1], offset: -22 });
      }
    }
  }

  #updateLabels() {
    const place = (el, at, offset = 0) => {
      const s = this.viewer.toScreen(at);
      if (!s) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.transform = `translate(${s.x}px, ${s.y + offset}px) translate(-50%, -50%)`;
    };
    for (const m of this.items) {
      if (!m.objects) continue;
      for (const d of m.objects.dots) place(d.el, d.at);
      for (const l of m.objects.labels) place(l.el, l.at, l.offset || 0);
    }
    if (this.previewLabel && !this.previewLabel.hidden && this.previewLabel._anchor) place(this.previewLabel, this.previewLabel._anchor);
    this.#positionMarker();
  }

  /** Redraws labels after a language or unit change. */
  refresh() {
    for (const m of this.items) {
      if (m.type === 'spot') m.info = this.#spotInfo(m.points[0], m.info?.hit);
      this.#redraw(m);
    }
    this.#emit();
  }

  // ------------------------------------------------------------------ values
  length(m) {
    let l = 0;
    for (let i = 1; i < m.points.length; i++) l += m.points[i - 1].distanceTo(m.points[i]);
    return l;
  }

  /** Distance components in IFC axes: dx, dy, dz and the horizontal distance. */
  components(m) {
    const a = this.viewer.toIfc(m.points[0]);
    const b = this.viewer.toIfc(m.points[m.points.length - 1]);
    const d = b.clone().sub(a);
    return { dx: d.x, dy: d.y, dz: d.z, horizontal: Math.hypot(d.x, d.y), slope: Math.hypot(d.x, d.y) > 1e-9 ? (d.z / Math.hypot(d.x, d.y)) * 100 : null };
  }

  #spotInfo(p, hit) {
    const ifc = this.viewer.toIfc(p);
    const ref = this.viewer.models[0];
    const info = { ifc, hit: hit ? { model: hit.model, id: hit.id } : null };
    info.map = ref?.toMap ? ref.toMap(ifc) : null;
    if (!info.map && ref?.georef?.refElevation !== null && ref?.georef?.refElevation !== undefined) info.refElevation = ref.georef.refElevation;
    const model = hit?.model;
    if (model?.storeyInfo) {
      const st = model.storeyInfo(hit.id);
      if (st) info.storey = st;
    }
    if (model) {
      info.element = `${model.typeName(hit.id)} – ${model.label(hit.id)}`;
    }
    return info;
  }

  #spotLabel(info) {
    const geo = !!info.map;
    const c = geo ? { x: info.map.e, y: info.map.n, z: info.map.h } : info.ifc;
    const names = geo ? { x: 'E', y: 'N', z: 'H' } : { x: 'X', y: 'Y', z: 'Z' };
    const parts = [];
    for (const k of ['x', 'y', 'z']) {
      if (!this.spotShow[k]) continue;
      parts.push(`${names[k]} ${k === 'z' ? this.fmtLen(c[k], true) : this.fmtLen(c[k])}`);
    }
    return parts.length ? parts.join('\n') : '•';
  }

  /** Chooses which coordinates the spot labels show (x, y, z). */
  setSpotShow(key, on) {
    this.spotShow[key] = on;
    try { localStorage.setItem('onlineifc.spotLabel', JSON.stringify(this.spotShow)); } catch { /* ignore */ }
    this.refresh();
  }

  fmtLen(v, signed = false) {
    const mm = this.unit === 'mm';
    const n = mm ? v * 1000 : v;
    const s = n.toLocaleString(undefined, { minimumFractionDigits: mm ? 0 : 3, maximumFractionDigits: mm ? 0 : 3 });
    return `${signed && n >= 0 ? '+' : ''}${s} ${mm ? 'mm' : 'm'}`;
  }

  fmtCoord(v) {
    return v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }

  /** All measurements as rows for the panel and for copying. */
  rows() {
    return this.items.filter((m) => m.points.length).map((m, i) => {
      const n = i + 1;
      if (m.type === 'spot') {
        const info = m.info;
        const lines = [
          [t('measure.x'), this.fmtCoord(info.ifc.x)],
          [t('measure.y'), this.fmtCoord(info.ifc.y)],
          [t('measure.z'), this.fmtCoord(info.ifc.z)],
        ];
        if (info.map) {
          lines.push([t('measure.e'), this.fmtCoord(info.map.e)], [t('measure.n'), this.fmtCoord(info.map.n)], [t('measure.h'), this.fmtCoord(info.map.h)]);
          if (info.map.crs) lines.push([t('measure.crs'), info.map.crs]);
        } else if (info.refElevation !== undefined) {
          lines.push([t('measure.aboveSea'), this.fmtCoord(info.ifc.z + info.refElevation)]);
        }
        if (info.storey?.elevation !== null && info.storey?.elevation !== undefined) {
          lines.push([t('measure.aboveStorey', { name: info.storey.name }), this.fmtLen(info.ifc.z - info.storey.elevation, true)]);
        }
        if (info.element) lines.push([t('measure.element'), info.element]);
        return { m, n, title: `${t('measure.spot')} ${n}`, value: this.#spotLabel(info).replace(/\n/g, ' · '), lines };
      }
      const len = this.length(m);
      const lines = [];
      if (m.points.length >= 2) {
        const c = this.components(m);
        if (m.type === 'distance') {
          lines.push([t('measure.horizontal'), this.fmtLen(c.horizontal)], [t('measure.dz'), this.fmtLen(c.dz, true)],
            ['ΔX / ΔY', `${this.fmtLen(c.dx, true)} / ${this.fmtLen(c.dy, true)}`]);
          if (c.slope !== null && Math.abs(c.dz) > 1e-4) lines.push([t('measure.slope'), `${c.slope.toFixed(2)} %`]);
        } else {
          lines.push([t('measure.segments'), fmtNum(m.points.length - 1)]);
        }
      }
      const inProgress = this.current === m;
      return {
        m, n,
        title: `${t(m.type === 'chain' ? 'measure.chain' : 'measure.distance')} ${n}${inProgress ? ` (${t('measure.inProgress')})` : ''}`,
        value: m.points.length >= 2 ? this.fmtLen(len) : '–',
        lines,
      };
    });
  }

  /** Text for the clipboard (tab separated). */
  toText() {
    const out = [];
    for (const r of this.rows()) {
      out.push(`${r.title}\t${r.value}`);
      for (const [k, v] of r.lines) out.push(`\t${k}\t${v}`);
    }
    return out.join('\n');
  }

  /** Zooms the camera to a measurement. */
  focus(id) {
    const m = this.items.find((x) => x.id === id);
    if (!m?.points.length) return;
    const box = new THREE.Box3().setFromPoints(m.points);
    box.expandByScalar(Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.3));
    this.viewer.fitBox(box);
  }
}
