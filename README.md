<p align="center">
  <a href="https://vispecta.com"><img src="docs/images/vispecta-banner.png" alt="Vispecta – IFC viewer for infrastructure projects" width="820"></a>
</p>

<p align="center">
  <a href="https://vispecta.com"><b>Open Vispecta</b></a> · <a href="https://vispecta.com/about/">About</a> · Beta · <a href="LICENSE">AGPL-3.0</a> · <a href="CONTRIBUTING.md">Contributing</a>
</p>

# Vispecta

An IFC viewer and editor that runs entirely in the browser. Files are processed locally (WebAssembly) and are never uploaded.

The interface is in **English**, **Danish**, **German** and **Hindi** (language picker in the top right corner; the choice is remembered). There is a light and a dark theme (moon/sun button).

Vispecta is an open-source project by Rasmus Roien Molbaek (AGPL-3.0 licence). It grows out of the challenges I met in my work as an engineer in railway projects: alignments and stationing, cross sections and longitudinal profiles, combining the models of several disciplines, and quick checks of metadata.

## Features
The toolbar groups the functions: **View**, **Section**, **Visibility**, **Alignment** (stationing, cross sections, longitudinal profiles, drive along, draw a line), **Measure**, **Edit** and **Tools** (merge, compare, IDS check, quantity takeoff, Python). On small screens the side panels are drawers over the 3D view.


### Review
- **Open files** (IFC2x3, IFC4, IFC4x3): drag and drop them anywhere in the window at any time, or click the drop area on the start screen / *Open IFC*. Dropped files are recognised by type: `.ifc` models are added to the view, `.bcf`/`.bcfzip` go to *Issues*, `.ids` opens the IDS check, and `.vispecta.json` opens a workspace.
- **Federation:** several models are shown in one view. The first model defines the coordinate system and the following models are placed relative to it using their own coordinates.
- **Groups and aliases:** in the Models tab, *+ New group* makes a named group. Drag model cards onto a group, or choose the group on the card. A group is switched on and off as a whole, and a model is shown when both its own switch and its group's are on. A model can get an alias (✎ or double click); the file name stays visible under it, and the alias is used in the structure tree, menus and dialogs. Cards fold to one line. Projects remember groups, aliases and switches.
- **Wrong length units:** some exporters state a unit that does not match the coordinates, e.g. *millimetre* while the coordinates are metres. Such a model would be 1000× too small and far away from the others. Vispecta detects the clear cases (a model of a few metres at projected coordinates, or two models that only fit together with the correction), corrects the scale and tells you.
- **Sections:** horizontal plan section, vertical sections (X/Y), a section parallel to a clicked face, and a section box around the selection. Every plane can be moved with a slider, stepped with ‹ › by a chosen step length (e.g. 0.5 m), placed at a typed position (↑/↓ in the field steps too), flipped, disabled or removed. Cut faces are shown in a darker tone of the element colour with diagonal hatching, so a cut is easy to tell from a surface. *Colour cut faces* and *Hatch cut faces* in the section panel turn this off (the hatching is remembered).
- **Colours:** colour and opacity per model. *Colour by model* gives every model its own colour; click the colour square on a model card to choose another one. *Original colours* restores the colours from the IFC file. Projects remember the model colours.
- **Colour style** (*View* menu): shows the original colours as *Original*, *Muted*, *Colour-blind friendly*, *Light grey* (nearly white, the shape first) or *Vivid*. The choice is remembered. *Colour-blind friendly* uses the Okabe–Ito palette, whose colours stay apart with the common kinds of colour blindness: every file colour snaps to the Okabe–Ito colour of its hue (greys stay grey), *Colour by model* uses Okabe–Ito colours, and compare and IDS results use blue / vermilion / yellow instead of green / red.
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
- **Storeys:** the *Storeys* menu (shown when the visible models have storeys) lists the storeys per model, highest first, with the elevation. Click one to show it alone, optionally with a plan cut 1.2 m above the floor. ▲ ▼ or Page Up / Page Down step through the storeys, and the menu button shows the storey that is shown.
- **X-ray** (X): everything becomes see-through except the selected elements.
- **Walk mode** (W): first-person view. W/A/S/D or the arrow keys move horizontally, drag to look around, Q/E down/up, Shift is faster, the wheel sets the speed, Esc leaves walk mode.

