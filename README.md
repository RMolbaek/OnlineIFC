# OnlineIFC

An IFC viewer and editor that runs entirely in the browser. Files are processed locally (WebAssembly) and are never uploaded.

The interface is in **English**, **Danish**, **German** and **Hindi** (language picker in the top right corner; the choice is remembered). There is a light and a dark theme (moon/sun button).

## Features

### Review
- **Open files** (IFC2x3, IFC4, IFC4x3): drag and drop them anywhere in the window at any time, or click the drop area on the start screen / *Open IFC*. Dropped files are recognised by type: `.ifc` models are added to the view, `.bcf`/`.bcfzip` go to *Issues*, `.ids` opens the IDS check, and `.onlineifc.json` opens a workspace.
- **Federation:** several models are shown in one view. The first model defines the coordinate system and the following models are placed relative to it using their own coordinates.
- **Wrong length units:** some exporters state a unit that does not match the coordinates, e.g. *millimetre* while the coordinates are metres. Such a model would be 1000× too small and far away from the others. OnlineIFC detects the clear cases (a model of a few metres at projected coordinates, or two models that only fit together with the correction), corrects the scale and tells you. The *Unit* field on the model card changes it by hand; projects remember the choice.
- **Sections:** horizontal plan section, vertical sections (X/Y), a section parallel to a clicked face, and a section box around the selection. Every plane can be moved with a slider, stepped with ‹ › by a chosen step length (e.g. 0.5 m), placed at a typed position (↑/↓ in the field steps too), flipped, disabled or removed. Cut faces are coloured red.
- **Colours:** colour and opacity per model, *Colour by model* gives every model its own colour, *Original* restores the colours from the IFC file.
- **Toolbar menus:** *View*, *Section* and *Visibility* open menus where every tool has a short description.
- **Axis cross:** an X/Y/Z axis indicator in the top-left corner of the 3D view always shows the directions (IFC axes, Z up).
- **Side panels** can be hidden (‹ / › buttons) to give the 3D view more room.
- **Metadata:** click an element to see attributes, its location in the spatial structure, property sets, quantities (with units), type and type properties, materials and layers, and classifications. The panel can be filtered.
- **Calculated quantities:** for every element the volume, surface area, plan area (top faces), length, width and height are calculated from the 3D geometry, next to the quantities stored in the IFC file. With several elements selected, the totals are shown. The values are also included in the CSV export.
- **Structure and classes:** a tree from project to element and a list of IFC classes, searchable by name, class, GUID or tag. Select several rows with Ctrl+click (toggle) and Shift+click (range), then hide, show or isolate them all at once with the bar above the list, or with the eye on any selected row. The same bar has a **transparency** slider for the selected elements (*Solid* makes them solid again).
- Hide, isolate, show all, show/hide spaces, CSV export of all properties, screenshots.
- **Right-click menu** (right click without dragging; dragging with the right button still rotates): on an element it offers hide / show only / transparent / zoom / copy GlobalId, and hide / show only / select for its **IFC class**, its **layer** (`IfcPresentationLayerAssignment`, the CAD layers of the exporting program), its **storey** and its **model**. On empty space it lists all layers with on/off checkboxes. Rows in *Structure* and *Classes* have a right-click menu too. Layers are also available in *Filters* (colour or find by layer).
- **Large models (300 MB+):** geometry is streamed in batches with progress, only small repeated geometries are cached, normals are stored compactly, the IFC file is not kept in memory a second time (it is read again from disk when needed), web-ifc may use up to 3.5 GB, and picking/snapping uses a BVH (three-mesh-bvh), so clicking and measuring stay fast on models with tens of thousands of elements.
- **Orthographic camera** (O): parallel projection without perspective, also stored in BCF viewpoints (`OrthogonalCamera`).
- **Storeys:** the *View* menu lists all storeys of all models by elevation. Click one to show it alone, optionally with a plan cut 1.2 m above the floor. Page Up / Page Down step through the storeys.
- **X-ray** (X): everything becomes see-through except the selected elements.
- **Walk mode** (W): first-person view. W/A/S/D or the arrow keys move horizontally, drag to look around, Q/E down/up, Shift is faster, the wheel sets the speed, Esc leaves walk mode.

