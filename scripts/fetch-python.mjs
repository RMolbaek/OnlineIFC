// Collects the Python runtime (Pyodide + IfcOpenShell + ifctester) into public/py/, so the built
// site serves it itself and the app does not contact any other server for the Python features.
//
// - Pyodide's core files come from the pinned npm package (node_modules/pyodide).
// - The Pyodide packages IfcOpenShell needs come from the Pyodide distribution (jsDelivr by
//   default, or a local folder with PYODIDE_PACKAGES_DIR) and are checked against the sha256 in
//   pyodide-lock.json.
// - The other wheels (IfcOpenShell, its pure-Python dependencies, ifctester) are pinned in
//   scripts/python-wheels.json with their sha256.
//
// Packages that are not hosted keep an absolute address on jsDelivr in the lock file: they are
// only fetched when a user's own Python script imports them (e.g. pandas).
//
// Run: npm run fetch-python   (npm run build runs it first; the files are not committed)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'py');
const pyDir = join(out, 'pyodide');
const wheelDir = join(out, 'wheels');
const npmDir = join(root, 'node_modules', 'pyodide');
const version = JSON.parse(readFileSync(join(npmDir, 'package.json'), 'utf8')).version;
const cdn = process.env.PYODIDE_CDN || `https://cdn.jsdelivr.net/pyodide/v${version}/full/`;
const localPackages = process.env.PYODIDE_PACKAGES_DIR || '';
const spec = JSON.parse(readFileSync(join(root, 'scripts', 'python-wheels.json'), 'utf8'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
async function get(url) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}
function check(name, buf, want) {
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name}: sha256 ${got} does not match ${want}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(pyDir, { recursive: true });
mkdirSync(wheelDir, { recursive: true });

// 1. Pyodide core
for (const f of ['pyodide.mjs', 'pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip']) copyFileSync(join(npmDir, f), join(pyDir, f));

// 2. Pyodide packages for IfcOpenShell, with their dependencies
const lock = JSON.parse(readFileSync(join(npmDir, 'pyodide-lock.json'), 'utf8'));
const hosted = new Set();
const add = (n) => {
  n = n.toLowerCase();
  if (hosted.has(n)) return;
  if (!lock.packages[n]) throw new Error(`package ${n} is not in pyodide-lock.json`);
  hosted.add(n);
  for (const d of lock.packages[n].depends || []) add(d);
};
for (const p of spec.pyodidePackages) add(p);
for (const n of hosted) {
  const pkg = lock.packages[n];
  const buf = localPackages ? readFileSync(join(localPackages, pkg.file_name)) : await get(cdn + pkg.file_name);
  check(pkg.file_name, buf, pkg.sha256);
  writeFileSync(join(pyDir, pkg.file_name), buf);
}
// the rest of the distribution stays on jsDelivr, fetched only if a user's script imports it
for (const [n, pkg] of Object.entries(lock.packages)) if (!hosted.has(n)) pkg.file_name = cdn + pkg.file_name;
writeFileSync(join(pyDir, 'pyodide-lock.json'), JSON.stringify(lock));

// 3. Pinned wheels (IfcOpenShell and the pure-Python packages)
for (const w of [...spec.wheels, ...spec.idsWheels]) {
  let buf = null, err = null;
  for (const url of w.urls) {
    try { buf = await get(url); break; } catch (e) { err = e; }
  }
  if (!buf) throw err;
  check(w.file, buf, w.sha256);
  writeFileSync(join(wheelDir, w.file), buf);
}

let bytes = 0;
for (const d of [pyDir, wheelDir]) for (const f of readdirSync(d)) bytes += statSync(join(d, f)).size;
console.log(`Python runtime in public/py: Pyodide ${version}, ${hosted.size} packages, ${spec.wheels.length + spec.idsWheels.length} wheels, ${(bytes / 1e6).toFixed(1)} MB`);
if (!existsSync(join(pyDir, 'pyodide.mjs'))) process.exit(1);