### Projects (remembered locally)

- Vispecta remembers what you worked on, **only in this browser on this computer** (IndexedDB) – nothing is uploaded. A project is created automatically when you open a model and saved automatically: the IFC files (including metadata edits), the saved views, the issues and the last view (camera, sections, visibility, colours, transparency, X-ray).
- The start screen shows the **recent projects**; click one to continue where you stopped. The *Models* tab shows the current project (rename it there); *Projects* lists all projects with their size, and can start a new project, delete projects, remove the prepared geometry to free space, or turn the saving off.
- **Large models open faster the second time:** the prepared geometry and the spatial structure are stored with the file (in a test 93 MB / 240,000 elements: 15.5 s the first time, 5.2 s from the project). Files are recognised by a fingerprint of their content, so a changed file is prepared again.
- The browser may remove the data when the disk is almost full; Vispecta asks it to keep the data (persistent storage). Clearing the browser's site data removes the projects.

### Saved views and workspace

- **Views tab:** save the current view under a name (camera, sections, visibility, colours, transparency, selection, X-ray) with a thumbnail, and click it to return. Views refer to elements by GlobalId, so they also work on a newer version of the model. They are kept in the browser.
- **Workspace file** (`.vispecta.json`; files from before the rename, `.onlineifc.json`, still open): saves the views, the issues and the current view in one small file to share or to continue later. The IFC files are not included; open them together with the workspace file (or afterwards).

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

**Example IDS files** (in the IDS dialog, or in [`public/examples/ids`](public/examples/ids)) show what a check can do. They can be run directly or downloaded to look inside:

| File | Checks | Try it on |
|---|---|---|
| `01-basic-information.ids` | building elements have a name and lie on a storey; no `IfcBuildingElementProxy` (a *prohibited* specification) | IFC4 building models |
| `02-wall-and-slab-properties.ids` | `Pset_WallCommon` (IsExternal, LoadBearing, FireRating, ThermalTransmittance), `Pset_SlabCommon.LoadBearing`, and a value check: wall width 0.10–1.00 m | IFC4 building models |
| `03-materials-and-classification.ids` | structural parts have a material; building elements have a classification (any system) | IFC4 building models |
| `04-rail-infrastructure.ids` | at least one named `IfcAlignment` (a *required* specification), named referents (stations), signals named and contained in the railway, no proxies | IFC4X3 rail models |

On the FZK house, examples 1–3 give a mix of passes and failures (e.g. the U-value and wall width pass, the fire rating and classification fail).

### Issues (BCF)
The **Issues** tab creates issues from the current view. The camera, section planes, visibility, selection and colours are saved as a BCF viewpoint with a snapshot. Issues have type, status, priority, assignee and comments (optionally with their own view), and clicking an issue restores its view. **Export** writes a `.bcfzip` in BCF 2.1 (default, the most widely supported) or 3.0, validated against the buildingSMART schemas. **Import** reads BCF 2.0, 2.1 and 3.0 files from other tools (BIMcollab, Solibri, Revit, Trimble Connect …).

### 2D drawings
**Section → Export section as drawing** (or **2D** next to a section plane) turns a section into a drawing:
- **PDF/SVG:** true scale on A4–A0 (or fitted), a title block that wraps/shortens long model names so nothing overlaps the scale bar, cut outlines with filled cut areas coloured per IFC class, with the model colours as shown in the viewer (including colours you chose, e.g. from a filter), with the original IFC colours, or in black and white, title block, scale bar, and optionally the view behind the cut as a background.
- **DXF (R12):** one layer per IFC class, coordinates in metres. Plan sections use the real IFC X/Y coordinates, so they line up with other drawings.

