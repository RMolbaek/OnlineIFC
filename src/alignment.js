// IFC4x3 alignments: horizontal geometry (tessellated by web-ifc), vertical profile computed
// from IfcAlignmentVerticalSegment, stationing from IfcReferent / Pset_Stationing.
// Used to draw the alignment with station marks and to give station + offset for points.
import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { fmtValue } from './ifc.js';

const num = (v) => {
  if (v === null || v === undefined) return null;
  const x = typeof v === 'object' ? v._representationValue ?? v.value : v;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Reads all alignments of a model. Returns [] for models without IfcAlignment. */
export async function readAlignments(model) {
  const api = model.api, mid = model.modelID;
  if (!WebIFC.IFCALIGNMENT) return [];
  const ids = api.GetLineIDsWithType(mid, WebIFC.IFCALIGNMENT);
  if (!ids.size()) return [];
  let raw = [];
  try { raw = api.GetAllAlignments(mid) || []; } catch (e) { console.warn('GetAllAlignments', e); }
  // nesting: parent -> children
  const nests = new Map();
  const rn = api.GetLineIDsWithType(mid, WebIFC.IFCRELNESTS);
  for (let i = 0; i < rn.size(); i++) {
    const rel = api.GetLine(mid, rn.get(i), false);
    const p = rel.RelatingObject?.value;
    if (!p) continue;
    if (!nests.has(p)) nests.set(p, []);
    nests.get(p).push(...(rel.RelatedObjects || []).map((r) => r.value));
  }
  // web-ifc returns 'IFCALIGNMENT' for IFC4 but 'IfcAlignment' for IFC4X3: compare in upper case
  const typeName = (id) => String(api.GetNameFromTypeCode(api.GetLineType(mid, id))).toUpperCase();
  const scale = model.lengthScale || 1;
  const out = [];
  for (let i = 0; i < ids.size(); i++) {
    const aid = ids.get(i);
    const line = api.GetLine(mid, aid, false);
    const r = raw[i];
    if (!r?.horizontal?.length) continue;
    // horizontal polyline (IFC X/Y), duplicate points removed. With COORDINATE_TO_ORIGIN web-ifc
    // returns the points shifted like the geometry; undo that shift to get real IFC coordinates.
    const shift = new THREE.Matrix4().fromArray(r.FlatCoordinationMatrix?.length === 16 ? r.FlatCoordinationMatrix : model.coordMatrix.elements).invert();
    const v3 = new THREE.Vector3();
    const poly = [];
    for (const seg of r.horizontal) {
      for (const p of seg.points) {
        v3.set(p.x, 0, -p.y).applyMatrix4(shift); // IFC (x, y) -> three.js (x, 0, -y)
        const q = [v3.x * scale, -v3.z * scale];
        const last = poly[poly.length - 1];
        if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) poly.push(q);
      }
    }
    if (poly.length < 2) continue;
    const cum = [0];
    for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]));
    // vertical profile
    const vertical = [];
    for (const child of nests.get(aid) || []) {
      if (typeName(child) !== 'IFCALIGNMENTVERTICAL') continue;
      for (const sid of nests.get(child) || []) {
        const seg = api.GetLine(mid, sid, false);
        const dp = seg?.DesignParameters?.value ? api.GetLine(mid, seg.DesignParameters.value, false) : null;
        if (!dp) continue;
        vertical.push({
          s0: num(dp.StartDistAlong) * scale, L: num(dp.HorizontalLength) * scale, h0: num(dp.StartHeight) * scale,
          g0: num(dp.StartGradient) ?? 0, g1: num(dp.EndGradient) ?? num(dp.StartGradient) ?? 0,
          type: dp.PredefinedType?.value || 'CONSTANTGRADIENT',
        });
      }
    }
    vertical.sort((a, b) => a.s0 - b.s0);
    // stationing from referents (IfcReferent with Pset_Stationing.Station)
    const referents = [];
    for (const child of nests.get(aid) || []) {
      if (typeName(child) !== 'IFCREFERENT') continue;
      const ref = api.GetLine(mid, child, false);
      let along = null;
      try {
        const pl = api.GetLine(mid, ref.ObjectPlacement?.value, false);
        const rp = pl?.RelativePlacement?.value ? api.GetLine(mid, pl.RelativePlacement.value, false) : null;
        const loc = rp?.Location?.value ? api.GetLine(mid, rp.Location.value, false) : null;
        along = num(loc?.DistanceAlong);
      } catch { /* not linearly placed */ }
      let station = null;
      try {
        const psets = await api.properties.getPropertySets(mid, child, true);
        for (const ps of psets) {
          if (fmtValue(ps.Name) !== 'Pset_Stationing') continue;
          for (const p of ps.HasProperties || []) if (fmtValue(p.Name) === 'Station') station = num(p.NominalValue);
        }
      } catch { /* optional */ }
      referents.push({ id: child, name: fmtValue(ref.Name), type: ref.PredefinedType?.value, along: along === null ? null : along * scale, station: station === null ? null : station * scale });
    }
    const st = referents.filter((x) => x.station !== null && x.along !== null).sort((a, b) => a.along - b.along);
    const station0 = st.length ? st[0].station - st[0].along : 0;
    out.push({ id: aid, model, name: fmtValue(line?.Name) || `Alignment #${aid}`, poly, cum, length: cum[cum.length - 1], vertical, referents, station0 });
  }
  return out;
}

