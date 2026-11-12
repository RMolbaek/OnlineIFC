// Comparing two versions of a model: elements are matched by GlobalId and classified as
// added, removed, changed (properties and/or geometry) or unchanged.
import * as THREE from 'three';
import { t, fmtNum } from './i18n.js';
import { keyLabel } from './filters.js';
import { fmtValue } from './ifc.js';

export const CMP_COLORS = { added: 0x2fb344, removed: 0xe03131, changed: 0xf59f00, unchanged: 0xc8ccd2 };
const MOVE_TOL = 0.002; // metres
const REL_TOL = 0.002; // relative change of volume/area that counts as changed geometry

/** GlobalId -> expressID for all elements with geometry and all objects in the spatial tree. */
function guidMap(model) {
  const map = new Map();
  const ids = new Set([...model.elementIds, ...model.parent.keys()]);
  for (const id of ids) {
    const g = fmtValue(model.api.GetLine(model.modelID, id, false)?.GlobalId);
    if (g) map.set(g, id);
  }
  return map;
}

function centroidWorld(model, q) {
  model.group.updateMatrixWorld(true);
  return new THREE.Vector3(q.cx, q.cz, -q.cy).applyMatrix4(model.group.matrixWorld);
}

/** Attributes for objects that are not in the property index (no geometry). */
function basicAttrs(model, id) {
  const line = model.api.GetLine(model.modelID, id, false);
  const o = { 'attr:Class': model.typeName(id) };
  for (const k of ['Name', 'ObjectType', 'Tag', 'Description', 'LongName']) {
    const v = fmtValue(line?.[k]);
    if (v) o[`attr:${k}`] = v;
  }
  return o;
}

const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
};

/**
 * Compares two models (old -> new). Both property indexes must be built.
 * Returns {added: [idNew], removed: [idOld], changed: [{a, b, diffs, geom}], unchanged: [{a, b}]}.
 */
export async function compareModels(oldM, newM, onProgress = () => {}) {
  const ga = guidMap(oldM), gb = guidMap(newM);
  const res = { oldM, newM, added: [], removed: [], changed: [], unchanged: [] };
  let i = 0;
  const total = gb.size;
  for (const [guid, idB] of gb) {
    const idA = ga.get(guid);
    if (idA === undefined) { res.added.push(idB); continue; }
    const oa = oldM._pindex.data.get(idA) || basicAttrs(oldM, idA), ob = newM._pindex.data.get(idB) || basicAttrs(newM, idB);
    const diffs = [];
    for (const k of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
      if (k === 'attr:Model' || k.startsWith('calc:')) continue;
      if (!same(oa[k], ob[k])) diffs.push({ key: k, a: oa[k], b: ob[k] });
    }
    const qa = oldM.computeQuantities(idA), qb = newM.computeQuantities(idB);
    const geom = {};
    if (qa && qb) {
      const rel = (x, y) => Math.abs(x - y) > REL_TOL * Math.max(Math.abs(x), Math.abs(y), 1e-6);
      if (rel(qa.volume, qb.volume)) geom.volume = [qa.volume, qb.volume];
      if (rel(qa.area, qb.area)) geom.area = [qa.area, qb.area];
      const d = centroidWorld(oldM, qa).distanceTo(centroidWorld(newM, qb));
      if (d > MOVE_TOL) geom.moved = d;
    } else if (!!qa !== !!qb) geom.shape = true;
    if (diffs.length || Object.keys(geom).length) res.changed.push({ a: idA, b: idB, diffs, geom });
    else res.unchanged.push({ a: idA, b: idB });
    if (++i % 300 === 0) { onProgress(i / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  for (const [guid, idA] of ga) if (!gb.has(guid)) res.removed.push(idA);
  return res;
}

/** Colours the result in the 3D view. The old model only shows removed elements. */
export function showComparison(res, { showUnchanged = true } = {}) {
  const { oldM, newM } = res;
  const cb = new Map();
  for (const id of res.added) cb.set(id, CMP_COLORS.added);
  for (const c of res.changed) cb.set(c.b, CMP_COLORS.changed);
  const unchanged = res.unchanged.map((u) => u.b);
  if (showUnchanged) for (const id of unchanged) cb.set(id, CMP_COLORS.unchanged); // neutral grey, so only changes stand out
  newM.setElementColors(cb);
  newM.resetElementOpacity();
  if (showUnchanged) newM.setElementOpacity(unchanged, 0.2);
  else newM.hide(unchanged);
  oldM.setVisible(true);
  oldM.isolate(res.removed);
  oldM.setElementColors(new Map(res.removed.map((id) => [id, CMP_COLORS.removed])));
}

export function clearComparison(res) {
  for (const m of [res.oldM, res.newM]) {
    m.resetElementColors();
    m.resetElementOpacity();
    m.showAll();
  }
}

/** Human readable description of a geometry change. */
export function geomText(geom) {
  const f = (v, d = 3) => v.toLocaleString(undefined, { maximumFractionDigits: d });
  const out = [];
  if (geom.volume) out.push([t('q.volume'), `${f(geom.volume[0])} → ${f(geom.volume[1])} m³`]);
  if (geom.area) out.push([t('q.area'), `${f(geom.area[0], 2)} → ${f(geom.area[1], 2)} m²`]);
  if (geom.moved) out.push([t('cmp.moved'), `${f(geom.moved)} m`]);
  if (geom.shape) out.push([t('cmp.geometry'), t('cmp.shapeChanged')]);
  return out;
}

const fv = (v) => (v === undefined ? '—' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v));

/** CSV report (semicolon separated) of all differences. */
export function comparisonCsv(res) {
  const { oldM, newM } = res;
  const rows = [[t('cmp.status'), 'GlobalId', t('csv.class'), t('csv.name'), t('cmp.what'), t('cmp.old'), t('cmp.new')]];
  const info = (m, id) => {
    const line = m.api.GetLine(m.modelID, id, false);
    return [fmtValue(line?.GlobalId), m.typeName(id), fmtValue(line?.Name)];
  };
  for (const id of res.added) rows.push([t('cmp.added'), ...info(newM, id), '', '', '']);
  for (const id of res.removed) rows.push([t('cmp.removed'), ...info(oldM, id), '', '', '']);
  for (const c of res.changed) {
    const base = info(newM, c.b);
    for (const d of c.diffs) rows.push([t('cmp.changed'), ...base, keyLabel(d.key), fv(d.a), fv(d.b)]);
    for (const [k, v] of geomText(c.geom)) rows.push([t('cmp.changed'), ...base, k, ...(v.includes('→') ? v.split(' → ') : ['', v])]);
  }
  const esc = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
}

export function summaryText(res) {
  return t('cmp.summary', {
    added: fmtNum(res.added.length), removed: fmtNum(res.removed.length),
    changed: fmtNum(res.changed.length), unchanged: fmtNum(res.unchanged.length),
  });
}
