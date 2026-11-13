// Where the Python runtime is loaded from. Everything runs in the browser.
//
// The built site serves the runtime itself (public/py, collected by scripts/fetch-python.mjs at
// build time): Pyodide, the packages IfcOpenShell needs, IfcOpenShell and ifctester. The app then
// contacts no other server for the Python features. Only a package that is not hosted, imported by
// a user's own script (e.g. pandas), is fetched from the Pyodide distribution on jsDelivr.
//
// Without public/py (e.g. `npm run dev` before `npm run fetch-python`), everything is loaded from
// jsDelivr, ifcopenshell.github.io and PyPI as a fallback.
//
// Override at runtime (e.g. an intranet mirror): localStorage.setItem('onlineifc.python', JSON.stringify({...})).
/* global __PY_SELF_HOSTED__ */
const SELF_HOSTED = typeof __PY_SELF_HOSTED__ !== 'undefined' && __PY_SELF_HOSTED__;
// Packages from the Pyodide distribution that IfcOpenShell needs
const PACKAGES = ['micropip', 'numpy', 'shapely', 'python-dateutil', 'typing-extensions', 'sqlite3'];
const IFCOS_WHEEL = 'ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';

function defaults() {
  if (SELF_HOSTED) {
    const base = new URL('py/', document.baseURI).href;
    const wheel = (f) => `${base}wheels/${f}`;
    return {
      pyodideBase: `${base}pyodide/`,
      packages: PACKAGES,
      // IfcOpenShell's pure-Python dependencies first, so micropip finds everything installed
      wheels: [wheel('lark-1.3.1-py3-none-any.whl'), wheel('isodate-0.7.2-py3-none-any.whl'), wheel(IFCOS_WHEEL)],
      // Installed (without dependencies) the first time an IDS check runs. Must match the IfcOpenShell version.
      idsWheels: [wheel('ifctester-0.8.5-py3-none-any.whl'), wheel('xmlschema-4.3.2-py3-none-any.whl'), wheel('elementpath-5.1.4-py3-none-any.whl')],
    };
  }
  return {
    pyodideBase: 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/',
    packages: PACKAGES,
    wheels: [`https://ifcopenshell.github.io/wasm-wheels/${IFCOS_WHEEL}`],
    idsWheels: ['ifctester==0.8.5', 'xmlschema==4.3.2', 'elementpath==5.1.4'],
  };
}

export function getPythonConfig() {
  let override = {};
  try {
    override = JSON.parse(localStorage.getItem('onlineifc.python') || '{}') || {};
  } catch { /* ignore */ }
  return { ...defaults(), ...override };
}
