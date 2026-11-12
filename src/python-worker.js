// Web Worker running Pyodide + IfcOpenShell. Keeps the UI responsive while Python runs.
/* eslint-disable no-restricted-globals */

let pyodide = null;
let loading = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

const BOOTSTRAP = String.raw`
import gc
import json
import ifcopenshell
import ifcopenshell.guid
import ifcopenshell.util.element
import ifcopenshell.util.unit
try:
    import ifcopenshell.api
except Exception as _e:  # api needs numpy; keep working without it
    print("ifcopenshell.api not available:", _e)

_files = {}     # key -> ifcopenshell.file
_names = {}     # key -> file name
_actions = []
_released = []  # keys of models released from memory (the viewer sends them again when needed)
_out_seq = [0]


def _key_of(f):
    for k, v in _files.items():
        if v is f:
            return k
    return None


def _load(key, name, path):
    _files[key] = ifcopenshell.open(path)
    _names[key] = name


def _forget(keep):
    for k in list(_files):
        if k not in keep:
            del _files[k]
            _names.pop(k, None)


def _rekey(old, new, name):
    if old in _files:
        _files[new] = _files.pop(old)
        _names.pop(old, None)
        _names[new] = name


def _spatial(f):
    for t in ("IfcSpatialElement", "IfcSpatialStructureElement"):
        try:
            return f.by_type(t)
        except Exception:
            continue
    return []


_KEEP_REL = ("IfcRelDefinesByProperties", "IfcRelDefinesByType", "IfcRelAssociates")


def _unify_spatial(result, guids):
    """Elements of the spatial structure (site, building, storey ...) with the same GlobalId in
    several models are the same object: keep the first one and point everything to it."""
    by_guid = {}
    for e in _spatial(result):
        if e.GlobalId in guids:
            by_guid.setdefault(e.GlobalId, []).append(e)
    n = 0
    for guid, ents in by_guid.items():
        keeper = ents[0]
        for dup in ents[1:]:
            for inv in list(result.get_inverse(dup)):
                if any(inv.is_a(t) for t in _KEEP_REL):
                    # its own property sets / type / material stay with the first one: drop the copy
                    objs = [o for o in inv.RelatedObjects if o != dup]
                    if objs:
                        inv.RelatedObjects = objs
                    else:
                        result.remove(inv)
                else:
                    ifcopenshell.util.element.replace_attribute(inv, dup, keeper)
            result.remove(dup)
            n += 1
    # the same child aggregated twice under the same parent: remove the repeated relation
    seen = set()
    for rel in list(result.by_type("IfcRelAggregates")):
        if rel.RelatingObject is None:
            continue
        objs = []
        for o in rel.RelatedObjects or []:
            k = (rel.RelatingObject.id(), o.id())
            if k not in seen:
                seen.add(k)
                objs.append(o)
        if not objs:
            result.remove(rel)
        elif len(objs) != len(rel.RelatedObjects):
            rel.RelatedObjects = objs
    return n


def _merge_into(result, f, base_project, base_scale, guids):
    scale = ifcopenshell.util.unit.calculate_unit_scale(f)
    if abs(scale - base_scale) > 1e-9:
        print(f"Warning: length units differ ({scale} vs {base_scale} m per unit). Geometry is not converted.")
    incoming = {e.GlobalId for e in f.by_type("IfcRoot")}
    shared = incoming & guids
    spatial_shared = {e.GlobalId for e in _spatial(f) if e.GlobalId in shared}
    projects = f.by_type("IfcProject")
    shared.difference_update(spatial_shared)
    shared.difference_update(p.GlobalId for p in projects)
    if shared:
        print(f"Warning: {len(shared)} GlobalIds already exist in the merged file (same elements merged twice?).")
    guids.update(incoming)
    merged_project = result.add(projects[0]) if projects else None
    for element in f:
        result.add(element)
    if merged_project is not None and merged_project != base_project:
        for inverse in result.get_inverse(merged_project):
            ifcopenshell.util.element.replace_attribute(inverse, merged_project, base_project)
        result.remove(merged_project)
    if spatial_shared:
        n = _unify_spatial(result, spatial_shared)
        print(f"Combined {n} shared spatial element(s) (site/building/storey with the same GlobalId).")


def merge_models(files, name=None):
    """Merge several IFC files into one new file (same approach as ifcpatch MergeProjects).

    The first file's project, units and coordinate system are kept. All other files are
    added to it and their spatial structures are attached to the first project. Sites,
    buildings and storeys with the same GlobalId are combined into one."""
    files = list(files)
    if len(files) < 2:
        raise ValueError("Select at least two models to merge")
    schemas = sorted({f.schema for f in files})
    if len(schemas) > 1:
        raise ValueError("Cannot merge models with different schemas: " + ", ".join(schemas))
    result = ifcopenshell.file(schema=files[0].schema)
    for e in files[0]:
        result.add(e)
    base_project = result.by_type("IfcProject")[0]
    base_scale = ifcopenshell.util.unit.calculate_unit_scale(result)
    guids = {e.GlobalId for e in result.by_type("IfcRoot")}
    for f in files[1:]:
        _merge_into(result, f, base_project, base_scale, guids)
    return result


def merge_keys(keys):
    """Memory-saving merge of loaded models (used by the Merge dialog): the models are merged
    into the first one in place, and each source is released as soon as it has been added.
    The viewer sends the models again the next time a script needs them."""
    keys = [str(k) for k in keys]
    if len(keys) < 2:
        raise ValueError("Select at least two models to merge")
    files = [_files[k] for k in keys]
    schemas = sorted({f.schema for f in files})
    if len(schemas) > 1:
        raise ValueError("Cannot merge models with different schemas: " + ", ".join(schemas))
    del files
    result = _files.pop(keys[0])
    _names.pop(keys[0], None)
    _released.append(keys[0])
    base_project = result.by_type("IfcProject")[0]
    base_scale = ifcopenshell.util.unit.calculate_unit_scale(result)
    guids = {e.GlobalId for e in result.by_type("IfcRoot")}
    for k in keys[1:]:
        f = _files.pop(k)
        _names.pop(k, None)
        _released.append(k)
        _merge_into(result, f, base_project, base_scale, guids)
        del f
        gc.collect()
    _ns.pop("model", None)
    _ns.pop("models", None)
    _ns.pop("selection", None)
    gc.collect()
    return result


class App:
    """Bridge between your script and the OnlineIFC viewer.

    app.update(model)               reload a loaded model in the viewer with your changes
    app.add_model(file, "x.ifc")    open a new ifcopenshell.file in the viewer
    app.download(file_or_text, "name.ifc")  download an IFC file or any text (CSV, JSON ...)
    app.select(elements)            select elements in the viewer
    app.merge(files)                merge ifcopenshell files into a new file
    """

    _written = {}  # id(file) -> path: a file used by several actions is written once

    def _write(self, f):
        """Writes an IFC file to the (JavaScript-side) in-memory file system. Streaming it there
        avoids building the whole file as a Python string, which large models cannot afford."""
        p = App._written.get(id(f))
        if p is None:
            _out_seq[0] += 1
            p = f"/tmp/out_{_out_seq[0]}.ifc"
            f.write(p)
            App._written[id(f)] = p
        return p

    def update(self, f):
        k = _key_of(f)
        if k is None:
            raise ValueError("This file is not a loaded model. Use app.add_model() for new files.")
        _actions.append({"kind": "update", "key": k, "path": self._write(f)})

    def add_model(self, f, name="new.ifc"):
        _actions.append({"kind": "add", "name": name, "path": self._write(f)})

    def download(self, data, name="output.ifc"):
        if isinstance(data, ifcopenshell.file):
            _actions.append({"kind": "download", "name": name, "path": self._write(data)})
            return
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", "replace")
        _actions.append({"kind": "download", "name": name, "text": str(data)})

    def select(self, elements):
        out = {}
        for e in elements:
            for k, f in _files.items():
                try:
                    if f.by_id(e.id()) == e:
                        out.setdefault(k, []).append(e.id())
                        break
                except Exception:
                    pass
        _actions.append({"kind": "select", "ids": out})

    def merge(self, files, name=None):
        return merge_models(files, name)

    _result = None  # a JSON string returned to the viewer (used by built-in tools such as IDS)

    def __repr__(self):
        return "<OnlineIFC app: update(), add_model(), download(), select(), merge()>"


app = App()
_ns = {"__name__": "__main__", "ifcopenshell": ifcopenshell, "app": app, "merge_models": merge_models, "merge_keys": merge_keys}


def _prepare(active, selection):
    models = {}
    for k, f in _files.items():
        n = _names.get(k, k)
        base, i = n, 2
        while n in models:
            n = f"{base} ({i})"
            i += 1
        models[n] = f
    _ns["models"] = models
    _ns["_files"] = _files
    _ns["model"] = _files.get(active) or (next(iter(_files.values())) if _files else None)
    sel = []
    for k, ids in selection.items():
        f = _files.get(k)
        if f is None:
            continue
        for i in ids:
            try:
                sel.append(f.by_id(i))
            except Exception:
                pass
    _ns["selection"] = sel
    _actions.clear()


def _take_actions():
    out = json.dumps({"actions": _actions, "released": _released})
    _actions.clear()
    _released.clear()
    App._written.clear()
    return out
`;