### Alignments and stationing (IFC4x3)
Models with `IfcAlignment` show the alignment in 3D with station marks (**Alignment → Show alignments**). The vertical profile is computed from the alignment's vertical segments and the start station from `IfcReferent` / `Pset_Stationing`. Spot measurements show **station**, **lateral offset** (left positive, as in IFC) and the **height above the vertical profile**, and distances show the station range. Stations are written as `km+m` (`1+234.567`) or in metres. Under **Alignment → Stationing** the station marks can be automatic, every 1–1000 m, any other interval, or off (only the line).

**Alignment → Cross section at station** (also in the Section menu) adds a section plane perpendicular to the alignment. Type the station (`1+234.5`, `1+234,5` or `1234.5`) in the plane's field, or step along the alignment with ‹ › and the step length; the plane turns with the curves. With several alignments, choose which one the plane follows. The 2D drawing of a station section uses the offset from the alignment as its x axis (right positive, looking towards higher stations) and shows the axis as a dash-dot line with the station (also in DXF, layer `ALIGNMENT_AXIS`). Saved views and BCF viewpoints bring the station plane back.

**Break points (offset / height):** in the drawing dialog of a vertical section, *Annotate break points* labels the break points of the top outline of the ticked classes. A bend counts from 10°, and short facets of round shapes are skipped. The labels can be a band under the section (rows *Offset* and *Height*, with leaders), texts at the points, or both. Slopes between the points (`2.5 %` or `1:1.5`) can be turned on. Offsets are measured from the alignment axis (right +), or from the left edge of the drawing for other sections. Faces that are vertical get both heights. The annotation is in PDF, SVG and DXF (layer `ANNOTATION_POINTS`), on every page of a series, and live in the section window (⌖).

Cross sections get letters (A–A, B–B …). In 3D and on plan drawings each one is shown as a classic **section mark**: a dash-dot line across the alignment with arrows in the viewing direction and the letter at both ends. Plan drawings also show the alignment axis with station ticks inside the drawing, and a cross section at a station does not cut the plan. In the 2D drawing dialog of a station plane, **Series** writes one PDF page per station (from, to, every x m). All pages use the same scale and extent, with the axis at the same place.

**Section window:** the ▣ button of a section plane opens a window with the live 2D cut of that plane, next to the 3D view. There you step through the sections with ‹ ›, the arrow keys or a typed station, and set the step length. The model shows the section mark of the current cut at the same time. The window has a grid (offset from the axis and height), zoom (wheel), pan (drag), *Fit* (`F`), and shows the coordinates under the cursor. ⧉ pops it out into a browser window of its own, e.g. on a second screen, and closing that window puts it back. With *Section → Sections in a window of their own*, every new section opens there straight away (the browser must allow pop-ups for the page). A key plan in the corner (▦) shows the visible models, the alignments and the cut line with its view direction, and the plane of the window is drawn in the accent colour in the 3D view. Cut faces are hatched here too.

### Longitudinal profile
**Alignment → Longitudinal profile** unrolls the model along an alignment or along a **line you draw**. Choose *Draw a new line*, click points in the view (on elements, or at the height of the last point), then press Enter or double click. Backspace removes the last point and Esc cancels. The visible elements are cut with the vertical surface that follows the path, so the drawing has the station along and the height up. You set the range (from–to station) and the height exaggeration (1–50×). The red line is the vertical profile of the alignment, or the heights of the clicked points of a drawn line. Station and height grid lines are chosen for the paper scale, and the profile heights are written under the stations. The profile is previewed in the dialog and exported as PDF, SVG or DXF (DXF heights are exaggerated like the drawing). Drawn lines also work for cross sections at a station and for driving, and projects remember them.

