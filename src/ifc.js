// Loading IFC files with web-ifc and formatting of IFC values.
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import * as THREE from 'three';
import { IfcModel } from './model.js';
import { t } from './i18n.js';

let apiPromise = null;

/** Returnerer en initialiseret (delt) web-ifc API. */
export function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const api = new WebIFC.IfcAPI();
      // Single-thread: kræver ikke COOP/COEP-headere, så det virker på enhver statisk host.
      await api.Init(() => wasmUrl, true);
      api.SetLogLevel?.(WebIFC.LogLevel.LOG_LEVEL_OFF);
      return api;
    })();
  }
  return apiPromise;
}

// Typekode -> pænt klassenavn (IfcWallStandardCase i stedet for IFCWALLSTANDARDCASE).
const prettyNames = new Map();
for (const ns of [WebIFC.IFC2X3, WebIFC.IFC4, WebIFC.IFC4X3]) {
  if (!ns) continue;
  for (const key of Object.keys(ns)) {
    if (key.startsWith('Ifc')) prettyNames.set(key.toUpperCase(), key);
  }
}

export function prettyTypeName(api, typeCode) {
  const raw = api.GetNameFromTypeCode(typeCode) || String(typeCode);
  return prettyNames.get(String(raw).toUpperCase()) || raw;
}

export function prettyRawName(raw) {
  if (!raw) return '';
  return prettyNames.get(String(raw).toUpperCase()) || raw;
}

/**
 * Læser en IFC-fil og bygger et IfcModel med sammenflettet geometri.
 * @param {File|{name:string, data:Uint8Array}} file  a File or raw bytes with a name
 * @param {{ referenceMatrix?: THREE.Matrix4|null, onProgress?: (msg:string, frac:number)=>void }} opts
 */
