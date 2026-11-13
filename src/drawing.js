// 2D drawings from section planes: the cut through all visible elements is computed from the
// triangles, stitched into outlines and written as SVG, PDF or DXF.
import * as THREE from 'three';

/** Drawing axes for a section plane: we look from the cut-away side towards the kept side. */
export function planeAxes(entry) {
  const n = entry.plane.normal.clone().normalize(); // points to the kept side = viewing direction
  const horizontal = Math.abs(n.y) > 0.9;
  let up = horizontal ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0); // three: -Z = IFC +Y, Y = IFC Z
  up = up.sub(n.clone().multiplyScalar(n.dot(up))).normalize();
  const right = new THREE.Vector3().crossVectors(n, up).normalize();
  // station planes: x in the drawing is the offset from the alignment (right positive, looking ahead)
  const origin = entry.anchor ? entry.plane.projectPoint(entry.anchor, new THREE.Vector3()) : entry.plane.coplanarPoint(new THREE.Vector3());
  return { n, up, right, horizontal, origin };
}

/**
 * Cuts all visible elements with the plane. Returns {layers: Map(class -> {segments, loops, open}), bounds}.
 * Coordinates are 2D in metres: plan sections use real IFC X/Y, vertical sections use
 * (distance along the section, IFC Z).
 */
export function computeSection(viewer, entry, { marks = [], annot = null } = {}) {
  const ax = planeAxes(entry);
  const plane = entry.plane.clone();
  plane.constant += 1e-7; // avoid vertices exactly on the plane
  // in plans, cross sections at stations are shown as section marks, they do not clip the plan
  const others = viewer.planes.filter((p) => p.enabled && p !== entry && !(ax.horizontal && p.station)).map((p) => p.plane);
  const to2d = (p) => {
    if (ax.horizontal) { const q = viewer.toIfc(p); return [q.x, q.y]; }
    const q = viewer.toIfc(p);
    const d = p.clone().sub(ax.origin);
    return [d.dot(ax.right), q.z];
  };
  const layers = new Map();
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const pts = [va, vb, vc];
  for (const m of viewer.models) {
    if (!m.visible) continue;
    m.group.updateMatrixWorld(true);
    const mw = m.group.matrixWorld;
    const modelCol = m.overrideColor ? `#${m.overrideColor.getHexString()}` : null;
    for (const b of m.buckets) {
      const P = b.positions, I = b.index;
      const origCol = `#${b.color.getHexString()}`;
      for (const it of b.items) {
        if (m.hidden.has(it.id) || (m.elementOpacity.get(it.id) ?? 1) < 0.1) continue;
        const cls = m.typeName(it.id) || 'IfcElement';
        let segs = null;
        for (let k = it.start; k + 2 < it.start + it.count; k += 3) {
          for (let j = 0; j < 3; j++) { const vi = I[k + j] * 3; pts[j].set(P[vi], P[vi + 1], P[vi + 2]).applyMatrix4(mw); }
          const d0 = plane.distanceToPoint(va), d1 = plane.distanceToPoint(vb), d2 = plane.distanceToPoint(vc);
          if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;
          const cut = [];
          const ds = [d0, d1, d2];
          for (let j = 0; j < 3; j++) {
            const j2 = (j + 1) % 3;
            const da = ds[j], db = ds[j2];
            if ((da > 0) !== (db > 0)) {
              const tt = da / (da - db);
              cut.push(pts[j].clone().lerp(pts[j2], tt));
            }
          }
          if (cut.length !== 2) continue;
          // other active planes clip the drawing too
          if (others.some((o) => o.distanceToPoint(cut[0]) < 0 && o.distanceToPoint(cut[1]) < 0)) continue;
          const a = to2d(cut[0]), c = to2d(cut[1]);
          if (Math.hypot(a[0] - c[0], a[1] - c[1]) < 1e-6) continue;
          if (!segs) {
            if (!layers.has(cls)) layers.set(cls, { segments: [], elements: 0 });
            segs = [];
          }
          segs.push([a, c]);
          for (const p of [a, c]) {
            bounds.minX = Math.min(bounds.minX, p[0]); bounds.maxX = Math.max(bounds.maxX, p[0]);
            bounds.minY = Math.min(bounds.minY, p[1]); bounds.maxY = Math.max(bounds.maxY, p[1]);
          }
        }
        if (segs) {
          const L = layers.get(cls);
          L.elements++;
          const { loops, open } = stitch(segs);
          // colours of the element: as in the IFC file, and as currently shown in the viewer
          const own = m.elementColor.get(it.id);
          const col = { original: origCol, shown: own !== undefined ? `#${own.toString(16).padStart(6, '0')}` : modelCol || origCol };
          (L.loops ||= []).push(...loops);
          (L.loopCols ||= []).push(...loops.map(() => col));
          (L.open ||= []).push(...open);
          (L.openCols ||= []).push(...open.map(() => col));
          L.segments.push(...segs);
        }
      }
    }
  }
  // cross section at a station: the alignment axis (offset 0) is part of the drawing
  // marks may depend on the extent of the cut (e.g. the part of an alignment inside the plan)
  if (typeof marks === 'function') marks = Number.isFinite(bounds.minX) ? marks({ ...bounds }) : [];
  const out = [...marks];
  if (entry.station && Number.isFinite(bounds.minX)) {
    bounds.minX = Math.min(bounds.minX, 0); bounds.maxX = Math.max(bounds.maxX, 0);
    const pad = 0.06 * (bounds.maxY - bounds.minY || 1);
    out.push({ line: [[0, bounds.minY - pad], [0, bounds.maxY + pad]], color: AXIS_COLOR, dash: 'dashdot', layer: 'ALIGNMENT_AXIS' });
    out.push({ text: entry.stationLabel || '', at: [0, bounds.maxY + pad], dx: 1.2, dy: -1, size: 3, color: AXIS_COLOR, layer: 'ALIGNMENT_AXIS' });
  }
  // marks in plans (e.g. section marks) widen the drawing
  if (ax.horizontal && Number.isFinite(bounds.minX)) {
    for (const mk of marks) for (const p of mk.line || (mk.arrow ? [mk.arrow] : [mk.at])) {
      bounds.minX = Math.min(bounds.minX, p[0]); bounds.maxX = Math.max(bounds.maxX, p[0]);
      bounds.minY = Math.min(bounds.minY, p[1]); bounds.maxY = Math.max(bounds.maxY, p[1]);
    }
  }
  const section = { layers, bounds, axes: ax, marks: out };
  if (annot && !ax.horizontal && Number.isFinite(bounds.minX)) {
    section.annot = { ...annot, runs: breakPoints(layers, { classes: annot.classes }), originX: entry.station ? 0 : bounds.minX, station: !!entry.station };
    section.padTopMm = annot.mode !== 'band' ? 30 : 0;
    section.padBottomMm = annot.mode !== 'point' ? 34 : 0;
    section.marksFor = (lay) => annotationMarks(section, lay);
  }
  return section;
}

// ------------------------------------------------- break points of the top outline
/**
 * The upper outline of the cut (seen from above: the highest line at every x) of the chosen
 * classes, simplified to its real break points. Returns runs (separate where there is no
 * geometry): [[{x, y, sig}]], sig = change of direction in degrees (180 at the ends).
 */