### Go to station / drive along
**Alignment → Go to station / drive along** puts the camera at eye height on an alignment (or a drawn line), looking ahead. Type a station and press Enter (↑/↓ step), or press ▶ to drive at 5–200 km/h. The camera follows the curves and the vertical profile, and ⇄ changes the direction. Dragging the view or pressing Esc pauses.

### Measure
**Measure** (toolbar or `M`) opens the measuring panel with three tools:
- **Distance:** point to point. *Lock X/Y* keeps the second point on the vertical line through the first point, so only the height (Z) is measured. Shows the distance, the horizontal distance, the height difference (ΔZ), ΔX/ΔY and the slope. Dashed lines show the horizontal and vertical components.
- **Length:** a polyline through several points with the length of each segment and the total. Finish with double-click or Enter; Backspace removes the last point.
- **Spot:** coordinates and elevation of a point. Choose which coordinates (X, Y, Z) the label in the 3D view shows. It shows project X/Y/Z (metres, Z up) and the height above the element's storey. If the model is georeferenced with `IfcMapConversion`, it also shows easting/northing/height in the map coordinate system. Otherwise it shows Z plus the site reference elevation (`IfcSite.RefElevation`) when one is set.

Points snap to corners, edge midpoints and edges (shown by the marker shape); snapping can be turned off. Values are shown in m or mm, every measurement can be zoomed to or removed, and *Copy all* copies the values to the clipboard. Points cut away by section planes cannot be picked. With several models, coordinates refer to the first model's coordinate system.

### Edit metadata
Turn on **Edit** (toolbar, properties panel or the `E` key):
- Edit string attributes (`Name`, `Description`, `ObjectType`, `Tag`, `LongName` …) directly in the properties panel.
- Change, add and remove single-value properties in property sets. Values keep their IFC type (label, length, boolean …). New properties can be text, number, integer or yes/no.
- **Batch editing:** select several elements (for example a whole class) and set a property on all of them. Existing values are overwritten, missing properties are added, and elements without the property set get a new one.
- Shared property sets and type property sets are marked, so you can see when a change affects more elements.
- Every model card shows the list of changes. **Download IFC** saves the edited file (`*_edited.ifc`).

### Merge models
**Tools → Merge models** combines two or more loaded models into a single IFC file (the same result as `ifcpatch` *MergeProjects*). The first model keeps its header, project, units and coordinate system; the projects of the others are replaced by it. Sites, buildings, storeys and other spatial elements with the same GlobalId in several models are combined into one, and their repeated relations are dropped. The merge works directly on the STEP text, streamed in chunks, so it is fast and needs little more memory than the files themselves (about 370 MB in 30 s in a test). The result opens in the viewer and can be downloaded. The models must use the same IFC schema. The merged file takes the length unit of the first model: a model whose unit was corrected is therefore not put first, and models in really different units trigger a warning. Tick *Replace the source models* for very large models: the sources are removed before the merged model is loaded, which saves memory.

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
Notes on performance:
- The 3D view is drawn on demand: while the camera moves, shortly after any input or `viewer.invalidate()`, and otherwise twice a second. An idle view costs almost no GPU time.
- The build puts web-ifc and three.js in files of their own, so an update of the app only re-downloads the small application file. The code editor is loaded when the Python panel is first opened.
- Visual identity: the mark is a cross section (a profile, which is also a V) with the point that looks at it. Colours ("Petrol"): petrol `#0C2A30`, turquoise `#0E8C84` (dark mode `#2CC8BC`, with dark text on it), orange `#F08A24` for alignments and red `#C8372D` for sections. Type: Space Grotesk for headings, Inter for the interface, JetBrains Mono for stations and measured values, bundled with the app via Fontsource (no requests to font services). The icons in `public/icons` are made from `icon.svg` / `maskable.svg`.
- `src/style.css` is organised as tokens, base controls (`.btn`, fields, `.float` panels) and feature sections; new UI should use those instead of local styles.


