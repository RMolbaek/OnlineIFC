// Merging IFC files directly on the STEP text, streamed in chunks.
//
// Python/IfcOpenShell needs about 7× the file size in memory and is limited to 4 GB in the
// browser, so models of a few hundred MB cannot be merged there. This merge reads each file
// in chunks, renumbers the entities (#id) of every following file and writes the result as a
// Blob, so it needs little more memory than the files themselves.
//
// Same result as IfcOpenShell's MergeProjects: the first file's header, project, units and
// coordinate system are kept; the projects of the other files are replaced by the first one.
// Spatial elements (site, building, storey, space, facility …) that have the same GlobalId in
// several files are the same object and are combined; the repeated relations are dropped.
//
// Bytes are decoded with "x-user-defined" (a 1:1 byte <-> character mapping), so the content
// is written back byte for byte, whatever encoding the exporter used.

const SPATIAL = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCEXTERNALSPATIALELEMENT', 'IFCSPATIALZONE',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART', 'IFCRAILWAY', 'IFCRAILWAYPART',
  'IFCMARINEFACILITY', 'IFCMARINEPART', 'IFCTUNNEL', 'IFCTUNNELPART', 'IFCFACILITYPARTCOMMON',
]);
// relations whose RelatedObjects list should not point twice to a combined spatial element
const ATTACH_RELS = /^IFCREL(DEFINESBYPROPERTIES|DEFINESBYTYPE|ASSOCIATES[A-Z]*)$/;
const TREE_RELS = /^IFCREL(AGGREGATES|NESTS)$/;