export function breakPoints(layers, { classes = null, angle = 10, facet = 0.25, facetAngle = 35 } = {}) {
  const segs = [];
  for (const [cls, L] of layers) {
    if (classes && !classes.has(cls)) continue;
    const add = (a, b) => { if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) segs.push(a[0] <= b[0] ? [a, b] : [b, a]); };
    for (const l of L.loops || []) for (let i = 0; i < l.length; i++) add(l[i], l[(i + 1) % l.length]);
    for (const l of L.open || []) for (let i = 1; i < l.length; i++) add(l[i - 1], l[i]);
  }
  if (!segs.length) return [];
  let x0 = Infinity, x1 = -Infinity;
  for (const [a, b] of segs) { x0 = Math.min(x0, a[0]); x1 = Math.max(x1, b[0]); }
  const span = Math.max(x1 - x0, 1e-6), eps = span * 1e-7;
  // bins along x for a fast lookup of the segments over an x
  const NB = Math.min(4096, Math.max(16, Math.round(segs.length / 4)));
  const bins = Array.from({ length: NB }, () => []);
  const bin = (x) => Math.min(NB - 1, Math.max(0, Math.floor(((x - x0) / span) * NB)));
  segs.forEach((sg, i) => { for (let k = bin(sg[0][0]); k <= bin(sg[1][0]); k++) bins[k].push(i); });
  const yAt = (sg, x) => {
    const [a, b] = sg, dx = b[0] - a[0];
    if (dx < eps) return Math.max(a[1], b[1]);
    return a[1] + ((b[1] - a[1]) * (x - a[0])) / dx;
  };
  /** Highest y at x (null where no segment covers x). */
  const top = (x) => {
    let best = null;
    for (const i of bins[bin(x)]) { const sg = segs[i]; if (x < sg[0][0] - eps || x > sg[1][0] + eps) continue; const y = yAt(sg, x); if (best === null || y > best) best = y; }
    return best;
  };
  // the outline changes only at segment ends and where two segments cross
  const xs = [...new Set(segs.flatMap(([a, b]) => [a[0], b[0]]))].sort((p, q) => p - q);
  const ux = [];
  for (const x of xs) if (!ux.length || x - ux[ux.length - 1] > eps * 10) ux.push(x);
  const runs = [];
  let run = null;
  const push = (x, y) => { const l = run[run.length - 1]; if (!l || Math.abs(l.x - x) > eps || Math.abs(l.y - y) > 1e-6) run.push({ x, y }); };
  const d = span * 1e-6;
  for (let i = 0; i < ux.length; i++) {
    const x = ux[i];
    const yl = top(x - d), yr = top(x + d), yc = top(x);
    if (yc === null) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    // a step (vertical face): both heights at this x, in the order of walking left to right
    if (yl !== null && yr !== null) { push(x, yl); if (Math.abs(yl - yr) > 1e-4) push(x, yr); }
    else if (yr !== null) push(x, yr); // the outline starts here
    else if (yl !== null) push(x, yl); // … and ends here
    else push(x, yc);
    if (i + 1 >= ux.length) break;
    const xn = ux[i + 1], xm = (x + xn) / 2;
    if (top(xm) === null) { run = null; continue; }
    // crossings inside (x, xn): upper envelope of the straight segments covering the interval
    const lines = [];
    for (const j of bins[bin(xm)]) {
      const sg = segs[j];
      if (sg[0][0] > x + eps || sg[1][0] < xn - eps || sg[1][0] - sg[0][0] < eps) continue;
      const m = (sg[1][1] - sg[0][1]) / (sg[1][0] - sg[0][0]);
      lines.push({ m, c: sg[0][1] - m * sg[0][0] });
    }
    if (lines.length < 2) continue;
    const at = (l, xx) => l.m * xx + l.c;
    let cur = lines.reduce((p, q) => (at(q, x + d) > at(p, x + d) + 1e-9 || (Math.abs(at(q, x + d) - at(p, x + d)) <= 1e-9 && q.m > p.m) ? q : p));
    let xc = x;
    for (let guard = 0; guard < lines.length; guard++) {
      let next = null, nx = xn;
      for (const l of lines) {
        if (l.m <= cur.m + 1e-12) continue;
        const xi = (cur.c - l.c) / (l.m - cur.m);
        if (xi > xc + eps && xi < nx - eps) { nx = xi; next = l; }
      }
      if (!next) break;
      push(nx, at(cur, nx));
      cur = next; xc = nx;
    }
  }
  // keep only real break points (direction changes more than `angle` degrees)
  const out = [];
  for (const r of runs) {
    if (r.length < 2) continue;
    const kept = [{ ...r[0], sig: 180 }];
    for (let i = 1; i < r.length - 1; i++) {
      const p = kept[kept.length - 1], q = r[i], n = r[i + 1];
      const a1 = Math.atan2(q.y - p.y, q.x - p.x), a2 = Math.atan2(n.y - q.y, n.x - q.x);
      let da = Math.abs(((a2 - a1) * 180) / Math.PI) % 360;
      if (da > 180) da = 360 - da;
      // facets of round shapes (pipes, rails, rounded edges): short pieces with a moderate bend
      const short = Math.min(Math.hypot(q.x - p.x, q.y - p.y), Math.hypot(n.x - q.x, n.y - q.y)) < facet;
      if (da >= angle && !(short && da < facetAngle)) kept.push({ ...q, sig: da });
    }
    kept.push({ ...r[r.length - 1], sig: 180 });
    out.push(kept);
  }
  return out;
}

export const ANNOT_COLOR = '#0B6F69';

/**
 * Annotation marks of the break points for a layout (null: DXF, about 1:100):
 * mode 'band' (band of offsets and heights under the cut), 'point' (texts at the points) or 'both';
 * slopes between the break points (% or 1:n).
 */
function annotationMarks(section, lay) {
  const A = section.annot;
  if (!A?.runs?.length) return [];
  const k = lay ? lay.scale / 1000 : 0.1; // metres per paper mm
  const b = section.bounds;
  const dec = A.dec || '.';
  const num = (v, n = 3) => (Math.abs(v) < 0.5 * 10 ** -n ? 0 : v).toFixed(n).replace('.', dec);
  const layer = 'ANNOTATION_POINTS', col = ANNOT_COLOR, grey = '#444444';
  const out = [];
  const txt = (text, at, o = {}) => out.push({ text, at, size: o.size ?? 2.3, rot: o.rot || 0, anchor: o.anchor || 'start', color: o.color || grey, layer, dxfH: (o.size ?? 2.3) * k, bold: o.bold });
  // points with the same x (vertical faces) are one entry with several heights
  const all = [];
  for (const r of A.runs) for (const p of r) {
    const e = all.find((q) => Math.abs(q.x - p.x) < 1e-4);
    if (e) { if (!e.ys.some((y) => Math.abs(y - p.y) < 1e-4)) e.ys.push(p.y); e.sig = Math.max(e.sig, p.sig); }
    else all.push({ x: p.x, ys: [p.y], sig: p.sig });
  }
  // the most significant first, then nothing closer than the text needs on paper
  const gap = 3.6 * k;
  const picked = [];
  for (const e of [...all].sort((p, q) => q.sig - p.sig)) if (!picked.some((q) => Math.abs(q.x - e.x) < gap)) picked.push(e);
  picked.sort((p, q) => p.x - q.x);
  for (const e of picked) e.ys.sort((p, q) => q - p);
  const off = (x) => num(x - A.originX);
  const heights = (e) => e.ys.map((y) => num(y)).join(' / ');
  const mark = (x, y) => {
    const s = 0.9 * k;
    out.push({ line: [[x - s, y - s], [x + s, y + s]], color: col, w: 0.25, layer });
    out.push({ line: [[x - s, y + s], [x + s, y - s]], color: col, w: 0.25, layer });
  };
  // band under the cut: leader from each point down, rows of offsets and heights
  if (A.mode !== 'point') {
    const top0 = b.minY - 4 * k, row = 14 * k, mid = top0 - row, bot = mid - row;
    for (const y of [top0, mid, bot]) out.push({ line: [[b.minX, y], [b.maxX, y]], color: grey, w: 0.25, layer });
    txt(A.labels?.offset || 'Offset', [b.minX - 2 * k, top0 - row / 2 - 0.9 * k], { anchor: 'end', size: 2.5, bold: true });
    txt(A.labels?.height || 'Height', [b.minX - 2 * k, mid - row / 2 - 0.9 * k], { anchor: 'end', size: 2.5, bold: true });
    for (const e of picked) {
      out.push({ line: [[e.x, e.ys[e.ys.length - 1]], [e.x, top0]], color: '#9aa0a6', w: 0.12, dash: 'dot', layer });
      out.push({ line: [[e.x, top0], [e.x, bot]], color: grey, w: 0.12, layer });
      // vertical texts, centred in their row, just right of the tick
      // vertical texts (rotated 90°: the letters lie left of the baseline), centred in their row
      txt(off(e.x), [e.x + 2.2 * k, top0 - row / 2], { rot: 90, anchor: 'middle' });
      txt(heights(e), [e.x + (e.ys.length > 1 ? 1.9 : 2.2) * k, mid - row / 2], { rot: 90, anchor: 'middle', size: e.ys.length > 1 ? 1.9 : 2.3 });
      mark(e.x, e.ys[0]);
    }
  }
  // texts at the points: short leader up, "offset / height" upwards
  if (A.mode !== 'band') {
    for (const e of picked) {
      const y = e.ys[0];
      if (A.mode === 'point') mark(e.x, y);
      out.push({ line: [[e.x, y + 1.2 * k], [e.x, y + 5 * k]], color: col, w: 0.18, layer });
      txt(`${off(e.x)} / ${heights(e)}`, [e.x + 0.8 * k, y + 5.6 * k], { rot: 90, color: col });
      out[out.length - 1].at[0] = e.x + 0.85 * k; // centred on the leader
    }
  }
  // slopes between the break points (not for vertical faces and very short pieces)
  if (A.slopes) {
    for (const r of A.runs) {
      for (let i = 1; i < r.length; i++) {
        const p = r[i - 1], q = r[i];
        const dx = q.x - p.x, dy = q.y - p.y;
        if (Math.abs(dx) < 1e-6 || Math.hypot(dx, dy) < 10 * k || Math.abs(dy / dx) > 6) continue;
        const sl = dy / dx;
        let text;
        if (Math.abs(sl) < 0.1) text = `${sl > 0 ? '+' : sl < 0 ? '-' : ''}${Math.abs(sl * 100).toFixed(1).replace('.', dec)} %`;
        else text = `1:${String(+(1 / Math.abs(sl)).toFixed(2)).replace('.', dec)}`;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        const n = [-Math.sin((ang * Math.PI) / 180), Math.cos((ang * Math.PI) / 180)]; // left normal = up for a rising line
        txt(text, [mx + n[0] * 1.4 * k, my + n[1] * 1.4 * k], { rot: ang, anchor: 'middle', size: 2.1, color: '#2d6a2d' });
      }
    }
  }
  return out;
}

