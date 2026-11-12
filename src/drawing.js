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
  return { n, up, right, horizontal, origin: entry.plane.coplanarPoint(new THREE.Vector3()) };
}

/**
 * Cuts all visible elements with the plane. Returns {layers: Map(class -> {segments, loops, open}), bounds}.
 * Coordinates are 2D in metres: plan sections use real IFC X/Y, vertical sections use
 * (distance along the section, IFC Z).
 */
export function computeSection(viewer, entry) {
  const ax = planeAxes(entry);
  const plane = entry.plane.clone();
  plane.constant += 1e-7; // avoid vertices exactly on the plane
  const others = viewer.planes.filter((p) => p.enabled && p !== entry).map((p) => p.plane);
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
  return { layers, bounds, axes: ax };
}

/** Joins segments into closed loops and open polylines (endpoints matched within 0.1 mm). */
function stitch(segs) {
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
  let [W, H] = opts.paper === 'auto' ? [0, 0] : PAPERS[opts.paper] || PAPERS.A3;
  let scale = opts.scale;
  if (scale === 'fit') {
    if (!W) [W, H] = PAPERS.A3;
    const s = Math.max((wM * 1000) / (W - 2 * margin), (hM * 1000) / (H - 2 * margin - title));
    scale = SCALES.find((x) => x >= s) || Math.ceil(s / 1000) * 1000;
  }
  const dw = (wM * 1000) / scale, dh = (hM * 1000) / scale;
  if (!W) { W = Math.ceil(dw + 2 * margin); H = Math.ceil(dh + 2 * margin + title); }
  const ox = (W - dw) / 2, oy = margin + (H - 2 * margin - title - dh) / 2;
  return {
    W, H, scale, margin, title,
    // metres -> paper mm (y down)
    map: (p) => [ox + ((p[0] - b.minX) * 1000) / scale, oy + ((b.maxY - p[1]) * 1000) / scale],
    fits: dw <= W - 2 * margin + 0.01 && dh <= H - 2 * margin - title + 0.01,
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

function titleLines(info, lay) {
  return [info.title, `${info.subtitle}`, `1:${lay.scale}  ·  ${info.date}  ·  OnlineIFC`];
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
  // frame, title and scale bar
  const m = lay.margin;
  out.push(`<rect x="${m / 2}" y="${m / 2}" width="${lay.W - m}" height="${lay.H - m}" fill="none" stroke="#000" stroke-width="0.5"/>`);
  const [l1, l2, l3] = titleLines(info, lay);
  const ty = lay.H - m / 2 - lay.title;
  out.push(`<line x1="${m / 2}" y1="${ty}" x2="${lay.W - m / 2}" y2="${ty}" stroke="#000" stroke-width="0.35"/>`);
  out.push(`<g font-family="Helvetica, Arial, sans-serif" fill="#000"><text x="${m}" y="${ty + 7}" font-size="5" font-weight="bold">${escXml(l1)}</text><text x="${m}" y="${ty + 13}" font-size="3.5">${escXml(l2)}</text><text x="${m}" y="${ty + 18.5}" font-size="3">${escXml(l3)}</text></g>`);
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
  const m = lay.margin;
  const ty = lay.H - m / 2 - lay.title;
  c.push(`0 0 0 RG ${(0.5 * k).toFixed(3)} w ${P(m / 2, lay.H - m / 2)} ${((lay.W - m) * k).toFixed(2)} ${((lay.H - m) * k).toFixed(2)} re S`);
  c.push(`${(0.35 * k).toFixed(3)} w ${P(m / 2, ty)} m ${P(lay.W - m / 2, ty)} l S`);
  const [l1, l2, l3] = titleLines(info, lay);
  const text = (x, y, size, s, bold = false) => `BT /${bold ? 'F2' : 'F1'} ${(size * k).toFixed(2)} Tf ${P(x, y)} Td (${pdfStr(s)}) Tj ET`;
  c.push('0 0 0 rg', text(m, ty + 7, 5, l1, true), text(m, ty + 13, 3.5, l2), text(m, ty + 18.5, 3, l3));
  // scale bar
  const step = niceBar(lay);
  const segMm = (step * 1000) / lay.scale;
  const x0 = lay.W - lay.margin - 4 * segMm - 10, y = ty + 9;
  for (let q = 0; q < 4; q++) c.push(`${q % 2 ? '1 1 1' : '0 0 0'} rg ${(0.2 * k).toFixed(3)} w ${P(x0 + q * segMm, y + 2)} ${(segMm * k).toFixed(2)} ${(2 * k).toFixed(2)} re B`);
  c.push('0 0 0 rg');
  for (let q = 0; q <= 4; q++) c.push(text(x0 + q * segMm - 1, y + 6, 2.5, `${+(q * step).toFixed(2)}`));
  c.push(text(x0 + 4 * segMm + 3, y + 2, 2.5, 'm'));
  const content = c.join('\n');

  const objs = [];
  const W = (lay.W * k).toFixed(2);
  const img = opts.background?.jpeg;
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hpt.toFixed(2)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >>${img ? ' /XObject << /Im1 7 0 R >> /ExtGState << /GS1 << /ca 0.55 >> >>' : ''} >> /Contents 6 0 R >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  objs.push({ dict: `<< /Length ${latin1Length(content)} >>`, stream: content });
  if (img) objs.push({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>`, bin: img.bytes });

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
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Producer (OnlineIFC) /Title (${pdfStr(String(info.title).replace(/[–—]/g, '-').replace(/[^\x20-\xff]/g, '?'))}) >> >>\nstartxref\n${xref}\n%%EOF\n`);
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
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$EXTMIN'); g(10, section.bounds.minX); g(20, section.bounds.minY);
  g(9, '$EXTMAX'); g(10, section.bounds.maxX); g(20, section.bounds.maxY);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, section.layers.size + 1);
  g(0, 'LAYER'); g(2, '0'); g(70, 0); g(62, 7); g(6, 'CONTINUOUS');
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
