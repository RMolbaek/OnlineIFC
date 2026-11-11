// Where the Python runtime is loaded from. Everything runs in the browser.
//
// Defaults: Pyodide from jsDelivr and the IfcOpenShell WebAssembly wheel from
// ifcopenshell.github.io/wasm-wheels. The pure-Python dependencies (lark, isodate)
// are fetched from PyPI by micropip.
//
// To self-host (offline/intranet), copy the files and override the settings, either
// here or at runtime: localStorage.setItem('onlineifc.python', JSON.stringify({...})).
const DEFAULTS = {
  pyodideBase: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',
  // Packages from the Pyodide distribution that IfcOpenShell needs
  packages: ['micropip', 'numpy', 'shapely', 'python-dateutil', 'typing-extensions', 'sqlite3'],
  // Wheels installed with micropip (URLs or package names on PyPI)
  wheels: ['https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl'],
};

export function getPythonConfig() {
  let override = {};
  try {
    override = JSON.parse(localStorage.getItem('onlineifc.python') || '{}') || {};
  } catch { /* ignore */ }
  return { ...DEFAULTS, ...override };
}