export const AXIS_COLOR = '#C8372D';

// ----------------------------------------------------------- long profile
const niceStep = (range, maxCount, steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) =>
  steps.find((x) => range / x <= maxCount) || steps[steps.length - 1];

/**
 * Long profile along a path (an alignment or a drawn line): the visible elements are cut with
 * the vertical surface that follows the path, and unrolled. Drawing coordinates: x = station,
 * y = height × exag. path: {poly: [[x, y]] (IFC), cum, length, station0, name}; heightOf(s) gives
 * the profile line of the path (or null). opts: {from, to (distance along), exag, fmt(station)}.
 */
export function computeProfile(viewer, path, heightOf, { from = 0, to = path.length, exag = 1, fmt = (st) => st.toFixed(1) } = {}) {
  const s0 = Math.max(0, Math.min(from, to)), s1 = Math.min(path.length, Math.max(from, to));
  const { poly, cum } = path;
  // segments of the path inside the range
  const segs = [];
  for (let k = 1; k < poly.length; k++) {
    if (cum[k] < s0 || cum[k - 1] > s1) continue;
    const a = poly[k - 1], b = poly[k];
    const L = cum[k] - cum[k - 1];
    if (L < 1e-9) continue;
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    segs.push({ a, c0: cum[k - 1], L, ux, uy, nx: -uy, ny: ux, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
  }
  // grid of the segments for a fast lookup by the triangles' extent
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const g of segs) { gx0 = Math.min(gx0, g.minX); gy0 = Math.min(gy0, g.minY); gx1 = Math.max(gx1, g.maxX); gy1 = Math.max(gy1, g.maxY); }
  const cell = Math.max(2, Math.hypot(gx1 - gx0, gy1 - gy0) / 400);
  const grid = new Map();
  const ckey = (i, j) => i * 1000003 + j;
  segs.forEach((g, idx) => {
    for (let i = Math.floor((g.minX - gx0) / cell); i <= Math.floor((g.maxX - gx0) / cell); i++) {
      for (let j = Math.floor((g.minY - gy0) / cell); j <= Math.floor((g.maxY - gy0) / cell); j++) {
        const kk = ckey(i, j);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(idx);
      }
    }
  });

  const layers = new Map();
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const inv = viewer.referenceMatrix ? viewer.referenceMatrix.clone().invert() : new THREE.Matrix4();
  const v = new THREE.Vector3();
  const X = new Float64Array(9);
  const stamp = new Int32Array(segs.length);
  let tri = 0;
  for (const m of viewer.models) {
    if (!m.visible || !segs.length) continue;
    m.group.updateMatrixWorld(true);
    const M = inv.clone().multiply(m.group.matrixWorld);
    const modelCol = m.overrideColor ? `#${m.overrideColor.getHexString()}` : null;
    for (const b of m.buckets) {
      const P = b.positions, I = b.index;
      const origCol = `#${b.color.getHexString()}`;
      for (const it of b.items) {
        if (m.hidden.has(it.id) || (m.elementOpacity.get(it.id) ?? 1) < 0.1) continue;
        let pieces = null;
        for (let k = it.start; k + 2 < it.start + it.count; k += 3) {
          for (let j = 0; j < 3; j++) {
            const vi = I[k + j] * 3;
            v.set(P[vi], P[vi + 1], P[vi + 2]).applyMatrix4(M);
            X[j * 3] = v.x; X[j * 3 + 1] = -v.z; X[j * 3 + 2] = v.y; // three -> IFC
          }
          const tx0 = Math.min(X[0], X[3], X[6]), tx1 = Math.max(X[0], X[3], X[6]);
          const ty0 = Math.min(X[1], X[4], X[7]), ty1 = Math.max(X[1], X[4], X[7]);
          if (tx1 < gx0 || tx0 > gx1 || ty1 < gy0 || ty0 > gy1) continue;
          tri++;
          for (let i = Math.floor((tx0 - gx0) / cell); i <= Math.floor((tx1 - gx0) / cell); i++) {
            for (let j = Math.floor((ty0 - gy0) / cell); j <= Math.floor((ty1 - gy0) / cell); j++) {
              const list = grid.get(ckey(i, j));
              if (!list) continue;
              for (const si of list) {
                if (stamp[si] === tri) continue;
                stamp[si] = tri;
                const g = segs[si];
                const d = [0, 1, 2].map((q) => (X[q * 3] - g.a[0]) * g.nx + (X[q * 3 + 1] - g.a[1]) * g.ny + 1e-7);
                if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
                const cut = [];
                for (let q = 0; q < 3; q++) {
                  const q2 = (q + 1) % 3;
                  if ((d[q] > 0) !== (d[q2] > 0)) {
                    const f = d[q] / (d[q] - d[q2]);
                    const x = X[q * 3] + (X[q2 * 3] - X[q * 3]) * f, y = X[q * 3 + 1] + (X[q2 * 3 + 1] - X[q * 3 + 1]) * f, z = X[q * 3 + 2] + (X[q2 * 3 + 2] - X[q * 3 + 2]) * f;
                    cut.push([(x - g.a[0]) * g.ux + (y - g.a[1]) * g.uy, z]); // [distance along the segment, z]
                  }
                }
                if (cut.length !== 2) continue;
                // keep the part over this segment and inside the range
                let [p, q] = cut[0][0] <= cut[1][0] ? cut : [cut[1], cut[0]];
                const lo = Math.max(0, s0 - g.c0), hi = Math.min(g.L, s1 - g.c0);
                if (q[0] < lo || p[0] > hi) continue;
                const lerp = (A, B, t) => [t, A[1] + ((B[1] - A[1]) * (t - A[0])) / (B[0] - A[0] || 1)];
                if (p[0] < lo) p = lerp(p, q, lo);
                if (q[0] > hi) q = lerp(p, q, hi);
                const A2 = [g.c0 + p[0], p[1] * exag], B2 = [g.c0 + q[0], q[1] * exag];
                if (Math.hypot(A2[0] - B2[0], A2[1] - B2[1]) < 1e-6) continue;
                (pieces ||= []).push([A2, B2]);
                for (const pt of [A2, B2]) {
                  bounds.minX = Math.min(bounds.minX, pt[0]); bounds.maxX = Math.max(bounds.maxX, pt[0]);
                  bounds.minY = Math.min(bounds.minY, pt[1]); bounds.maxY = Math.max(bounds.maxY, pt[1]);
                }
              }
            }
          }
        }
        if (!pieces) continue;
        const cls = m.typeName(it.id) || 'IfcElement';
        if (!layers.has(cls)) layers.set(cls, { segments: [], elements: 0 });
        const L = layers.get(cls);
        L.elements++;
        const { loops, open } = stitch(pieces);
        const own = m.elementColor.get(it.id);
        const col = { original: origCol, shown: own !== undefined ? `#${own.toString(16).padStart(6, '0')}` : modelCol || origCol };
        (L.loops ||= []).push(...loops);
        (L.loopCols ||= []).push(...loops.map(() => col));
        (L.open ||= []).push(...open);
        (L.openCols ||= []).push(...open.map(() => col));
        L.segments.push(...pieces);
      }
    }
  }

  // profile line of the path
  const marks = [];
  const line = [];
  const n = Math.min(2000, Math.max(50, Math.ceil((s1 - s0) / 2)));
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const z = heightOf(s);
    if (z === null || !Number.isFinite(z)) continue;
    line.push([s, z * exag]);
  }
  for (const p of line) { bounds.minY = Math.min(bounds.minY, p[1]); bounds.maxY = Math.max(bounds.maxY, p[1]); }
  bounds.minX = Math.min(bounds.minX, s0); bounds.maxX = Math.max(bounds.maxX, s1);
  if (!Number.isFinite(bounds.minY)) { bounds.minY = 0; bounds.maxY = 1; }
  // grid of stations and heights; chosen when the scale on paper is known (marksFor)
  const zLo = bounds.minY / exag, zHi = Math.max(bounds.maxY / exag, zLo + 0.5);
  const yPad = (zHi - zLo) * exag * 0.06;
  const y0 = zLo * exag - yPad, y1 = zHi * exag + yPad;
  const band = (y1 - y0) * 0.06;
  if (line.length > 1) marks.push({ line, color: AXIS_COLOR, w: 0.35, layer: 'PROFILE_LINE' });
  bounds.minY = y0 - band; bounds.maxY = y1;
  const marksFor = (lay) => {
    const GRID = '#9aa0a6', layer = 'PROFILE_GRID', out = [];
    // mm on paper per metre of drawing; without a layout (DXF) about 12 stations and 8 heights
    const mmPerM = lay ? 1000 / lay.scale : null;
    const sStep = mmPerM ? ([0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((x) => x * mmPerM >= 24) || 5000) : niceStep(Math.max(s1 - s0, 1), 12);
    const hStep = mmPerM ? [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].find((x) => x * exag * mmPerM >= 8) || 100 : niceStep(Math.max(zHi - zLo, 0.5), 8);
    const dec = hStep < 0.1 ? 2 : hStep < 1 ? 1 : 0;
    for (let h = Math.ceil(zLo / hStep - 1e-9) * hStep; h <= zHi + 1e-9; h += hStep) {
      out.push({ line: [[s0, h * exag], [s1, h * exag]], color: GRID, w: 0.12, dash: 'dot', layer });
      out.push({ text: h.toFixed(dec), at: [s0, h * exag], dx: -1.5, dy: 0.9, size: 2.4, anchor: 'end', color: '#555555', layer });
    }
    const st0 = path.station0 + s0, st1 = path.station0 + s1;
    for (let st = Math.ceil(st0 / sStep - 1e-9) * sStep; st <= st1 + 1e-6; st += sStep) {
      const s = st - path.station0;
      out.push({ line: [[s, y0 - band], [s, y1]], color: GRID, w: 0.12, dash: 'dot', layer });
      out.push({ text: fmt(st), at: [s, y0 - band], dy: 3.2, size: 2.4, anchor: 'middle', color: '#333333', layer });
      const z = heightOf(s);
      if (z !== null && Number.isFinite(z)) out.push({ text: z.toFixed(2), at: [s, y0 - band], dy: 6.4, size: 2.2, anchor: 'middle', color: AXIS_COLOR, layer });
    }
    out.push({ line: [[s0, y0 - band], [s1, y0 - band]], color: '#333333', w: 0.25, layer });
    return out;
  };
  return { layers, bounds, axes: null, marks, marksFor, profile: true };
}
const DASH = { dashdot: [6, 1.5, 1, 1.5], dash: [3, 2], dot: [0.6, 1.2] };
const dashOf = (d) => (Array.isArray(d) ? d : DASH[d]) || null;

/**
 * Annotation marks of a drawing, coordinates in drawing metres, sizes in paper mm:
 *   {line: [[x, y], ...], color, w, dash: 'dashdot'|'dash'|'dot'|[mm...], closed, fill, layer}
 *   {arrow: [x, y], dir: [dx, dy], size, color, layer}    stub with an arrowhead, pointing along dir
 *   {text, at: [x, y], dx, dy, size, color, anchor: 'start'|'middle'|'end', bold, layer}
 */
function arrowShape(lay, mk) {
  const [bx, by] = lay.map(mk.arrow);
  let vx = mk.dir[0], vy = -mk.dir[1];
  const L = Math.hypot(vx, vy) || 1; vx /= L; vy /= L;
  const sz = mk.size ?? 5;
  const stubEnd = [bx + vx * sz * 0.55, by + vy * sz * 0.55];
  const tip = [bx + vx * sz, by + vy * sz];
  const px = -vy, py = vx, hw = sz * 0.28;
  return { stub: [[bx, by], stubEnd], head: [tip, [stubEnd[0] + px * hw, stubEnd[1] + py * hw], [stubEnd[0] - px * hw, stubEnd[1] - py * hw]] };
}
const textX = (x, mk) => { const w = textW(String(mk.text), mk.size ?? 3, mk.bold); return mk.anchor === 'middle' ? x - w / 2 : mk.anchor === 'end' ? x - w : x; };

const allMarks = (section, lay) => [...(section.marksFor?.(lay) || []), ...(section.marks || [])];

function marksSvg(section, lay) {
  const out = [];
  for (const mk of allMarks(section, lay)) {
    const col = mk.color || '#000';
    if (mk.line) {
      const pts = mk.line.map((p) => lay.map(p));
      const d = dashOf(mk.dash);
      out.push(`<path d="M${pts.map((p) => p.map(f2).join(' ')).join('L')}${mk.closed ? 'Z' : ''}" fill="${mk.fill || 'none'}" stroke="${col}" stroke-width="${mk.w ?? 0.25}" stroke-linecap="round"${d ? ` stroke-dasharray="${d.join(' ')}"` : ''}/>`);
    } else if (mk.arrow) {
      const a = arrowShape(lay, mk);
      out.push(`<path d="M${a.stub.map((p) => p.map(f2).join(' ')).join('L')}" stroke="${col}" stroke-width="${mk.w ?? 0.7}" fill="none"/><path d="M${a.head.map((p) => p.map(f2).join(' ')).join('L')}Z" fill="${col}" stroke="none"/>`);
    } else if (mk.text !== undefined) {
      const [x0, y0] = lay.map(mk.at);
      const x = x0 + (mk.dx || 0), y = y0 + (mk.dy || 0);
      out.push(`<text x="${f2(x)}" y="${f2(y)}" font-family="Helvetica, Arial, sans-serif" font-size="${mk.size ?? 3}"${mk.bold ? ' font-weight="bold"' : ''} text-anchor="${mk.anchor || 'start'}" fill="${col}"${mk.rot ? ` transform="rotate(${f2(-mk.rot)} ${f2(x)} ${f2(y)})"` : ''}>${escXml(mk.text)}</text>`);
    }
  }
  return out.join('\n');
}

function marksPdf(section, lay, P, k, rgb) {
  const c = [];
  for (const mk of allMarks(section, lay)) {
    const col = rgb(mk.color || '#000000');
    if (mk.line) {
      const pts = mk.line.map((p) => lay.map(p));
      const d = dashOf(mk.dash);
      c.push(`q ${col} RG ${mk.fill ? `${rgb(mk.fill)} rg ` : ''}${((mk.w ?? 0.25) * k).toFixed(3)} w ${d ? `[${d.map((v) => (v * k).toFixed(2)).join(' ')}] 0 d ` : ''}${P(...pts[0])} m ${pts.slice(1).map((p) => `${P(...p)} l`).join(' ')}${mk.closed ? ' h' : ''} ${mk.fill ? 'B' : 'S'} Q`);
    } else if (mk.arrow) {
      const a = arrowShape(lay, mk);
      c.push(`q ${col} RG ${col} rg ${((mk.w ?? 0.7) * k).toFixed(3)} w ${P(...a.stub[0])} m ${P(...a.stub[1])} l S ${P(...a.head[0])} m ${P(...a.head[1])} l ${P(...a.head[2])} l h f Q`);
    } else if (mk.text !== undefined) {
      const [x0, y0] = lay.map(mk.at);
      const x = x0 + (mk.dx || 0), y = y0 + (mk.dy || 0);
      const font = `/${mk.bold ? 'F2' : 'F1'} ${((mk.size ?? 3) * k).toFixed(2)} Tf`;
      if (mk.rot) {
        // rotated: text matrix; the anchor moves the start back along the text direction
        const a = (mk.rot * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
        const w = textW(String(mk.text), mk.size ?? 3, mk.bold) * (mk.anchor === 'middle' ? 0.5 : mk.anchor === 'end' ? 1 : 0);
        c.push(`q ${col} rg BT ${font} ${cs.toFixed(4)} ${sn.toFixed(4)} ${(-sn).toFixed(4)} ${cs.toFixed(4)} ${P(x - cs * w, y + sn * w)} Tm (${pdfStr(mk.text)}) Tj ET Q`);
      } else c.push(`q ${col} rg BT ${font} ${P(textX(x, mk), y)} Td (${pdfStr(mk.text)}) Tj ET Q`);
    }
  }
  return c;
}

/** Joins segments into closed loops and open polylines (endpoints matched within 0.1 mm). */
/**
 * The mark of the app (a cross section and the point that looks at it) after the last line of the
 * title block: {line: [[x, y]…], dot: [cx, cy, r], w} in paper mm (y down).
 */
function titleMark(info, lay, opts) {
  const lines = titleLines(info, lay, opts);
  const l = lines[lines.length - 1];
  const ty = lay.H - lay.margin / 2 - lay.title;
  const size = 4.2, k = size / 64;
  const x0 = lay.margin + textW(l.text, l.size) * 0.92 + 1, y0 = ty + l.y - size * 0.72; // textW is generous
  const P = (x, y) => [x0 + x * k, y0 + y * k];
  return { line: [P(6, 30), P(19, 30), P(28, 48), P(36, 48), P(45, 30), P(58, 30)], dot: [...P(32, 14), 6 * k], w: 4.8 * k };
}

export function stitch(segs) {
  const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const adj = new Map();
  segs.forEach((s, i) => {
    for (const e of [0, 1]) {
      const k = key(s[e]);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push([i, e]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [], open = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segs[i][0], segs[i][1]];
    // extend forward, then backward
    for (const dir of [1, -1]) {
      for (;;) {
        const end = dir === 1 ? line[line.length - 1] : line[0];
        const next = (adj.get(key(end)) || []).find(([j]) => !used[j]);
        if (!next) break;
        const [j, e] = next;
        used[j] = 1;
        const p = segs[j][1 - e];
        if (dir === 1) line.push(p); else line.unshift(p);
      }
    }
    const closed = line.length > 3 && key(line[0]) === key(line[line.length - 1]);
    (closed ? loops : open).push(closed ? line.slice(0, -1) : line);
  }
  return { loops, open };
}

// --------------------------------------------------------------- layout
export const PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
export const SCALES = [10, 20, 50, 100, 200, 500, 1000, 2000];

/** Chooses scale/paper: opts {paper: 'A3'|'auto', scale: number|'fit'} -> {W, H, scale, ...} in mm. */
export function layout(section, opts) {
  const b = section.bounds;
  const wM = Math.max(b.maxX - b.minX, 0.01), hM = Math.max(b.maxY - b.minY, 0.01);
  const margin = 15, title = 22;
  // room for annotations above / below the drawing (e.g. the band of offsets and heights)
  const padT = section.padTopMm || 0, padB = section.padBottomMm || 0;
  let [W, H] = opts.paper === 'auto' ? [0, 0] : PAPERS[opts.paper] || PAPERS.A3;
  let scale = opts.scale;
  if (scale === 'fit') {
    if (!W) [W, H] = PAPERS.A3;
    const s = Math.max((wM * 1000) / (W - 2 * margin), (hM * 1000) / Math.max(20, H - 2 * margin - title - padT - padB));
    scale = SCALES.find((x) => x >= s) || Math.ceil(s / 1000) * 1000;
  }
  const dw = (wM * 1000) / scale, dh = (hM * 1000) / scale;
  if (!W) { W = Math.ceil(dw + 2 * margin); H = Math.ceil(dh + 2 * margin + title + padT + padB); }
  const ox = (W - dw) / 2, oy = margin + padT + (H - 2 * margin - title - padT - padB - dh) / 2;
  return {
    W, H, scale, margin, title,
    // metres -> paper mm (y down)
    map: (p) => [ox + ((p[0] - b.minX) * 1000) / scale, oy + ((b.maxY - p[1]) * 1000) / scale],
    fits: dw <= W - 2 * margin + 0.01 && dh <= H - 2 * margin - title - padT - padB + 0.01,
  };
}

// --------------------------------------------------------------- colours
const CLASS_COLORS = {
  IfcWall: '#c0392b', IfcWallStandardCase: '#c0392b', IfcSlab: '#2c3e50', IfcRoof: '#7f4f24', IfcBeam: '#1f6feb', IfcColumn: '#1f6feb',
  IfcMember: '#8e44ad', IfcDoor: '#d35400', IfcWindow: '#16a085', IfcStair: '#6c5ce7', IfcStairFlight: '#6c5ce7', IfcRailing: '#7f8c8d',
  IfcFooting: '#5d4037', IfcPile: '#5d4037', IfcSpace: '#95a5a6', IfcPlate: '#2980b9', IfcCovering: '#b7950b', IfcFurnishingElement: '#a1887f',
  IfcBuildingElementProxy: '#636e72', IfcCourse: '#8d6e63', IfcPavement: '#424242', IfcRail: '#e17055', IfcSite: '#558b2f', IfcEarthworksFill: '#795548',
};
const PALETTE = ['#c0392b', '#2c3e50', '#1f6feb', '#8e44ad', '#d35400', '#16a085', '#6c5ce7', '#b7950b', '#00838f', '#ad1457'];
export function classColor(cls, i) { return CLASS_COLORS[cls] || PALETTE[i % PALETTE.length]; }
const tint = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * f);
  return `#${[mix(r), mix(g), mix(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** opts.colors: 'class' (a colour per IFC class), 'original' (IFC file), 'shown' (as in the viewer), 'mono' */
const isModelColors = (opts) => !opts.mono && (opts.colors === 'original' || opts.colors === 'shown');

/** Loops and open lines of a layer grouped by element colour. */
function groupByColor(L, which) {
  const groups = new Map();
  const get = (hex) => { let g = groups.get(hex); if (!g) { g = { loops: [], open: [] }; groups.set(hex, g); } return g; };
  L.loops.forEach((l, j) => get(L.loopCols?.[j]?.[which] || '#c8c8c8').loops.push(l));
  L.open.forEach((l, j) => get(L.openCols?.[j]?.[which] || '#c8c8c8').open.push(l));
  return groups;
}

/** A darker shade of a colour for the outline (black for very dark colours). */
function outline(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = 0.45;
  return `#${[r, g, b].map((x) => Math.round(x * f).toString(16).padStart(2, '0')).join('')}`;
}

// --------------------------------------------------------------- writers
const escXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (x) => (Math.round(x * 100) / 100).toString();

// Approximate Helvetica widths (em) – a little generous, so text never runs into the scale bar
const charW = (ch, bold) => {
  if (/[ilI.,:;!|'`]/.test(ch)) return 0.28;
  if (/[fjrt()\[\]\-/ ]/.test(ch)) return 0.36;
  if (/[mwMW]/.test(ch)) return bold ? 0.92 : 0.86;
  if (/[A-Z]/.test(ch)) return bold ? 0.74 : 0.70;
  return bold ? 0.6 : 0.56;
};
const textW = (str, size, bold = false) => { let w = 0; for (const ch of str) w += charW(ch, bold); return w * size; };

/** Cuts text to a width, ending with '...'. */
function fit(str, size, maxW, bold = false) {
  if (textW(str, size, bold) <= maxW) return str;
  let out = '';
  for (const ch of str) {
    if (textW(`${out}${ch}...`, size, bold) > maxW) break;
    out += ch;
  }
  return `${out}...`;
}

/** Wraps text into at most maxLines lines; breaks after ', ', ' ', '_' or '-'. */
function wrap(str, size, maxW, maxLines) {
  const tokens = str.split(/(?<=, |\s|_|-)/);
  const lines = [];
  let cur = '';
  for (const tk of tokens) {
    if (cur && textW(cur + tk, size) > maxW) {
      lines.push(cur.trimEnd());
      cur = '';
      if (lines.length === maxLines) break;
    }
    cur += tk;
  }
  if (lines.length < maxLines && cur) lines.push(cur.trimEnd());
  const used = lines.join('').replace(/\s/g, '').length;
  if (used < str.replace(/\s/g, '').length) lines[lines.length - 1] = fit(`${lines[lines.length - 1]} ...`, size, maxW);
  return lines.map((l) => fit(l, size, maxW));
}

/**
 * Text lines of the title block, fitted into the space left of the legend / scale bar:
 * [{text, size, bold, y}] with y relative to the top of the title block.
 */
function titleLines(info, lay, opts = {}) {
  const m = lay.margin;
  const step = niceBar(lay);
  const barLeft = lay.W - m - 4 * ((step * 1000) / lay.scale) - 10;
  const legend = !opts.mono && !isModelColors(opts) && opts.legend !== false;
  const right = Math.min(barLeft, legend ? lay.W / 2 - 22 : barLeft) - 4;
  const maxW = Math.max(40, right - m);
  const sub = wrap(String(info.subtitle ?? ''), 3.2, maxW, 2);
  const lines = [{ text: fit(String(info.title ?? ''), 5, maxW, true), size: 5, bold: true, y: 7 }];
  sub.forEach((t, i) => lines.push({ text: t, size: 3.2, y: 11.8 + i * 3.8 }));
  const scaleText = info.exag && info.exag !== 1 ? `1:${lay.scale} / 1:${+(lay.scale / info.exag).toFixed(2)} (${info.exag}×)` : `1:${lay.scale}`;
  lines.push({ text: fit(`${scaleText}  ·  ${info.date}  ·  OnlineIFC`, 3, maxW), size: 3, y: sub.length > 1 ? 20.2 : 18.5 });
  return lines;
}

/** SVG drawing (sizes in mm). opts: {fill, mono, background: {dataUrl}} */
export function toSvg(section, lay, info, opts) {
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${lay.W}mm" height="${lay.H}mm" viewBox="0 0 ${lay.W} ${lay.H}">`);
  out.push(`<rect x="0" y="0" width="${lay.W}" height="${lay.H}" fill="#fff"/>`);
  if (opts.background) {
    const bb = opts.background.box; // [x, y, w, h] in mm
    out.push(`<image x="${f2(bb[0])}" y="${f2(bb[1])}" width="${f2(bb[2])}" height="${f2(bb[3])}" opacity="0.55" preserveAspectRatio="none" xlink:href="${opts.background.dataUrl}"/>`);
  }
  let i = 0;
  const path = (poly, close) => `M${poly.map((p) => lay.map(p).map(f2).join(' ')).join('L')}${close ? 'Z' : ''}`;
  for (const [cls, L] of section.layers) {
    if (isModelColors(opts)) {
      // model colours: one path per colour, filled with the element colour and a darker outline
      out.push(`<g id="${escXml(cls)}" stroke-width="0.35" stroke-linejoin="round" stroke-linecap="round">`);
      for (const [hex, g] of groupByColor(L, opts.colors)) {
        if (g.loops.length) out.push(`<path d="${g.loops.map((l) => path(l, true)).join('')}" stroke="${outline(hex)}" fill="${opts.fill ? hex : 'none'}" fill-rule="evenodd"/>`);
        if (g.open.length) out.push(`<path d="${g.open.map((l) => path(l, false)).join('')}" stroke="${outline(hex)}" fill="none"/>`);
      }
      out.push('</g>');
      continue;
    }
    const col = opts.mono ? '#000' : classColor(cls, i++);
    out.push(`<g id="${escXml(cls)}" stroke="${col}" stroke-width="0.35" stroke-linejoin="round" stroke-linecap="round">`);
    if (L.loops.length) out.push(`<path d="${L.loops.map((l) => path(l, true)).join('')}" fill="${opts.fill ? (opts.mono ? '#d0d0d0' : tint(col, 0.75)) : 'none'}" fill-rule="evenodd"/>`);
    if (L.open.length) out.push(`<path d="${L.open.map((l) => path(l, false)).join('')}" fill="none"/>`);
    out.push('</g>');
  }
  out.push(marksSvg(section, lay));
  // frame, title and scale bar
  const m = lay.margin;
  out.push(`<rect x="${m / 2}" y="${m / 2}" width="${lay.W - m}" height="${lay.H - m}" fill="none" stroke="#000" stroke-width="0.5"/>`);
  const ty = lay.H - m / 2 - lay.title;
  out.push(`<line x1="${m / 2}" y1="${ty}" x2="${lay.W - m / 2}" y2="${ty}" stroke="#000" stroke-width="0.35"/>`);
  out.push(`<g font-family="Helvetica, Arial, sans-serif" fill="#000">${titleLines(info, lay, opts).map((l) => `<text x="${m}" y="${f2(ty + l.y)}" font-size="${l.size}"${l.bold ? ' font-weight="bold"' : ''}>${escXml(l.text)}</text>`).join('')}</g>`);
  const tm = titleMark(info, lay, opts);
  out.push(`<g><path d="M${tm.line.map((p) => p.map(f2).join(' ')).join('L')}" fill="none" stroke="#0C2A30" stroke-width="${f2(tm.w)}" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${f2(tm.dot[0])}" cy="${f2(tm.dot[1])}" r="${f2(tm.dot[2])}" fill="#0E8C84"/></g>`);
  out.push(scaleBarSvg(lay, ty));
  out.push(legendSvg(section, lay, ty, opts));
  out.push('</svg>');
  return out.join('\n');
}

function niceBar(lay) {
  const target = (60 * lay.scale) / 1000; // metres for ~60 mm on paper
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return steps.find((s) => s * 4 >= target) || 1000;
}

function scaleBarSvg(lay, ty) {
  const step = niceBar(lay);
  const segMm = (step * 1000) / lay.scale;
  const x0 = lay.W - lay.margin - 4 * segMm - 10, y = ty + 9;
  let s = '<g font-family="Helvetica, Arial, sans-serif" font-size="2.5">';
  for (let k = 0; k < 4; k++) s += `<rect x="${f2(x0 + k * segMm)}" y="${y}" width="${f2(segMm)}" height="2" fill="${k % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.2"/>`;
  for (let k = 0; k <= 4; k++) s += `<text x="${f2(x0 + k * segMm)}" y="${y + 6}" text-anchor="middle">${+(k * step).toFixed(2)}</text>`;
  s += `<text x="${f2(x0 + 4 * segMm + 3)}" y="${y + 2}">m</text></g>`;
  return s;
}

function legendSvg(section, lay, ty, opts) {
  if (opts.mono || isModelColors(opts)) return '';
  let s = '<g font-family="Helvetica, Arial, sans-serif" font-size="2.6">';
  let x = lay.W / 2 - 20, y = ty + 5;
  let i = 0;
  for (const [cls] of section.layers) {
    const col = classColor(cls, i++);
    s += `<rect x="${f2(x)}" y="${f2(y - 2)}" width="3" height="2.2" fill="${tint(col, 0.6)}" stroke="${col}" stroke-width="0.3"/><text x="${f2(x + 4.5)}" y="${f2(y)}">${escXml(cls)}</text>`;
    y += 3.6;
    if (y > ty + lay.title - 2) { y = ty + 5; x += 42; }
    if (x > lay.W - 110) break;
  }
  return `${s}</g>`;
}

/** Minimal PDF 1.4 with vector paths, Helvetica text and an optional JPEG background. */
export function toPdf(section, lay, info, opts) {
  return toPdfPages([{ section, lay, info, opts }]);
}

/** Several drawings in one PDF, one page each: pages [{section, lay, info, opts}]. */
export function toPdfPages(pages) {
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(null); // pages, filled in below
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pg of pages) {
    const { content, W, Hpt, img } = pdfPage(pg.section, pg.lay, pg.info, pg.opts);
    const pageNo = objs.length + 1;
    kids.push(`${pageNo} 0 R`);
    const imgNo = pageNo + 2;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hpt.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${img ? ` /XObject << /Im1 ${imgNo} 0 R >> /ExtGState << /GS1 << /ca 0.55 >> >>` : ''} >> /Contents ${pageNo + 1} 0 R >>`);
    objs.push({ dict: `<< /Length ${latin1Length(content)} >>`, stream: content });
    if (img) objs.push({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`, bin: img.bytes });
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  return pdfBytes(objs, pages[0]?.info?.title);
}

function pdfPage(section, lay, info, opts) {
  const k = 72 / 25.4; // mm -> pt
  const Hpt = lay.H * k;
  const P = (x, y) => `${(x * k).toFixed(2)} ${(Hpt - y * k).toFixed(2)}`;
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return `${(((n >> 16) & 255) / 255).toFixed(3)} ${(((n >> 8) & 255) / 255).toFixed(3)} ${((n & 255) / 255).toFixed(3)}`; };
  const c = [];
  c.push('1 J 1 j');
  if (opts.background?.jpeg) {
    const [bx, by, bw, bh] = opts.background.box;
    c.push(`q /GS1 gs ${(bw * k).toFixed(2)} 0 0 ${(bh * k).toFixed(2)} ${(bx * k).toFixed(2)} ${(Hpt - (by + bh) * k).toFixed(2)} cm /Im1 Do Q`);
  }
  let i = 0;
  for (const [cls, L] of section.layers) {
    if (isModelColors(opts)) {
      c.push(`${(0.35 * k).toFixed(3)} w`);
      for (const [hex, g] of groupByColor(L, opts.colors)) {
        c.push(`${rgb(outline(hex))} RG ${rgb(hex)} rg`);
        for (const l of g.loops) {
          const pts = l.map((p) => lay.map(p));
          c.push(`${P(...pts[0])} m ${pts.slice(1).map((p) => `${P(...p)} l`).join(' ')} h ${opts.fill ? 'B*' : 'S'}`);
        }
        for (const l of g.open) {
          const pts = l.map((p) => lay.map(p));
          c.push(`${P(...pts[0])} m ${pts.slice(1).map((p) => `${P(...p)} l`).join(' ')} S`);
        }
      }
      continue;
    }
    const col = opts.mono ? '#000000' : classColor(cls, i++);
    const fillCol = opts.mono ? '#d0d0d0' : tint(col, 0.75);
    c.push(`${rgb(col)} RG ${rgb(fillCol)} rg ${(0.35 * k).toFixed(3)} w`);
    for (const l of L.loops) {
      const pts = l.map((p) => lay.map(p));
      c.push(`${P(...pts[0])} m ${pts.slice(1).map((p) => `${P(...p)} l`).join(' ')} h ${opts.fill ? 'B*' : 'S'}`);
    }
    for (const l of L.open) {
      const pts = l.map((p) => lay.map(p));
      c.push(`${P(...pts[0])} m ${pts.slice(1).map((p) => `${P(...p)} l`).join(' ')} S`);
    }
  }
  c.push(...marksPdf(section, lay, P, k, rgb));
  const m = lay.margin;
  const ty = lay.H - m / 2 - lay.title;
  c.push(`0 0 0 RG ${(0.5 * k).toFixed(3)} w ${P(m / 2, lay.H - m / 2)} ${((lay.W - m) * k).toFixed(2)} ${((lay.H - m) * k).toFixed(2)} re S`);
  c.push(`${(0.35 * k).toFixed(3)} w ${P(m / 2, ty)} m ${P(lay.W - m / 2, ty)} l S`);
  const text = (x, y, size, s, bold = false) => `BT /${bold ? 'F2' : 'F1'} ${(size * k).toFixed(2)} Tf ${P(x, y)} Td (${pdfStr(s)}) Tj ET`;
  // the PDF has no class legend, so the title may use the space up to the scale bar
  c.push('0 0 0 rg', ...titleLines(info, lay, { ...opts, legend: false }).map((l) => text(m, ty + l.y, l.size, l.text, l.bold)));
  // the mark after the last title line: the profile and its point (circle from four Béziers)
  const tm = titleMark(info, lay, { ...opts, legend: false });
  c.push(`q 0.047 0.165 0.188 RG ${(tm.w * k).toFixed(3)} w 1 J 1 j ${P(...tm.line[0])} m ${tm.line.slice(1).map((q) => `${P(...q)} l`).join(' ')} S Q`);
  {
    const [cx, cy, r] = tm.dot, q = 0.5523 * r;
    c.push(`q 0.055 0.549 0.518 rg ${P(cx + r, cy)} m ${P(cx + r, cy - q)} ${P(cx + q, cy - r)} ${P(cx, cy - r)} c ${P(cx - q, cy - r)} ${P(cx - r, cy - q)} ${P(cx - r, cy)} c ${P(cx - r, cy + q)} ${P(cx - q, cy + r)} ${P(cx, cy + r)} c ${P(cx + q, cy + r)} ${P(cx + r, cy + q)} ${P(cx + r, cy)} c f Q`);
  }
  // scale bar
  const step = niceBar(lay);
  const segMm = (step * 1000) / lay.scale;
  const x0 = lay.W - lay.margin - 4 * segMm - 10, y = ty + 9;
  for (let q = 0; q < 4; q++) c.push(`${q % 2 ? '1 1 1' : '0 0 0'} rg ${(0.2 * k).toFixed(3)} w ${P(x0 + q * segMm, y + 2)} ${(segMm * k).toFixed(2)} ${(2 * k).toFixed(2)} re B`);
  c.push('0 0 0 rg');
  for (let q = 0; q <= 4; q++) c.push(text(x0 + q * segMm - 1, y + 6, 2.5, `${+(q * step).toFixed(2)}`));
  c.push(text(x0 + 4 * segMm + 3, y + 2, 2.5, 'm'));
  const content = c.join('\n');
  return { content, W: (lay.W * k).toFixed(2), Hpt, img: opts.background?.jpeg || null };
}

function pdfBytes(objs, title) {
  const parts = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? latin1(x) : x; parts.push(b); len += b.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  objs.forEach((o, idx) => {
    offsets.push(len);
    if (typeof o === 'string') push(`${idx + 1} 0 obj\n${o}\nendobj\n`);
    else {
      push(`${idx + 1} 0 obj\n${o.dict}\nstream\n`);
      push(o.bin || o.stream);
      push('\nendstream\nendobj\n');
    }
  });
  const xref = len;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Producer (OnlineIFC) /Title (${pdfStr(String(title ?? '').replace(/[–—]/g, '-').replace(/[^\x20-\xff]/g, '?'))}) >> >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const WIN = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159 };
function pdfStr(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    let code = WIN[ch] ?? ch.charCodeAt(0);
    if (code > 255) code = 63; // '?'
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return out;
}
function latin1(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
const latin1Length = (s) => s.length;

/** DXF (R12, ASCII) with one layer per IFC class. Coordinates in metres. */
export function toDxf(section, info) {
  const L = [];
  const g = (code, val) => { L.push(String(code), String(val)); };
  const layerName = (cls) => cls.replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
  const aci = [1, 5, 3, 6, 30, 4, 140, 40, 160, 210];
  const dxfMarks = allMarks(section, null);
  const markLayers = [...new Set(dxfMarks.map((mk) => mk.layer || 'ANNOTATION'))];
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$EXTMIN'); g(10, section.bounds.minX); g(20, section.bounds.minY);
  g(9, '$EXTMAX'); g(10, section.bounds.maxX); g(20, section.bounds.maxY);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, section.layers.size + 1 + markLayers.length);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
  for (const ml of markLayers) { g(0, 'LAYER'); g(2, ml); g(70, 0); g(62, 1); g(6, 'CONTINUOUS'); }
  let i = 0;
  for (const [cls] of section.layers) { g(0, 'LAYER'); g(2, layerName(cls)); g(70, 0); g(62, aci[i++ % aci.length]); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const poly = (layer, pts, closed) => {
    g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, closed ? 1 : 0);
    for (const p of pts) { g(0, 'VERTEX'); g(8, layer); g(10, p[0].toFixed(5)); g(20, p[1].toFixed(5)); g(30, 0); }
    g(0, 'SEQEND'); g(8, layer);
  };
  for (const [cls, layer] of section.layers) {
    const ln = layerName(cls);
    for (const l of layer.loops) poly(ln, l, true);
    for (const l of layer.open) poly(ln, l, false);
  }
  const ascii = (x) => String(x).replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '?');
  for (const mk of dxfMarks) {
    const ln = mk.layer || 'ANNOTATION';
    if (mk.line) poly(ln, mk.line, !!mk.closed);
    else if (mk.arrow) {
      // the arrow in drawing units: about 1 % of the drawing width
      const b = section.bounds, sz = (mk.size ?? 5) * Math.max(b.maxX - b.minX, b.maxY - b.minY) / 300;
      const [vx, vy] = mk.dir, L = Math.hypot(vx, vy) || 1, ux = vx / L, uy = vy / L;
      const tip = [mk.arrow[0] + ux * sz, mk.arrow[1] + uy * sz], base = [mk.arrow[0] + ux * sz * 0.55, mk.arrow[1] + uy * sz * 0.55];
      poly(ln, [mk.arrow, base], false);
      poly(ln, [tip, [base[0] - uy * sz * 0.28, base[1] + ux * sz * 0.28], [base[0] + uy * sz * 0.28, base[1] - ux * sz * 0.28]], true);
    } else if (mk.text !== undefined) {
      const b = section.bounds, h = mk.dxfH ?? ((mk.size ?? 3) * Math.max(b.maxX - b.minX, b.maxY - b.minY)) / 300;
      g(0, 'TEXT'); g(8, ln); g(10, mk.at[0]); g(20, mk.at[1]); g(40, h.toFixed(4));
      if (mk.rot) g(50, mk.rot.toFixed(2));
      if (mk.anchor === 'middle' || mk.anchor === 'end') { g(72, mk.anchor === 'middle' ? 1 : 2); g(11, mk.at[0]); g(21, mk.at[1]); }
      g(1, ascii(mk.text));
    }
  }
  g(0, 'TEXT'); g(8, '0'); g(10, section.bounds.minX); g(20, section.bounds.minY - 1); g(40, 0.25); g(1, `${info.title} - ${info.subtitle}`.replace(/[^\x20-\x7E]/g, '?'));
  g(0, 'ENDSEC'); g(0, 'EOF');
  return L.join('\r\n');
}

