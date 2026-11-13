// Local storage of projects, IFC files and prepared geometry in the browser (IndexedDB).
// Everything stays on this computer; nothing is uploaded.
//
// Stores:
//   files     fingerprint -> {key, name, size, blob, added}      the IFC files of projects
//   geom      fingerprint -> {key, header, blob, size, lastUsed} geometry ready for display
//   projects  id -> {id, name, created, modified, files: [{key, name}], state, thumb}
import * as THREE from 'three';

// Storage keys keep the project's former name (onlineifc), so data saved in the browser stays.
const DB_NAME = 'onlineifc';
const DB_VERSION = 1;
// Bump when the loader changes in a way that changes the geometry (invalidates the geometry cache).
export const GEOMETRY_FORMAT = 'g2-webifc0.0.78-seg16';

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('geom')) d.createObjectStore('geom', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export const get = (store, key) => tx(store, 'readonly', (s) => req2p(s.get(key)));
export const put = (store, value) => tx(store, 'readwrite', (s) => req2p(s.put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => req2p(s.delete(key)));
export const all = (store) => tx(store, 'readonly', (s) => req2p(s.getAll()));
/** All records without their blobs (for listings). */
export const allMeta = (store) => tx(store, 'readonly', (s) => new Promise((resolve, reject) => {
  const out = [];
  const c = s.openCursor();
  c.onsuccess = () => {
    const cur = c.result;
    if (!cur) { resolve(out); return; }
    const { blob, ...meta } = cur.value;
    out.push({ ...meta, blobSize: blob?.size || 0 });
    cur.continue();
  };
  c.onerror = () => reject(c.error);
}));

export function available() {
  return typeof indexedDB !== 'undefined';
}

/** Asks the browser not to clear our data under storage pressure (granted silently in most cases). */
export async function persist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}

export async function estimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// ------------------------------------------------------------- fingerprint
/**
 * Identifies a file by its content without reading all of it: size plus a SHA-256 over the first
 * and last 2 MB and 16 samples of 64 KB in between. Changed files get a new fingerprint.
 */
export async function fingerprint(blob) {
  const size = blob.size;
  const parts = [];
  const take = async (a, b) => parts.push(new Uint8Array(await blob.slice(Math.max(0, a), Math.min(size, b)).arrayBuffer()));
  const M = 2 * 1024 * 1024;
  if (size <= 6 * M) await take(0, size);
  else {
    await take(0, M);
    for (let i = 1; i <= 16; i++) { const p = Math.floor((size * i) / 17); await take(p, p + 65536); }
    await take(size - M, size);
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(total + 8);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  new DataView(buf.buffer).setFloat64(total, size);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return `${size.toString(36)}-${[...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------- geometry cache
const align4 = (n) => (n + 3) & ~3;

/** Saves the prepared geometry of a model ({buckets, spaceIds, coordMatrix}). */
export async function putGeometry(key, { buckets, spaceIds, coordMatrix, schema, tree = null }) {
  const parts = [];
  let offset = 0;
  const add = (arr) => {
    const at = offset;
    parts.push(arr);
    const pad = align4(arr.byteLength) - arr.byteLength;
    if (pad) parts.push(new Uint8Array(pad));
    offset += arr.byteLength + pad;
    return [at, arr.length];
  };
  const header = { format: GEOMETRY_FORMAT, schema, coordMatrix: [...coordMatrix.elements], spaceIds: [...spaceIds], buckets: [], tree };
  for (const b of buckets) {
    const items = new Uint32Array(b.items.length * 3);
    b.items.forEach((it, i) => { items[i * 3] = it.id; items[i * 3 + 1] = it.start; items[i * 3 + 2] = it.count; });
    header.buckets.push({
      color: [b.color.r, b.color.g, b.color.b], opacity: b.opacity,
      positions: add(b.positions), normals: add(b.normals), index: add(b.index), items: add(items),
    });
  }
  const blob = new Blob(parts);
  await put('geom', { key, header, blob, size: blob.size, lastUsed: Date.now() });
  return blob.size;
}

/** Reads cached geometry (null if missing or made by an older loader). */
export async function getGeometry(key) {
  const rec = await get('geom', key);
  if (!rec || rec.header?.format !== GEOMETRY_FORMAT) return null;
  const buf = await rec.blob.arrayBuffer();
  const view = (Type, [at, len]) => new Type(buf, at, len);
  const buckets = rec.header.buckets.map((b) => {
    const items = view(Uint32Array, b.items);
    const list = new Array(items.length / 3);
    for (let i = 0; i < list.length; i++) list[i] = { id: items[i * 3], start: items[i * 3 + 1], count: items[i * 3 + 2] };
    return {
      color: new THREE.Color(b.color[0], b.color[1], b.color[2]), opacity: b.opacity,
      positions: view(Float32Array, b.positions), normals: view(Int8Array, b.normals), index: view(Uint32Array, b.index), items: list,
    };
  });
  // remember when it was used (oldest unused caches are removed first)
  put('geom', { ...rec, lastUsed: Date.now() }).catch(() => {});
  return { buckets, spaceIds: new Set(rec.header.spaceIds), coordMatrix: new THREE.Matrix4().fromArray(rec.header.coordMatrix), schema: rec.header.schema, tree: rec.header.tree || null };
}

/** Removes geometry caches (oldest first) until the cache is below maxBytes; keeps `keep` keys. */
export async function trimGeometry(maxBytes, keep = new Set()) {
  const list = (await allMeta('geom')).sort((a, b) => a.lastUsed - b.lastUsed);
  let total = list.reduce((a, g) => a + (g.size || 0), 0);
  for (const g of list) {
    if (total <= maxBytes) break;
    if (keep.has(g.key)) continue;
    await del('geom', g.key);
    total -= g.size || 0;
  }
  return total;
}
