// Indlæsning af IFC-filer med web-ifc og opslag af metadata.
import * as WebIFC from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import * as THREE from 'three';
import { IfcModel } from './model.js';

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
  return prettyNames.get(raw) || raw;
}

export function prettyRawName(raw) {
  if (!raw) return '';
  return prettyNames.get(String(raw).toUpperCase()) || raw;
}

/**
 * Læser en IFC-fil og bygger et IfcModel med sammenflettet geometri.
 * @param {File} file
 * @param {{ referenceMatrix?: THREE.Matrix4|null, onProgress?: (msg:string, frac:number)=>void }} opts
 */
export async function loadIfcFile(file, opts = {}) {
  const { onProgress = () => {} } = opts;
  const api = await getApi();

  onProgress(`Læser ${file.name}…`, 0.05);
  const data = new Uint8Array(await file.arrayBuffer());
  await nextFrame();

  onProgress(`Fortolker ${file.name}…`, 0.15);
  await nextFrame();
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: 16 });
  if (modelID < 0) throw new Error('Filen kunne ikke åbnes som IFC.');

  const schema = api.GetModelSchema(modelID);

  onProgress(`Genererer geometri for ${file.name}…`, 0.3);
  await nextFrame();

  // Grupper alle trekanter efter farve, så hver model kun bliver få draw calls.
  const buckets = new Map();
  const mat = new THREE.Matrix4();
  const nrm = new THREE.Matrix3();
  const v = new THREE.Vector3();

  const spaceIds = new Set();
  const onMesh = (flatMesh, prefix) => {
    const expressID = flatMesh.expressID;
    if (prefix) spaceIds.add(expressID);
    const n = flatMesh.geometries.size();
    for (let i = 0; i < n; i++) {
      const pg = flatMesh.geometries.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      if (verts.length === 0 || idx.length === 0) { geom.delete(); continue; }

      const c = pg.color;
      const key = `${prefix}${c.x.toFixed(3)}_${c.y.toFixed(3)}_${c.z.toFixed(3)}_${c.w.toFixed(3)}`;
      let b = buckets.get(key);
      if (!b) {
        // Rum (IfcSpace) vises halvgennemsigtige, så de ikke skjuler bygningen.
        const opacity = prefix ? Math.min(c.w, 0.25) : c.w;
        b = { color: new THREE.Color(c.x, c.y, c.z), opacity, pos: [], nor: [], idx: [], items: [], vCount: 0, iCount: 0 };
        buckets.set(key, b);
      }

      mat.fromArray(pg.flatTransformation);
      nrm.getNormalMatrix(mat);
      const vc = verts.length / 6;
      const pos = new Float32Array(vc * 3);
      const nor = new Float32Array(vc * 3);
      for (let k = 0; k < vc; k++) {
        v.set(verts[k * 6], verts[k * 6 + 1], verts[k * 6 + 2]).applyMatrix4(mat);
        pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
        v.set(verts[k * 6 + 3], verts[k * 6 + 4], verts[k * 6 + 5]).applyMatrix3(nrm).normalize();
        nor[k * 3] = v.x; nor[k * 3 + 1] = v.y; nor[k * 3 + 2] = v.z;
      }
      const ind = new Uint32Array(idx.length);
      for (let k = 0; k < idx.length; k++) ind[k] = idx[k] + b.vCount;

      const last = b.items[b.items.length - 1];
      if (last && last.id === expressID && last.start + last.count === b.iCount) last.count += ind.length;
      else b.items.push({ id: expressID, start: b.iCount, count: ind.length });

      b.pos.push(pos); b.nor.push(nor); b.idx.push(ind);
      b.vCount += vc; b.iCount += ind.length;
      geom.delete();
    }
  };
  api.StreamAllMeshes(modelID, (m) => onMesh(m, ''));
  // StreamAllMeshes udelader rum; hent dem separat (skjult som standard).
  try {
    api.StreamAllMeshesWithTypes(modelID, [WebIFC.IFCSPACE], (m) => onMesh(m, 'space_'));
  } catch (e) {
    console.warn('Kunne ikke hente rumgeometri', e);
  }

  onProgress(`Bygger 3D-visning for ${file.name}…`, 0.75);
  await nextFrame();

  const merged = [];
  for (const b of buckets.values()) {
    merged.push({
      color: b.color,
      opacity: b.opacity,
      positions: concat(Float32Array, b.pos, b.vCount * 3),
      normals: concat(Float32Array, b.nor, b.vCount * 3),
      index: concat(Uint32Array, b.idx, b.iCount),
      items: b.items,
    });
  }

  const coordMatrix = new THREE.Matrix4().fromArray(api.GetCoordinationMatrix(modelID));

  const model = new IfcModel({ name: file.name, api, modelID, buckets: merged, schema, fileSize: file.size, coordMatrix, spaceIds });

  onProgress(`Læser rumlig struktur for ${file.name}…`, 0.9);
  await nextFrame();
  await model.loadStructure();

  onProgress('Færdig', 1);
  return model;
}

function concat(Type, chunks, total) {
  const out = new Type(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
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
        if (x === 'T' || x === true) return 'Sand';
        if (x === 'F' || x === false) return 'Falsk';
        if (x === 'U') return 'Ukendt';
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