### Projects (remembered locally)

- OnlineIFC remembers what you worked on, **only in this browser on this computer** (IndexedDB) – nothing is uploaded. A project is created automatically when you open a model and saved automatically: the IFC files (including metadata edits), the saved views, the issues and the last view (camera, sections, visibility, colours, transparency, X-ray).
- The start screen shows the **recent projects**; click one to continue where you stopped. The *Models* tab shows the current project (rename it there); *Projects* lists all projects with their size, and can start a new project, delete projects, remove the prepared geometry to free space, or turn the saving off.
- **Large models open faster the second time:** the prepared geometry and the spatial structure are stored with the file (in a test 93 MB / 240,000 elements: 15.5 s the first time, 5.2 s from the project). Files are recognised by a fingerprint of their content, so a changed file is prepared again.
- The browser may remove the data when the disk is almost full; OnlineIFC asks it to keep the data (persistent storage). Clearing the browser's site data removes the projects.

### Saved views and workspace

- **Views tab:** save the current view under a name (camera, sections, visibility, colours, transparency, selection, X-ray) with a thumbnail, and click it to return. Views refer to elements by GlobalId, so they also work on a newer version of the model. They are kept in the browser.
- **Workspace file** (`.onlineifc.json`): saves the views, the issues and the current view in one small file to share or to continue later. The IFC files are not included; open them together with the workspace file (or afterwards).

### Quantity takeoff

- **Quantity takeoff** (Q, or the button in the *Models* tab): a table with the count and the summed volume, surface area, plan area and length per group, grouped by one or two properties (class, storey, type, name, any property …). Add any numeric property, e.g. from a `Qto_` set, as an extra column. Works on all visible elements or on the selection; click a row to select its elements; export to CSV.

### Filters (colour and find by properties)
The **Filters** tab indexes the attributes, storey, type, material, property sets, quantities and calculated quantities of all elements.
- **Colour by property:** choose any property and get a legend with a colour per value (numeric values are grouped in ranges). Click a value to select its elements, hide/show values, change colours, and optionally make elements without a value transparent.
- **Find elements:** rules such as *Class = IfcWall* and *Pset_WallCommon.FireRating has no value* (=, ≠, contains, >, <, has / has no value; all or any rule) to select, isolate, hide or colour the matching elements.

### Compare versions
**Compare** matches the elements of two loaded versions by GlobalId and shows what was **added** (green), **removed** (red) and **changed** (orange: attributes, property values, volume/area or position), with unchanged elements in transparent grey. The panel lists every change; click an element to zoom to it. The report can be exported as CSV.

### IDS check
**IDS** checks models against an `.ids` file (buildingSMART Information Delivery Specification) with IfcOpenShell's **ifctester**, running in the browser. Results are listed per specification with the requirements and the failing elements and their reasons. Failing elements can be selected, results coloured pass/fail, and everything exported as CSV. ifctester is installed the first time (a few seconds).

### Issues (BCF)
The **Issues** tab creates issues from the current view. The camera, section planes, visibility, selection and colours are saved as a BCF viewpoint with a snapshot. Issues have type, status, priority, assignee and comments (optionally with their own view), and clicking an issue restores its view. **Export** writes a `.bcfzip` in BCF 2.1 (default, the most widely supported) or 3.0, validated against the buildingSMART schemas. **Import** reads BCF 2.0, 2.1 and 3.0 files from other tools (BIMcollab, Solibri, Revit, Trimble Connect …).