```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # static build in dist/
npm run preview  # preview the build
```

Built with [three.js](https://threejs.org), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (viewing and metadata editing), [Pyodide](https://pyodide.org) + [IfcOpenShell](https://ifcopenshell.org) (Python and IDS), [fflate](https://github.com/101arrowz/fflate) and [CodeMirror](https://codemirror.net). It is a static site with no backend.

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
| `src/secview.js` | section window: live 2D cut of a plane, stepping, pop-out window |
| `src/ifc.js`, `src/model.js` | loading IFC, metadata and metadata editing (web-ifc) |
| `src/python.js`, `src/python-worker.js` | Pyodide/IfcOpenShell worker and merge logic |
| `src/scripting.js`, `src/examples.js` | Python panel and example scripts |
| `src/i18n.js` | translations (en/da/de/hi) |
| `src/config.js` | where the Python runtime is loaded from |
| `scripts/fetch-python.mjs`, `scripts/python-wheels.json` | collects the Python runtime into `public/py` at build time (pinned, sha256-checked) |

### Python runtime sources

The built site serves the Python runtime itself, so the Python panel and the IDS check contact no other server. `npm run build` first runs `scripts/fetch-python.mjs`, which collects into `public/py` (not committed):

- Pyodide's core files from the pinned npm package `pyodide`;
- the Pyodide packages IfcOpenShell needs (numpy, shapely, micropip …) from the Pyodide distribution, checked against the sha256 in `pyodide-lock.json`;
- IfcOpenShell, its pure-Python dependencies and ifctester, pinned with their sha256 in `scripts/python-wheels.json`.

That is about 58 MB, loaded only when Python or IDS is first used. Packages that are not hosted (e.g. pandas) stay on jsDelivr and are only fetched when a script of your own imports them.

`npm run build:app` builds without collecting the runtime; then (and in `npm run dev` before `npm run fetch-python`) Pyodide comes from jsDelivr, IfcOpenShell from `ifcopenshell.github.io` and the rest from PyPI. To use another mirror, set an override in the browser:

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

The built site has a web app manifest and a service worker (`public/sw.js`). In Chrome or Edge, use *Install* in the address bar to get Vispecta as an app with its own window. After the first visit it works offline, and the installed app can open `.ifc` files directly (*Open with* in the file explorer). The service worker only caches the app itself; IFC files never leave the computer. It is only registered in the built app (`npm run build`), not in the dev server.

## Privacy

Vispecta is a static website without a backend, cookies, analytics or tracking.

- **Your files are never uploaded.** IFC, BCF and IDS files are read and processed in your browser (WebAssembly). Projects and settings are saved only in this browser (IndexedDB, localStorage).
- **What the site loads:** everything – the app, fonts, web-ifc and the Python runtime (Pyodide, IfcOpenShell, ifctester) – comes from vispecta.com itself (hosted on GitHub Pages, which, like any web host, sees the visitor's IP address).
- **Other servers are contacted only when you ask for it:**
  - *Check for updates* in the About dialog asks the GitHub API for the latest release;
  - a Python script of your own that imports a package which is not hosted (e.g. pandas) fetches it from jsDelivr, and `micropip.install` in your script fetches from PyPI.

  No model data is sent in either case.

## Status

Vispecta is in **beta**: not every feature has been tested thoroughly, so expect bugs. Reports are very welcome.

## Contributing

Ideas, bug reports and pull requests are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[GNU AGPL-3.0](LICENSE) © 2026 Rasmus Roien Molbaek

In short (the licence text is what counts):

- **Use it freely**, also at work and in commercial projects – for viewing, checking and drawing your models.
- **Change it and share it**, as long as your version is also under the AGPL-3.0 with its full source code.
- If you **run a changed version as a service** for others (e.g. on a website), its users must be able to get the source code too.
- So nobody can take Vispecta, close it and sell it as their own product.