async function ensureLoaded(config) {
  if (pyodide) return pyodide;
  if (loading) return loading;
  loading = (async () => {
    post({ type: 'status', key: 'py.loadingRuntime' });
    const base = config.pyodideBase.endsWith('/') ? config.pyodideBase : `${config.pyodideBase}/`;
    const { loadPyodide } = await import(/* @vite-ignore */ `${base}pyodide.mjs`);
    const py = await loadPyodide({ indexURL: base });
    py.setStdout({ batched: (s) => post({ type: 'stdout', text: s }) });
    py.setStderr({ batched: (s) => post({ type: 'stderr', text: s }) });

    post({ type: 'status', key: 'py.loadingPackages' });
    for (const p of config.packages) {
      try { await py.loadPackage(p, { messageCallback: () => {} }); } catch (e) { console.warn('Package not loaded:', p, e); }
    }
    post({ type: 'status', key: 'py.loadingIfcOpenShell' });
    const micropip = py.pyimport('micropip');
    await micropip.install(config.wheels);
    micropip.destroy?.();

    await py.runPythonAsync(BOOTSTRAP);
    const version = py.runPython('import importlib.metadata as _md; _md.version("ifcopenshell")');
    pyodide = py;
    post({ type: 'ready', version, python: py.runPython('import sys; sys.version.split()[0]') });
    return py;
  })();
  try {
    return await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

async function run({ id, code, models, active, selection, files }) {
  const py = pyodide;
  for (const f of files || []) py.FS.writeFile(f.path, f.text); // extra input files (e.g. an IDS file)
  const keep = [];
  for (const m of models) {
    keep.push(m.key);
    if (m.bytes) {
      post({ type: 'status', key: 'py.readingModel', vars: { name: m.name } });
      const path = `/tmp/model_${m.key}.ifc`;
      py.FS.writeFile(path, new Uint8Array(m.bytes));
      py.globals.get('_load')(String(m.key), m.name, path);
      py.FS.unlink(path);
    }
  }
  py.globals.get('_forget')(py.toPy(keep.map(String)));
  py.globals.get('_prepare')(active == null ? null : String(active), py.toPy(selection || {}));
  post({ type: 'status', key: 'py.running' });

  try { await py.loadPackagesFromImports(code); } catch { /* the import error will surface when running */ }
  const ns = py.globals.get('_ns');
  let result;
  try {
    result = await py.runPythonAsync(code, { globals: ns });
    if (result !== undefined && result !== null) {
      const r = py.globals.get('repr')(result);
      post({ type: 'stdout', text: String(r) });
      result.destroy?.();
    }
  } finally {
    ns.destroy?.();
  }
  const { actions, released } = JSON.parse(py.globals.get('_take_actions')());
  const appResult = py.runPython('_r = app._result; app._result = None; _r');
  // Files written by the script are read from the in-memory file system as bytes and moved
  // (not copied) to the main thread. A file used by several actions is sent once.
  const transfer = [];
  const byPath = new Map();
  for (const a of actions) {
    if (!a.path) continue;
    if (!byPath.has(a.path)) {
      const bytes = py.FS.readFile(a.path);
      py.FS.unlink(a.path);
      byPath.set(a.path, bytes);
      transfer.push(bytes.buffer);
    }
    a.bytes = byPath.get(a.path);
    delete a.path;
  }
  post({ type: 'done', id, ok: true, actions, released, result: appResult ?? null }, transfer);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      await ensureLoaded(data.config);
    } else if (data.type === 'run') {
      await ensureLoaded(data.config);
      try {
        await run(data);
      } catch (e) {
        let released = [];
        try { released = JSON.parse(pyodide.globals.get('_take_actions')()).released; } catch { /* ignore */ }
        try { pyodide.runPython('import glob, os\nfor _p in glob.glob("/tmp/out_*.ifc"): os.remove(_p)'); } catch { /* ignore */ }
        post({ type: 'done', id: data.id, ok: false, released, error: String(e?.message || e) });
      }
    } else if (data.type === 'rekey') {
      pyodide?.globals.get('_rekey')(String(data.from), String(data.to), data.name);
    } else if (data.type === 'reset') {
      pyodide?.runPython('_files.clear(); _names.clear(); [_ns.pop(k) for k in list(_ns) if k not in ("__name__", "ifcopenshell", "app", "merge_models", "merge_keys", "_files")]');
      post({ type: 'reset-done' });
    }
  } catch (e) {
    post({ type: 'error', error: String(e?.message || e), id: data.id });
  }
};