/** Height of the vertical profile at distance s (null without a profile). */
export function heightAt(al, s) {
  const v = al.vertical;
  if (!v.length) return null;
  let seg = v[0];
  for (const x of v) if (s >= x.s0 - 1e-9) seg = x;
  const d = Math.min(Math.max(s - seg.s0, 0), seg.L || 0);
  if (seg.type === 'CONSTANTGRADIENT' || !seg.L) return seg.h0 + seg.g0 * d;
  // parabolic and circular arcs: gradient changes linearly (circular arc approximated, exact for small gradients)
  return seg.h0 + seg.g0 * d + ((seg.g1 - seg.g0) / (2 * seg.L)) * d * d;
}

/** Point and direction of the horizontal alignment at distance s. */
export function pointAt(al, s) {
  const { poly, cum } = al;
  s = Math.min(Math.max(s, 0), al.length);
  let k = 1;
  while (k < cum.length - 1 && cum[k] < s) k++;
  const a = poly[k - 1], b = poly[k];
  const L = cum[k] - cum[k - 1] || 1;
  const tt = (s - cum[k - 1]) / L;
  const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
  return { x: a[0] + (b[0] - a[0]) * tt, y: a[1] + (b[1] - a[1]) * tt, dx, dy };
}

/**
 * Projects an IFC point (x, y[, z]) onto the alignment.
 * Returns {s, station, offset (left positive, as in IFC), dz (height above the profile) | null, dist}.
 */
export function project(al, p) {
  const { poly, cum } = al;
  let best = null;
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1], b = poly[k];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey || 1e-12;
    let tt = ((p.x - a[0]) * ex + (p.y - a[1]) * ey) / L2;
    tt = Math.min(1, Math.max(0, tt));
    const qx = a[0] + ex * tt, qy = a[1] + ey * tt;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (!best || d < best.dist) {
      const L = Math.sqrt(L2);
      const side = Math.sign(ex * (p.y - a[1]) - ey * (p.x - a[0])) || 1; // > 0: left
      best = { dist: d, s: cum[k - 1] + tt * L, offset: side * d };
    }
  }
  const h = heightAt(al, best.s);
  return { ...best, station: al.station0 + best.s, dz: h !== null && p.z !== undefined ? p.z - h : null, profile: h };
}

export function formatStation(station, fmt = 'km') {
  if (fmt === 'm') return `${station.toFixed(3)} m`;
  const sign = station < 0 ? '-' : '';
  const a = Math.abs(station);
  const km = Math.floor(a / 1000);
  const m = a - km * 1000;
  return `${sign}${km}+${m.toFixed(3).padStart(7, '0')}`;
}

/** 3D display of alignments: the line (following the vertical profile) and station marks. */
export class AlignmentLayer {
  constructor(viewer, container) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    viewer.scene.add(this.group);
    this.layer = document.createElement('div');
    this.layer.className = 'measure-layer align-layer';
    container.append(this.layer);
    this.labels = [];
    this.visible = true;
    this.alignments = [];
    this.format = 'km';
    viewer.renderHooks.push(() => this.#place());
  }

  set(alignments) {
    this.alignments = alignments;
    this.rebuild();
  }

  rebuild() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    if (!this.visible) return;
    for (const al of this.alignments) {
      const zOf = (s) => heightAt(al, s) ?? 0;
      const pts = al.poly.map((p, k) => this.viewer.fromIfc(p[0], p[1], zOf(al.cum[k])));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xe8590c, depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 25;
      line.frustumCulled = false;
      this.group.add(line);
      // station marks
      const step = [10, 20, 50, 100, 200, 500, 1000, 2000].find((x) => al.length / x <= 25) || 5000;
      const first = Math.ceil(al.station0 / step) * step;
      const ticks = [];
      const half = Math.max(1, step / 40);
      for (let st = first; st <= al.station0 + al.length + 1e-6; st += step) {
        const s = st - al.station0;
        const p = pointAt(al, s);
        const z = zOf(s);
        const nx = -p.dy, ny = p.dx; // left normal
        ticks.push(this.viewer.fromIfc(p.x + nx * half, p.y + ny * half, z), this.viewer.fromIfc(p.x - nx * half, p.y - ny * half, z));
        const el = document.createElement('div');
        el.className = 'm-label align';
        el.textContent = formatStation(st, this.format);
        this.layer.append(el);
        this.labels.push({ el, at: this.viewer.fromIfc(p.x + nx * half * 1.5, p.y + ny * half * 1.5, z) });
      }
      if (ticks.length) {
        const tg = new THREE.BufferGeometry().setFromPoints(ticks);
        const tl = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xe8590c, depthTest: false }));
        tl.renderOrder = 25;
        tl.frustumCulled = false;
        this.group.add(tl);
      }
      // name at the start
      const el = document.createElement('div');
      el.className = 'm-label align name';
      el.textContent = al.name;
      this.layer.append(el);
      const p0 = al.poly[0];
      this.labels.unshift({ el, at: this.viewer.fromIfc(p0[0], p0[1], zOf(0)), offset: -20 });
    }
  }

  setVisible(v) { this.visible = v; this.rebuild(); }

  #place() {
    if (!this.labels.length) return;
    const placed = [];
    for (const l of this.labels) {
      const s = this.viewer.toScreen(l.at);
      // hide labels that would overlap one already shown (zoomed out)
      if (!s || placed.some((q) => Math.abs(q.x - s.x) < 80 && Math.abs(q.y - s.y) < 20)) { l.el.style.display = 'none'; continue; }
      placed.push(s);
      l.el.style.display = '';
      l.el.style.transform = `translate(${s.x}px, ${s.y + (l.offset || 0)}px) translate(-50%, -50%)`;
    }
  }

  /** Closest alignment for an IFC point, with station and offset. */
  locate(p) {
    let best = null;
    for (const al of this.alignments) {
      const r = project(al, p);
      if (!best || Math.abs(r.offset) < Math.abs(best.offset)) best = { ...r, alignment: al };
    }
    return best;
  }
}