export async function loadIfcFile(file, opts = {}) {
  const { onProgress = () => {} } = opts;
  const api = await getApi();

  const name = file.name;
  onProgress(t('load.reading', { name }), 0.05);
  // The source is kept as a File/Blob (read again only when needed), not as bytes in memory.
  const src = file.data ?? file; // {name, data: Uint8Array | Blob} or a File
  const sourceBlob = src instanceof Uint8Array ? new Blob([src]) : src;
  let data = src instanceof Uint8Array ? src : new Uint8Array(await src.arrayBuffer());
  const fileSize = data.byteLength;
  await nextFrame();

  onProgress(t('load.parsing', { name }), 0.15);
  await nextFrame();
  // MEMORY_LIMIT: web-ifc's default is 2 GB; large models (300 MB+ files) need more. 32-bit wasm allows up to 4 GB.
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 16, MEMORY_LIMIT: 3.5 * 1024 ** 3 });
  data = null; // web-ifc has its own copy now
  if (modelID < 0) throw new Error(t('err.notIfc'));

  const schema = api.GetModelSchema(modelID);

  onProgress(t('load.geometry', { name }), 0.3);
  await nextFrame();

  // Grupper alle trekanter efter farve, så hver model kun bliver få draw calls.
  const buckets = new Map();
  const spaceIds = new Set();
  // Many elements share the same geometry (type geometry / mapped items): read it once.
  const geomCache = new Map();
  let cacheBytes = 0;
  const CACHE_BUDGET = 192 * 1024 * 1024;
  const readGeometry = (gid) => {
    let g = geomCache.get(gid);
    if (!g) {
      const geom = api.GetGeometry(modelID, gid);
      g = {
        verts: api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()).slice(),
        idx: api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize()).slice(),
      };
      geom.delete();
      // keep small geometries (bolts, sleepers, windows …) which are usually repeated; within a budget
      const bytes = g.verts.byteLength + g.idx.byteLength;
      if (bytes < 512 * 1024 && cacheBytes + bytes < CACHE_BUDGET) { geomCache.set(gid, g); cacheBytes += bytes; }
    }
    return g;
  };

  const onMesh = (flatMesh, prefix) => {
    const expressID = flatMesh.expressID;
    if (prefix) spaceIds.add(expressID);
    const n = flatMesh.geometries.size();
    for (let i = 0; i < n; i++) {
      const pg = flatMesh.geometries.get(i);
      const { verts, idx } = readGeometry(pg.geometryExpressID);
      if (verts.length === 0 || idx.length === 0) continue;

      const c = pg.color;
      const key = `${prefix}${c.x.toFixed(3)}_${c.y.toFixed(3)}_${c.z.toFixed(3)}_${c.w.toFixed(3)}`;
      let b = buckets.get(key);
      if (!b) {
        // Spaces (IfcSpace) are semi-transparent so they don't hide the building.
        const opacity = prefix ? Math.min(c.w, 0.25) : c.w;
        b = { color: new THREE.Color(c.x, c.y, c.z), opacity, pos: [], nor: [], idx: [], items: [], vCount: 0, iCount: 0 };
        buckets.set(key, b);
      }

      // Transform positions and normals (column-major 4×4 matrix; normals with the inverse transpose)
      const m = pg.flatTransformation;
      const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9], m10 = m[10], m12 = m[12], m13 = m[13], m14 = m[14];
      // inverse transpose of the 3×3 part
      const det = m0 * (m5 * m10 - m9 * m6) - m4 * (m1 * m10 - m9 * m2) + m8 * (m1 * m6 - m5 * m2) || 1;
      const n0 = (m5 * m10 - m9 * m6) / det, n1 = (m9 * m2 - m1 * m10) / det, n2 = (m1 * m6 - m5 * m2) / det;
      const n3 = (m8 * m6 - m4 * m10) / det, n4 = (m0 * m10 - m8 * m2) / det, n5 = (m4 * m2 - m0 * m6) / det;
      const n6 = (m4 * m9 - m8 * m5) / det, n7 = (m8 * m1 - m0 * m9) / det, n8 = (m0 * m5 - m4 * m1) / det;
      const vc = verts.length / 6;
      const pos = new Float32Array(vc * 3);
      const nor = new Int8Array(vc * 3); // normalized normals: 3 bytes per vertex instead of 12
      for (let k = 0, o = 0, q = 0; k < vc; k++, o += 6, q += 3) {
        const x = verts[o], y = verts[o + 1], z = verts[o + 2];
        pos[q] = m0 * x + m4 * y + m8 * z + m12;
        pos[q + 1] = m1 * x + m5 * y + m9 * z + m13;
        pos[q + 2] = m2 * x + m6 * y + m10 * z + m14;
        const a = verts[o + 3], bb = verts[o + 4], cc = verts[o + 5];
        let nx = n0 * a + n1 * bb + n2 * cc, ny = n3 * a + n4 * bb + n5 * cc, nz = n6 * a + n7 * bb + n8 * cc;
        const l = Math.hypot(nx, ny, nz) || 1;
        nor[q] = Math.round((nx / l) * 127); nor[q + 1] = Math.round((ny / l) * 127); nor[q + 2] = Math.round((nz / l) * 127);
      }
      const ind = new Uint32Array(idx.length);
      const off = b.vCount;
      for (let k = 0; k < idx.length; k++) ind[k] = idx[k] + off;

      const last = b.items[b.items.length - 1];
      if (last && last.id === expressID && last.start + last.count === b.iCount) last.count += ind.length;
      else b.items.push({ id: expressID, start: b.iCount, count: ind.length });

      b.pos.push(pos); b.nor.push(nor); b.idx.push(ind);
      b.vCount += vc; b.iCount += ind.length;
    }
  };

  // Stream geometry in batches so the progress bar can update during large models.
  const productIds = listProductIds(api, modelID);
  const BATCH = 1500;
  for (let s0 = 0; s0 < productIds.length; s0 += BATCH) {
    streamMeshes(api, modelID, productIds.slice(s0, s0 + BATCH), (fm) => onMesh(fm, ''));
    onProgress(t('load.geometryN', { name, done: Math.min(s0 + BATCH, productIds.length).toLocaleString(), total: productIds.length.toLocaleString() }),
      0.3 + 0.45 * Math.min(1, (s0 + BATCH) / productIds.length));
    await nextFrame();
  }
  // Spaces are streamed separately (hidden by default).
  try {
    api.StreamAllMeshesWithTypes(modelID, [WebIFC.IFCSPACE], (fm) => onMesh(fm, 'space_'));
  } catch (e) {
    console.warn('Could not read space geometry', e);
  }
  geomCache.clear();

  onProgress(t('load.building', { name }), 0.75);
  await nextFrame();

  const merged = [];
  for (const b of buckets.values()) {
    merged.push({
      color: b.color,
      opacity: b.opacity,
      positions: concat(Float32Array, b.pos, b.vCount * 3),
      normals: concat(Int8Array, b.nor, b.vCount * 3),
      index: concat(Uint32Array, b.idx, b.iCount),
      items: b.items,
    });
    b.pos = b.nor = b.idx = null; // free the chunks of this bucket before merging the next
  }

  const coordMatrix = new THREE.Matrix4().fromArray(api.GetCoordinationMatrix(modelID));

  const model = new IfcModel({ name, api, modelID, buckets: merged, schema, fileSize, coordMatrix, spaceIds, sourceBlob });

  onProgress(t('load.structure', { name }), 0.9);
  await nextFrame();
  await model.loadStructure();

  onProgress(t('load.done'), 1);
  return model;
}