### 2D drawings
**Section → Export section as drawing** (or **2D** next to a section plane) turns a section into a drawing:
- **PDF/SVG:** true scale on A4–A0 (or fitted), a title block that wraps/shortens long model names so nothing overlaps the scale bar, cut outlines with filled cut areas coloured per IFC class, with the model colours as shown in the viewer (including colours you chose, e.g. from a filter), with the original IFC colours, or in black and white, title block, scale bar, and optionally the view behind the cut as a background.
- **DXF (R12):** one layer per IFC class, coordinates in metres. Plan sections use the real IFC X/Y coordinates, so they line up with other drawings.

### Alignments and stationing (IFC4x3)
Models with `IfcAlignment` show the alignment in 3D with station marks (**Visibility → Show alignments**). The vertical profile is computed from the alignment's vertical segments and the start station from `IfcReferent` / `Pset_Stationing`. Spot measurements show **station**, **lateral offset** (left positive, as in IFC) and the **height above the vertical profile**, and distances show the station range. Stations are written as `km+m` (`1+234.567`) or in metres. Under **Visibility → Stationing** the station marks can be automatic, every 1–1000 m, any other interval, or off (only the line).

### Measure
**Measure** (toolbar or `M`) opens the measuring panel with three tools:
- **Distance:** point to point. *Lock X/Y* keeps the second point on the vertical line through the first point, so only the height (Z) is measured. Shows the distance, the horizontal distance, the height difference (ΔZ), ΔX/ΔY and the slope. Dashed lines show the horizontal and vertical components.
- **Length:** a polyline through several points with the length of each segment and the total. Finish with double-click or Enter; Backspace removes the last point.
- **Spot:** coordinates and elevation of a point. Choose which coordinates (X, Y, Z) the label in the 3D view shows. It shows project X/Y/Z (metres, Z up) and the height above the element's storey. If the model is georeferenced with `IfcMapConversion`, it also shows easting/northing/height in the map coordinate system. Otherwise it shows Z plus the site reference elevation (`IfcSite.RefElevation`) when one is set.

Points snap to corners, edge midpoints and edges (shown by the marker shape); snapping can be turned off. Values are shown in m or mm, every measurement can be zoomed to or removed, and *Copy all* copies the values to the clipboard. Points cut away by section planes cannot be picked. With several models, coordinates refer to the first model's coordinate system.

### Map under the model
**Map** drapes an orthophoto (Esri World Imagery) or OpenStreetMap under the models, optionally with an **OpenRailwayMap** layer (infrastructure, max speed, signals, electrification or track gauge).
- If the first model has `IfcMapConversion` (IFC4+), it is used automatically.
- Otherwise enter the coordinate system (EPSG code, e.g. `EPSG:25832`) and, if needed, the map coordinates of the model origin and a rotation. If the model coordinates already are map coordinates (e.g. UTM in metres), leave them at 0.
- Common European systems are built in; other EPSG codes are looked up on epsg.io.
- The map is loaded by the browser from the tile servers (internet needed). The model itself is not sent anywhere. Sources are credited in the corner of the view.

### Edit metadata
Turn on **Edit** (toolbar, properties panel or the `E` key):
- Edit string attributes (`Name`, `Description`, `ObjectType`, `Tag`, `LongName` …) directly in the properties panel.
- Change, add and remove single-value properties in property sets. Values keep their IFC type (label, length, boolean …). New properties can be text, number, integer or yes/no.
- **Batch editing:** select several elements (for example a whole class) and set a property on all of them. Existing values are overwritten, missing properties are added, and elements without the property set get a new one.
- Shared property sets and type property sets are marked, so you can see when a change affects more elements.
- Every model card shows the list of changes. **Download IFC** saves the edited file (`*_edited.ifc`).