const HEAD_RE = /^#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/;
const GUID_RE = /^#\d+\s*=\s*[A-Za-z0-9_]+\s*\(\s*'([^']*)'/;
const LIST_RE = /\(\s*#\d+(?:\s*,\s*#\d+)*\s*\)/;
const RELATING_LIST_RE = /(#\d+)\s*,\s*(\(\s*#\d+(?:\s*,\s*#\d+)*\s*\))/;
const CHUNK = 8 * 1024 * 1024;

let decoder = null;
try { decoder = new TextDecoder('x-user-defined'); } catch { /* not in every runtime: plain byte -> char below */ }
function decode(bytes) {
  if (decoder) return decoder.decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

/** Characters back to the original bytes (inverse of the x-user-defined decoding). */
function encode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[i] = c >= 0xf780 ? c - 0xf700 : c;
  }
  return out;
}

/**
 * Yields the records of a STEP file (text up to and including the ';' that ends it, quotes and
 * comments respected) together with the fraction of the file read so far.
 */
async function* records(blob) {
  let rest = '';
  let pos = 0;
  while (pos < blob.size || rest.length) {
    let text = rest;
    const end = Math.min(blob.size, pos + CHUNK);
    if (pos < blob.size) {
      text += decode(new Uint8Array(await blob.slice(pos, end).arrayBuffer()));
      pos = end;
    }
    const last = pos >= blob.size;
    // Split into records. The next quote / comment position is cached and only searched again
    // once it has been passed (searching from every ';' would be quadratic).
    let start = 0, i = 0;
    const n = text.length;
    let q = -2, c = -2;
    const batch = [];
    while (i < n) {
      if (q !== -1 && q < i) q = text.indexOf("'", i);
      if (c !== -1 && c < i) c = text.indexOf('/*', i);
      let sc = text.indexOf(';', i); if (sc < 0) sc = n;
      const qq = q < 0 ? n : q, cc = c < 0 ? n : c;
      if (sc < qq && sc < cc) {
        batch.push(text.slice(start, sc + 1));
        start = sc + 1;
        i = start;
        continue;
      }
      if (sc === n && qq === n && cc === n) { i = n; break; }
      if (qq < cc) {
        // inside a string: skip to its closing quote ('' is two quotes and toggles twice)
        const e = text.indexOf("'", qq + 1);
        if (e < 0) { i = n; break; }
        i = e + 1;
      } else {
        const e = text.indexOf('*/', cc + 2);
        if (e < 0) { i = n; break; }
        i = e + 2;
      }
    }
    const f = pos / blob.size;
    for (const r of batch) yield [r, f];
    rest = text.slice(start);
    if (last) {
      if (rest.trim()) yield [rest, 1];
      break;
    }
    if (rest.length > 64 * 1024 * 1024) throw new Error('Not a valid IFC (STEP) file: a record without end');
  }
}

/** Applies fn to the parts of a record outside of quoted strings. */
function outside(rec, fn) {
  if (rec.indexOf("'") < 0) return fn(rec);
  const parts = rec.split("'");
  for (let i = 0; i < parts.length; i += 2) parts[i] = fn(parts[i]);
  return parts.join("'");
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Merges IFC files. sources: [{name, blob}] (the first one is the base).
 * Returns {blob, schema, combined, entities}.
 */
export async function mergeIfcBlobs(sources, onProgress = () => {}) {
  if (sources.length < 2) throw new Error('At least two models are needed');
  const total = sources.reduce((a, s) => a + s.blob.size, 0);
  let done = 0;
  const progress = (f, size, phase) => onProgress(Math.min(1, (done + f * size) / total), phase);

  const out = []; // Blob parts
  let buf = [];
  let bufLen = 0;
  const write = (s) => {
    buf.push(s);
    bufLen += s.length;
    if (bufLen > CHUNK) flush();
  };
  const flush = () => {
    if (!buf.length) return;
    out.push(encode(buf.join('')));
    buf = [];
    bufLen = 0;
  };

  let schema = null;
  let offset = 0; // added to the entity numbers of the current file
  let baseProject = null;
  const spatialByGuid = new Map(); // GlobalId -> entity number in the merged file
  let combined = 0;
  let entities = 0;

  for (let fi = 0; fi < sources.length; fi++) {
    const { name, blob } = sources[fi];
    const base = fi === 0;

    // ---- pass 1: schema, highest entity number, project, spatial elements to combine
    let maxId = 0;
    let fileSchema = null;
    let project = null;
    const map = new Map(); // entity number in this file -> number in the merged file (combined elements)
    const newSpatial = [];
    for await (const [raw, f] of records(blob)) {
      const rec = raw.trimStart();
      if (rec.charCodeAt(0) !== 35 /* # */) {
        if (/^FILE_SCHEMA/i.test(rec)) fileSchema = (rec.match(/'([^']+)'/) || [])[1]?.toUpperCase() || null;
        continue;
      }
      const m = HEAD_RE.exec(rec);
      if (!m) continue;
      const id = +m[1];
      if (id > maxId) maxId = id;
      const type = m[2].toUpperCase();
      if (type === 'IFCPROJECT') project = id;
      else if (SPATIAL.has(type)) {
        const g = GUID_RE.exec(rec)?.[1];
        if (!g) continue;
        const known = spatialByGuid.get(g);
        if (known !== undefined) map.set(id, known);
        else newSpatial.push([g, id]);
      }
      if ((id & 0x3fff) === 0) progress(f * 0.3, blob.size, name);
    }
    if (!fileSchema) throw new Error(`${name}: no FILE_SCHEMA in the header`);
    if (base) schema = fileSchema;
    else if (fileSchema !== schema) throw new Error(`Cannot merge ${fileSchema} (${name}) with ${schema}`);
    if (project === null) throw new Error(`${name}: no IfcProject`);
    if (base) baseProject = project;
    else map.set(project, baseProject);
    for (const [g, id] of newSpatial) spatialByGuid.set(g, id + offset);
    combined += base ? 0 : map.size - 1;

    // ---- pass 2: write
    const ref = (id) => {
      const n = +id;
      const to = map.get(n);
      return `#${to !== undefined ? to : n + offset}`;
    };
    const renumber = (s) => s.replace(/#(\d+)/g, (_, id) => ref(id));
    let inData = false;
    let count = 0;
    for await (const [raw, f] of records(blob)) {
      const rec = raw.trimStart();
      if (rec.charCodeAt(0) !== 35) {
        const word = rec.replace(/^\/\*[\s\S]*?\*\/\s*/, '').slice(0, 20).toUpperCase();
        if (word.startsWith('DATA')) { inData = true; if (base) write(raw); continue; }
        if (word.startsWith('ENDSEC') && inData) { inData = false; continue; }
        if (word.startsWith('END-ISO')) continue;
        if (base) write(raw); // header of the first file
        continue;
      }
      if (!inData) continue;
      const m = HEAD_RE.exec(rec);
      if (!m) continue;
      const id = +m[1];
      if (map.has(id)) continue; // combined spatial element or the project of a following file: not written
      count++;
      if (base) { write(raw); continue; }
      const type = m[2].toUpperCase();
      let text = raw;
      if (map.size && (ATTACH_RELS.test(type) || TREE_RELS.test(type))) {
        let drop = false;
        text = outside(stripComments(raw), (s) => {
          if (ATTACH_RELS.test(type)) {
            return s.replace(LIST_RE, (list) => {
              const ids = list.match(/#\d+/g).filter((x) => !map.has(+x.slice(1)));
              if (!ids.length) drop = true;
              return `(${ids.join(',')})`;
            });
          }
          return s.replace(RELATING_LIST_RE, (all, relating, list) => {
            if (!map.has(+relating.slice(1))) return all;
            const ids = list.match(/#\d+/g).filter((x) => !map.has(+x.slice(1)));
            if (!ids.length) drop = true;
            return `${relating},(${ids.join(',')})`;
          });
        });
        if (drop) { count--; continue; }
      }
      write(outside(text, renumber));
      if ((count & 0x3fff) === 0) progress(0.3 + f * 0.7, blob.size, name);
    }
    entities += count;
    offset += maxId;
    done += blob.size;
  }
  write('\nENDSEC;\nEND-ISO-10303-21;\n');
  flush();
  return { blob: new Blob(out, { type: 'application/x-step' }), schema, combined, entities };
}