/**
 * Renders the view behind the cut as an image for the drawing background.
 * Returns {dataUrl, jpeg: {bytes, width, height}, box: [x, y, w, h] mm} or null.
 */
export function renderBackground(viewer, section, lay) {
  const ax = section.axes;
  const b = section.bounds;
  if (!Number.isFinite(b.minX)) return null;
  // corners of the drawing area in world coordinates
  const pxPerMm = 6;
  const [x0, y0] = lay.map([b.minX, b.maxY]);
  const [x1, y1] = lay.map([b.maxX, b.minY]);
  const wMm = x1 - x0, hMm = y1 - y0;
  const w = Math.min(4096, Math.max(64, Math.round(wMm * pxPerMm))), hgt = Math.min(4096, Math.max(64, Math.round(hMm * pxPerMm)));
  const wM = b.maxX - b.minX, hM = b.maxY - b.minY;
  // centre of the drawing in world coordinates
  let center;
  if (ax.horizontal) {
    const c2 = viewer.fromIfc((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0);
    center = ax.origin.clone().add(c2.clone().sub(ax.origin).projectOnPlane(ax.n));
  } else {
    const ref = viewer.fromIfc(0, 0, (b.minY + b.maxY) / 2);
    center = ax.origin.clone().addScaledVector(ax.right, (b.minX + b.maxX) / 2);
    center.add(ax.up.clone().multiplyScalar(ref.clone().sub(center).dot(ax.up)));
  }
  const cam = new THREE.OrthographicCamera(-wM / 2, wM / 2, hM / 2, -hM / 2, 0.01, viewer.sceneRadius * 8 + 100);
  cam.position.copy(center).addScaledVector(ax.n, -0.001);
  cam.up.copy(ax.up);
  cam.lookAt(center.clone().add(ax.n));
  cam.updateMatrixWorld();
  const r = viewer.renderer;
  const target = new THREE.WebGLRenderTarget(w, hgt, { samples: 4 });
  const prevClear = r.getClearAlpha();
  const prevColor = r.getClearColor(new THREE.Color());
  r.setClearColor(0xffffff, 1);
  r.setRenderTarget(target);
  r.render(viewer.scene, cam);
  const px = new Uint8Array(w * hgt * 4);
  r.readRenderTargetPixels(target, 0, 0, w, hgt, px);
  r.setRenderTarget(null);
  r.setClearColor(prevColor, prevClear);
  target.dispose();
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(w, hgt);
  for (let yy = 0; yy < hgt; yy++) imgData.data.set(px.subarray((hgt - 1 - yy) * w * 4, (hgt - yy) * w * 4), yy * w * 4);
  ctx.putImageData(imgData, 0, 0);
  const jpgUrl = canvas.toDataURL('image/jpeg', 0.85);
  const bin = atob(jpgUrl.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let q = 0; q < bin.length; q++) bytes[q] = bin.charCodeAt(q);
  return { dataUrl: canvas.toDataURL('image/png'), jpeg: { bytes, width: w, height: hgt }, box: [x0, y0, wMm, hMm] };
}

/**
 * Paths of a section for a live view, in drawing metres with y up (the caller flips y):
 * [{d, fill, stroke}] grouped by colour. opts like the writers ({colors, fill, mono}).
 */
export function sectionPaths(section, opts = { colors: 'shown', fill: true }) {
  const out = [];
  const path = (poly, close) => `M${poly.map((p) => `${p[0].toFixed(4)} ${(-p[1]).toFixed(4)}`).join('L')}${close ? 'Z' : ''}`;
  let i = 0;
  for (const [cls, L] of section.layers) {
    if (isModelColors(opts)) {
      for (const [hex, g] of groupByColor(L, opts.colors)) {
        if (g.loops.length) out.push({ d: g.loops.map((l) => path(l, true)).join(''), fill: opts.fill ? hex : 'none', stroke: outline(hex) });
        if (g.open.length) out.push({ d: g.open.map((l) => path(l, false)).join(''), fill: 'none', stroke: outline(hex) });
      }
      continue;
    }
    const col = opts.mono ? '#000000' : classColor(cls, i++);
    if (L.loops?.length) out.push({ d: L.loops.map((l) => path(l, true)).join(''), fill: opts.fill ? (opts.mono ? '#d0d0d0' : tint(col, 0.75)) : 'none', stroke: col });
    if (L.open?.length) out.push({ d: L.open.map((l) => path(l, false)).join(''), fill: 'none', stroke: col });
  }
  return out;
}