/** expressIDs of all objects that can have geometry (same set as StreamAllMeshes, without spaces). */
const GEOMETRY_TYPES = ['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY',
  'IFCMARINEFACILITY', 'IFCANNOTATION', 'IFCGRID', 'IFCPROXY', 'IFCSPATIALZONE', 'IFCGEOGRAPHICELEMENT', 'IFCALIGNMENT',
  'IFCLINEARPOSITIONINGELEMENT', 'IFCREFERENT', 'IFCEXTERNALSPATIALELEMENT'];
function listProductIds(api, modelID) {
  const skip = new Set([WebIFC.IFCOPENINGELEMENT, WebIFC.IFCOPENINGSTANDARDCASE, WebIFC.IFCSPACE].filter(Boolean));
  const ids = [];
  for (const ty of api.GetIfcEntityList(modelID)) {
    if (skip.has(ty)) continue;
    if (!api.IsIfcElement(ty) && !GEOMETRY_TYPES.includes(String(api.GetNameFromTypeCode(ty)).toUpperCase())) continue;
    const v = api.GetLineIDsWithType(modelID, ty, false);
    for (let i = 0; i < v.size(); i++) ids.push(v.get(i));
  }
  return ids;
}

/**
 * StreamMeshes for a list of expressIDs. The browser build of web-ifc 0.0.78 binds the
 * function with 3 arguments while the JS wrapper passes 4, so fall back to the direct call.
 */
let streamArgs = 4;
function streamMeshes(api, modelID, ids, cb) {
  if (streamArgs === 4) {
    try { api.StreamMeshes(modelID, ids, cb); return; } catch (e) {
      if (!/arguments/i.test(String(e?.message || e))) throw e;
      streamArgs = 3;
    }
  }
  api.wasmModule.StreamMeshes(modelID, ids, cb);
}

function concat(Type, chunks, total) {
  const out = new Type(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Gives the browser a moment to update the progress bar and handle input.
 * Not tied to requestAnimationFrame: that waits for a rendered frame (slow while a large model
 * is already in the scene) and is paused completely in a background tab.
 */
export function nextFrame() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Formattering af IFC-værdier

/** Gør en web-ifc værdi (fx {type:1, value:'Væg'}) læselig. */
export function fmtValue(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.map(fmtValue).filter((s) => s !== '').join(', ');
  if (typeof val === 'object') {
    if ('_representationValue' in val) return fmtValue(val._representationValue);
    if ('value' in val) {
      let x = val.value;
      if (typeof x === 'string') x = decodeIfcString(x);
      if (typeof x === 'number') x = fmtNumber(x);
      if (val.type === 3 || x === 'T' || x === 'F') {
        // ENUM / BOOLEAN
        if (x === 'T' || x === true) return t('val.true');
        if (x === 'F' || x === false) return t('val.false');
        if (x === 'U') return t('val.unknown');
      }
      if (val.type === 5) return `#${x}`; // reference
      return String(x);
    }
    if ('expressID' in val) return `#${val.expressID}`;
    return '';
  }
  if (typeof val === 'number') return fmtNumber(val);
  if (typeof val === 'string') return decodeIfcString(val);
  return String(val);
}

function fmtNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) return n.toExponential(4);
  return String(Math.round(n * 1e6) / 1e6);
}

/** Dekoder IFC STEP-escapes som \X2\00E6\X0\ (æ) og \S\x. */
export function decodeIfcString(s) {
  if (typeof s !== 'string' || !s.includes('\\')) return s;
  return s
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => {
      let out = '';
      for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, ch) => String.fromCharCode(ch.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}
