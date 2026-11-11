# OnlineIFC

An IFC viewer and editor that runs entirely in the browser. Files are processed locally (WebAssembly) and are never uploaded.

The interface is in **English**, **Danish** and **German** (language picker in the top right corner; the choice is remembered).

## Features

### Review
- Open one or more `.ifc` files (IFC2x3, IFC4, IFC4x3) with the button or drag and drop.
- **Federation:** several models are shown in one view. The first model defines the coordinate system and the following models are placed relative to it using their own coordinates.
- **Sections:** horizontal plan section, vertical sections (X/Y), a section parallel to a clicked face, and a section box around the selection. Every plane can be moved with a slider, flipped, disabled or removed. Cut faces are coloured red.
- **Colours:** colour and opacity per model, *Colour by model* gives every model its own colour, *Original* restores the colours from the IFC file.
- **Metadata:** click an element to see attributes, its location in the spatial structure, property sets, quantities (with units), type and type properties, materials and layers, and classifications. The panel can be filtered.
- **Structure and classes:** a tree from project to element and a list of IFC classes. Both can be used to select, hide and show elements, and the tree can be searched by name, class, GUID or tag.
- Hide, isolate, show all, show/hide spaces, CSV export of all properties, screenshots.

### Edit metadata
Turn on **Edit** (toolbar, properties panel or the `E` key):
- Edit string attributes (`Name`, `Description`, `ObjectType`, `Tag`, `LongName` …) directly in the properties panel.
- Change, add and remove single-value properties in property sets. Values keep their IFC type (label, length, boolean …). New properties can be text, number, integer or yes/no.
- **Batch editing:** select several elements (for example a whole class) and set a property on all of them. Existing values are overwritten, missing properties are added, and elements without the property set get a new one.
- Shared property sets and type property sets are marked, so you can see when a change affects more elements.
- Every model card shows the list of changes. **Download IFC** saves the edited file (`*_edited.ifc`).

### Merge models
**Merge** combines two or more loaded models into a single IFC file with IfcOpenShell (the same approach as `ifcpatch` *MergeProjects*). The first model keeps its project, units and coordinate system, and the spatial structures of the others are attached to it. The result opens in the viewer and can be downloaded. The models must use the same IFC schema. A warning is shown if length units differ or if GlobalIds are duplicated.

### Python with IfcOpenShell
**Python** opens a code editor with a console. Scripts run with [Pyodide](https://pyodide.org) and [IfcOpenShell](https://ifcopenshell.org) 0.8.5 in a Web Worker in the browser. The first start downloads about 30 MB; after that the browser caches it.

These names are available in scripts:

| Name | Contents |
| --- | --- |
| `model` | the active model (`ifcopenshell.file`), i.e. the one you last clicked in |
| `models` | all loaded models: `{"file name": ifcopenshell.file}` |
| `selection` | the selected elements as IfcOpenShell entities |
| `app.update(model)` | reload a model in the viewer with the changes made in Python |
| `app.add_model(f, "name.ifc")` | open a new `ifcopenshell.file` in the viewer |
| `app.download(f_or_text, "name")` | download an IFC file or any text (CSV, JSON …) |
| `app.select(elements)` | select elements in the viewer |
| `app.merge(files)` | merge files into a new `ifcopenshell.file` |

Run with **Ctrl+Enter**. The script is saved in the browser. The *Examples* menu has ready-made scripts: count elements per class, set a property set on the selection, find walls missing FireRating, rename storeys, export all properties to CSV, remove a class, and merge all models. `ifcopenshell.api`, `ifcopenshell.util.*`, numpy and shapely are available. Other Pyodide packages, such as pandas, are loaded automatically when you import them.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Rotate / select | Left mouse / click |
| Pan | Right mouse or Shift + left |
| Zoom | Scroll (towards the cursor) |
| Center on point | Double-click |
| Add to / remove from selection | Ctrl/Shift + click |
| Zoom to selection | F |
| Hide / isolate / show all | H / I / Shift+H |
| Edit mode | E |
| Run Python script | Ctrl+Enter |
| Clear selection | Esc |

## Development

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # static build in dist/
npm run preview  # preview the build
```

Built with [three.js](https://threejs.org), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (viewing and metadata editing), [Pyodide](https://pyodide.org) + [IfcOpenShell](https://ifcopenshell.org) (Python and merging) and [CodeMirror](https://codemirror.net). It is a static site with no backend.

| File | Purpose |
| --- | --- |
| `src/main.js` | user interface |
| `src/viewer.js` | three.js scene, picking, sections |
| `src/ifc.js`, `src/model.js` | loading IFC, metadata and metadata editing (web-ifc) |
| `src/python.js`, `src/python-worker.js` | Pyodide/IfcOpenShell worker and merge logic |
| `src/scripting.js`, `src/examples.js` | Python panel and example scripts |
| `src/i18n.js` | translations (en/da/de) |
| `src/config.js` | where Pyodide and the IfcOpenShell wheel are loaded from |

### Python runtime sources

By default Pyodide is loaded from jsDelivr and the IfcOpenShell wheel from `ifcopenshell.github.io/wasm-wheels`. The pure-Python dependencies (`lark`, `isodate`) come from PyPI. To self-host (offline or on an intranet), copy the files and change `src/config.js`, or set an override in the browser:

```js
localStorage.setItem('onlineifc.python', JSON.stringify({
  pyodideBase: 'https://example.com/pyodide/',
  wheels: ['https://example.com/wheels/lark-1.3.1-py3-none-any.whl',
           'https://example.com/wheels/isodate-0.7.2-py3-none-any.whl',
           'https://example.com/wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl'],
}));
```

## Deployment

`.github/workflows/deploy.yml` builds the site and deploys it to GitHub Pages on every push to `main`.
Enable Pages once: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The `dist/` folder can also be put on any other static host (Netlify, Azure Static Web Apps, S3 …).