### Merge models
**Merge** combines two or more loaded models into a single IFC file (the same result as `ifcpatch` *MergeProjects*). The first model keeps its header, project, units and coordinate system; the projects of the others are replaced by it. Sites, buildings, storeys and other spatial elements with the same GlobalId in several models are combined into one, and their repeated relations are dropped. The merge works directly on the STEP text, streamed in chunks, so it is fast and needs little more memory than the files themselves (about 370 MB in 30 s in a test). The result opens in the viewer and can be downloaded. The models must use the same IFC schema. The merged file takes the length unit of the first model: a model whose unit was corrected is therefore not put first, and models in really different units trigger a warning. Tick *Replace the source models* for very large models: the sources are removed before the merged model is loaded, which saves memory.

In Python scripts, `app.merge(files)` / `merge_models(files)` merges with IfcOpenShell. Files leave Python by being written straight to the in-memory file system (not as one big string), but IfcOpenShell needs roughly 7× the file size in memory and the browser limits Python to 4 GB, so use the *Merge* button for large models.

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
| Move (pan) / select | Left mouse drag / click |
| Rotate | Hold the scroll wheel (middle button), right mouse, or Shift + left |
| Zoom | Scroll – zooms towards the point under the cursor, all the way in |
| Center on point | Double-click |
| Add to / remove from selection | Ctrl + click (Shift + click in lists: range) |
| Zoom to selection | F |
| Hide / isolate / show all | H / I / Shift+H |
| Edit mode | E |
| Measure on/off | M |
| Orthographic / perspective camera | O |
| X-ray | X |
| Walk mode (Esc exits) | W |
| Next / previous storey | Page Up / Page Down |
| Quantity takeoff | Q |
| Finish / undo last point while measuring | Enter / Backspace |
| Run Python script | Ctrl+Enter |
| Clear selection | Esc |

## Development

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # static build in dist/
npm run preview  # preview the build
```

Built with [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (viewing and metadata editing), [Pyodide](https://pyodide.org) + [IfcOpenShell](https://ifcopenshell.org) (Python, merging and IDS), [proj4js](https://proj4js.org), [fflate](https://github.com/101arrowz/fflate) and [CodeMirror](https://codemirror.net). It is a static site with no backend.

| File | Purpose |
| --- | --- |
| `src/main.js` | user interface |
| `src/viewer.js` | three.js scene, picking, sections |
| `src/measure.js` | measuring tools and snapping |
| `src/filters.js` | colour by property and rule-based filters |
| `src/compare.js` | comparison of two model versions |
| `src/ids.js` | IDS checking (ifctester in the Python worker) |
| `src/bcf.js`, `src/issues.js` | BCF read/write and the Issues tab |
| `src/drawing.js` | 2D drawings from section planes (PDF, SVG, DXF) |
| `src/alignment.js` | IFC4x3 alignments and stationing |
| `src/map.js` | map underlay, georeferencing and coordinate conversion (proj4) |
| `src/ifc.js`, `src/model.js` | loading IFC, metadata and metadata editing (web-ifc) |
| `src/python.js`, `src/python-worker.js` | Pyodide/IfcOpenShell worker and merge logic |
| `src/scripting.js`, `src/examples.js` | Python panel and example scripts |
| `src/i18n.js` | translations (en/da/de/hi) |
| `src/config.js` | where Pyodide and the IfcOpenShell wheel are loaded from |

### Python runtime sources

By default Pyodide is loaded from jsDelivr and the IfcOpenShell wheel from `ifcopenshell.github.io/wasm-wheels`. The pure-Python dependencies (`lark`, `isodate`, and for IDS `ifctester`, `xmlschema`, `elementpath`) come from PyPI. To self-host (offline or on an intranet), copy the files and change `src/config.js`, or set an override in the browser:

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

### Installable app (PWA)

The built site has a web app manifest and a service worker (`public/sw.js`). In Chrome or Edge, use *Install* in the address bar to get OnlineIFC as an app with its own window. After the first visit it works offline, and the installed app can open `.ifc` files directly (*Open with* in the file explorer). The service worker only caches the app itself; IFC files never leave the computer. It is only registered in the built app (`npm run build`), not in the dev server.
