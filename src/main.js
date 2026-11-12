import * as THREE from 'three';
// OnlineIFC – user interface.
import { Viewer } from './viewer.js';
import { loadIfcFile } from './ifc.js';
import { isSpatialType, KIND_TYPES } from './model.js';
import { t, getLang, setLang, applyStaticTranslations, fmtNum } from './i18n.js';
import { PythonPanel } from './scripting.js';
import { MeasureTool } from './measure.js';
import { WalkMode } from './walk.js';
import { ViewsPanel } from './views.js';
import { QtoTable } from './qto.js';
import { mergeIfcBlobs } from './merge.js';
import { ContextMenu } from './contextmenu.js';
import { renderVersion } from './version.js';
import { ProjectManager } from './projects.js';
import { MapLayer, COMMON_CRS, normaliseCrs } from './map.js';
import { FilterPanel, keyLabel } from './filters.js';
import { IssuesPanel } from './issues.js';
import { readAlignments, AlignmentLayer, SectionMarks, pointAt, heightAt, project, formatStation } from './alignment.js';
import { computeSection, computeProfile, planeAxes, layout, toSvg, toPdf, toPdfPages, toDxf, renderBackground, SCALES, AXIS_COLOR } from './drawing.js';
import { runIdsCheck, colorIdsResult, idsCsv, specSummary } from './ids.js';
import { compareModels, showComparison, clearComparison, comparisonCsv, geomText, summaryText, CMP_COLORS } from './compare.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};

const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1"/></svg>';
const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#59a14f', '#b07aa1', '#edc948', '#76b7b2', '#ff9da7', '#9c755f', '#bab0ac'];

const viewer = new Viewer($('#viewport'));
const measure = new MeasureTool(viewer, $('#viewport'));
const walk = new WalkMode(viewer);
walk.addEventListener('change', () => {
  $('#viewport').classList.toggle('walking', walk.active);
  if (walk.active) { if (measure.mode) setMeasureMode(null); toast(t('msg.walkHelp'), true); }
  renderStatus();
});
walk.addEventListener('speed', () => renderStatus());
const mapLayer = new MapLayer(viewer);
const alignmentLayer = new AlignmentLayer(viewer, $('#viewport'));
measure.alignments = alignmentLayer;
const state = {
  selection: new Map(), // model -> Set(expressID)
  active: null, // {model, id}
  pickPlaneMode: false,
  spacesVisible: false,
  editMode: false,
  xray: false,
  storey: null, // {model, id} of the storey shown alone
  storeyCut: true, // plan section 1.2 m above the floor of that storey
  treeKeys: new Set(), // tree/class rows selected by the user (for highlighting group rows)
  lastTreeKey: null, // anchor for Shift+click range selection
};

// ===================================================================== language
$('#lang-select').value = getLang();
$('#lang-select').addEventListener('change', (e) => {
  setLang(e.target.value);
  applyStaticTranslations();
  python.translate();
  measure.refresh();
  renderAll();
});
applyStaticTranslations();

// ======================================================================== theme
const THEME_KEY = 'onlineifc.theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function currentTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  return saved === 'dark' || saved === 'light' ? saved : darkQuery.matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
}
darkQuery.addEventListener?.('change', applyTheme);
applyTheme();

// =================================================================== side panels
function setPanelHidden(side, hidden) {
  document.body.classList.toggle(`hide-${side}`, hidden);
  $(`.panel-reopen.${side}`).hidden = !hidden;
  try { localStorage.setItem(`onlineifc.hide-${side}`, hidden ? '1' : ''); } catch { /* ignore */ }
}
for (const side of ['left', 'right']) {
  let v = '';
  try { v = localStorage.getItem(`onlineifc.hide-${side}`) || ''; } catch { /* ignore */ }
  setPanelHidden(side, v === '1');
}

// ======================================================================== files
async function withLoading(fn) {
  const loading = $('#loading');
  loading.hidden = false;
  try { return await fn((msg, frac) => {
    $('#loading-text').textContent = msg;
    $('#loading-bar').style.width = `${Math.round(frac * 100)}%`;
  }); } finally { loading.hidden = true; }
}

async function openFiles(files) {
  const all = [...files];
  const list = all.filter((f) => /\.ifc$/i.test(f.name));
  const workspaces = all.filter((f) => /\.json$/i.test(f.name));
  const bcfs = all.filter((f) => /\.(bcf|bcfzip)$/i.test(f.name));
  const idss = all.filter((f) => /\.ids$/i.test(f.name) || (/\.xml$/i.test(f.name) && $('#ids-dialog').open));
  const rest = all.filter((f) => ![list, workspaces, bcfs, idss].some((g) => g.includes(f)));
  if (rest.length) toast(t('msg.unknownFiles', { names: rest.map((f) => f.name).join(', ') }));
  if (!list.length && !workspaces.length && !bcfs.length && !idss.length) return;
  if (list.length) await openIfcFiles(list);
  for (const w of workspaces) await views.openWorkspace(w);
  for (const b of bcfs) {
    await issues.importFile(b);
    $('.tab[data-tab="issues"]').click();
  }
  if (idss.length) {
    // put the IDS file into the IDS dialog and open it
    const dt = new DataTransfer();
    dt.items.add(idss[0]);
    if (!$('#ids-dialog').open) openIdsDialog();
    if ($('#ids-dialog').open) $('#ids-file').files = dt.files;
  }
}

async function openIfcFiles(list, keys = null) {
  const before = viewer.models.length;
  await withLoading(async (progress) => {
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
      try {
        // the file's fingerprint finds its stored geometry and links it to the current project
        let key = keys?.[i] || null;
        if (!key && projects.enabled) { try { key = await projects.keyOf(file); } catch { key = null; } }
        const model = await loadIfcFile(file, { onProgress: (msg, frac) => progress(prefix + msg, (i + frac) / list.length), geometryCache: key ? projects.geometryCacheFor(key) : null });
        viewer.addModel(model);
        checkUnits(model);
        if (key) projects.modelAdded(model, file, key);
        try { model.alignments = await readAlignments(model); } catch (e) { console.warn('alignments', e); model.alignments = []; }
        // Build the picking index (BVH) in the background so the first click is instant
        setTimeout(() => { try { model.pickTargets(); } catch { /* built on first pick instead */ } }, 300);
        if (state.spacesVisible) model.show(model.spaceIds);
      } catch (err) {
        console.error(err);
        toast(t('msg.loadFailed', { name: file.name, error: err.message || err }));
      }
    }
  });
  afterModelsChanged();
  viewer.fitBox(viewer.sceneBox(), { keepDirection: before > 0 });
}

// ------------------------------------------------------------- length units
// Some exporters write a length unit that does not match the coordinates (e.g. "millimetre" while
// the coordinates are metres). Such a model is shown 1000× too small and far from the others, and the
// view breaks down when zooming. checkUnits() detects the obvious cases and corrects them.
const UNIT_SCALES = [1, 0.001, 0.01, 0.3048];
const unitLabel = (sc) => ({ 1: 'm', 0.001: 'mm', 0.01: 'cm', 0.3048: 'ft' })[+sc.toPrecision(6)] || `${+sc.toPrecision(4)} m`;

/** The model's local origin in metres (as it would be with the unit correction f). */
function modelOrigin(m, f = m.unitFix) {
  return new THREE.Vector3().setFromMatrixPosition(m.rawCoordMatrix.clone().invert()).multiplyScalar(f);
}
/** Corrections that turn the declared unit into one of the usual ones. */
function unitCandidates(m) {
  const s = m.declaredLengthScale ?? 1;
  return UNIT_SCALES.filter((r) => Math.abs(r - s) / r > 1e-6).map((r) => r / s);
}

function checkUnits(model) {
  const others = viewer.models.filter((m) => m !== model);
  const near = (a, fa, b, fb) => modelOrigin(a, fa).distanceTo(modelOrigin(b, fb));
  const toMetre = (m, f) => Math.abs((m.declaredLengthScale ?? 1) * f - 1) < 1e-6;
  let fix = null;
  // 1) on its own: a model of a few metres whose origin lies at projected coordinates (≥ 100 km)
  //    once corrected, or a model of thousands of kilometres
  if (model.unitFix === 1) {
    const size = model.getBox().getSize(new THREE.Vector3()).length();
    for (const f of unitCandidates(model)) {
      const o = modelOrigin(model, f);
      const horiz = Math.max(Math.abs(o.x), Math.abs(o.z));
      if (f > 1 && size < 50 && size * f < 50000 && horiz >= 1e5 && horiz < 2e7) { fix = { model, f }; break; }
      if (f < 1 && size > 1e6 && size * f < 1e5) { fix = { model, f }; break; }
    }
  }
  // 2) compared with the models already loaded: one is very far away, and a unit correction (of
  //    this model or of the other one) brings them together. Corrections to metres are preferred.
  if (!fix && others.length) {
    const d0 = Math.min(...others.map((o) => near(model, model.unitFix, o, o.unitFix)));
    if (d0 > 20000) {
      let best = { score: Infinity };
      // both origins must be at projected coordinates (≥ 100 km from 0,0): scaling moves everything
      // towards 0,0, so a model at a local origin would otherwise "attract" any other model
      const far = (m, f) => { const o = modelOrigin(m, f); return Math.hypot(o.x, o.z) >= 1e5; };
      const consider = (d, m, f) => {
        if (!far(m, f) || !others.concat(model).filter((x) => x !== m).some((x) => far(x, x.unitFix))) return;
        const score = d * (toMetre(m, f) ? 1 : 10); if (d < 5000 && d < d0 / 50 && score < best.score) best = { score, model: m, f };
      };
      for (const o of others) {
        for (const f of unitCandidates(model)) consider(near(model, f, o, o.unitFix), model, f);
        for (const g of unitCandidates(o)) consider(near(model, model.unitFix, o, g), o, g);
      }
      if (best.model) fix = best;
    }
  }
  if (!fix) return;
  viewer.setUnitFix(fix.model, fix.f);
  const declared = fix.model.declaredLengthScale ?? 1;
  toast(t('units.fixed', { name: fix.model.name, declared: unitLabel(declared), shown: unitLabel(declared * fix.f) }));
}

/** Loads IFC bytes (e.g. produced by Python) into the viewer, optionally replacing a model. */
async function loadBytes(name, data, { replace = null } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  let key = null;
  if (projects.enabled) { try { key = await projects.keyOf(blob); } catch { key = null; } }
  const model = await withLoading((progress) => loadIfcFile({ name, data: blob }, { onProgress: progress, geometryCache: key ? projects.geometryCacheFor(key) : null }));
  if (key) { if (replace) projects.modelReplaced(replace, model, blob, key); else projects.modelAdded(model, blob, key); }
  if (replace) {
    viewer.replaceModel(replace, model);
    // Express IDs survive the round trip through IfcOpenShell, so the selection can be kept
    const prev = state.selection.get(replace);
    state.selection.delete(replace);
    if (prev) {
      const kept = [...prev].filter((id) => model.elementIds.has(id) || model.parent.has(id));
      if (kept.length) state.selection.set(model, new Set(kept));
    }
    if (state.active?.model === replace) state.active = { model, id: state.active.id };
    searchIndex.delete(replace);
  } else {
    viewer.addModel(model);
  }
  if (state.spacesVisible) model.show(model.spaceIds);
  afterModelsChanged();
  return model;
}

function updateAlignments() {
  const all = allAlignments();
  // the line being drawn
  if (lineTool.active && lineTool.pts.length >= 2) all.push(makePath('…', lineTool.pts));
  alignmentLayer.set(all);
  $('#alignments-check').textContent = alignmentLayer.visible ? '☑' : '☐';
}

function afterModelsChanged() {
  updateAlignments();
  if (idsResults && idsResults.some((e) => !viewer.models.includes(e.model))) { idsResults = null; renderIds(); }
  if (comparison && (!viewer.models.includes(comparison.oldM) || !viewer.models.includes(comparison.newM))) { comparison = null; renderComparison(); }
  $('#welcome').hidden = viewer.models.length > 0;
  if (!viewer.models.length) renderRecentProjects();
  renderProjectBar();
  if (!viewer.models.length && mapLayer.visible) { mapLayer.remove(); updateMapUi(); }
  renderAll();
}

for (const input of [$('#file-input'), $('#file-input-2')]) {
  input.addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
}

// Drag and drop: files can be dropped anywhere in the window at any time.
// Capture phase, so editors (Python, CodeMirror) and dialogs do not swallow dropped files.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
const endDrag = () => { dragDepth = 0; document.body.classList.remove('dragging'); };
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
}, true);
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0 || !e.relatedTarget) endDrag();
}, true);
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}, true);
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  endDrag();
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
}, true);
window.addEventListener('blur', endDrag);

function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ==================================================================== selection
function select(model, ids, { activeId = null, additive = false, toggle = false, treeKey = null } = {}) {
  if (!additive) { state.selection.clear(); state.treeKeys.clear(); }
  if (treeKey) {
    if (toggle && state.treeKeys.has(treeKey)) state.treeKeys.delete(treeKey);
    else state.treeKeys.add(treeKey);
  }
  if (model) {
    let set = state.selection.get(model);
    if (!set) { set = new Set(); state.selection.set(model, set); }
    for (const id of ids) {
      if (toggle && set.has(id)) set.delete(id);
      else set.add(id);
    }
    if (!set.size) state.selection.delete(model);
  }
  state.active = activeId !== null ? { model, id: activeId } : null;
  if (state.active && toggle && !state.selection.get(model)?.has(activeId)) state.active = null;
  applySelection();
}

function clearSelection() {
  state.selection.clear();
  state.treeKeys.clear();
  state.active = null;
  applySelection();
}

function applySelection() {
  for (const m of viewer.models) m.setSelection(state.selection.get(m) || [], viewer.highlightMaterial);
  if (state.xray) for (const m of viewer.models) m.setXray(state.selection.get(m) || []);
  for (const el of $$('.node.selected')) el.classList.remove('selected');
  applyTreeSelection();
  if (state.active) treeRegistry.get(`${state.active.model.uid}:${state.active.id}`)?.row.classList.add('selected');
  renderSelBars();
  renderProps();
  renderStatus();
}

/** Selection from tree/class rows: Ctrl/Cmd+click toggles a row, Shift+click selects a range. */
function rowClick(e, key, entry, activeId = null) {
  const toggle = e.ctrlKey || e.metaKey;
  if (e.shiftKey && state.lastTreeKey) {
    const container = entry.row.closest('.tab-body');
    const rows = $$('.node[data-key]', container);
    const i0 = rows.findIndex((r) => r.dataset.key === state.lastTreeKey);
    const i1 = rows.findIndex((r) => r.dataset.key === key);
    if (i0 >= 0 && i1 >= 0) {
      const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
      if (!toggle) { state.selection.clear(); state.treeKeys.clear(); }
      for (const r of rows.slice(a, b + 1)) {
        const en = rowRegistry.get(r.dataset.key);
        if (!en) continue;
        let set = state.selection.get(en.model);
        if (!set) { set = new Set(); state.selection.set(en.model, set); }
        for (const id of en.ids.length ? en.ids : en.selfId != null ? [en.selfId] : []) set.add(id);
        state.treeKeys.add(r.dataset.key);
      }
      state.active = null;
      applySelection();
      return;
    }
  }
  state.lastTreeKey = key;
  const ids = entry.ids.length ? entry.ids : entry.selfId != null ? [entry.selfId] : [];
  select(entry.model, ids, { activeId, additive: toggle, toggle, treeKey: key });
}

/** Rows that can take part in multi-selection (tree and class list). */
const rowRegistry = new Map();

/** Hides or shows everything selected; used by the eye of a selected row and by the selection bar. */
function setSelectionVisible(visible) {
  for (const [m, set] of state.selection) visible ? m.show(set) : m.hide(set);
  refreshVisibilityUi();
}

function renderSelBars() {
  const n = selectionCount();
  for (const bar of $$('.sel-bar')) {
    bar.querySelector('.sel-count').textContent = n ? t('sel.count', { n: fmtNum(n) }) : t('sel.hint');
    for (const b of $$('button[data-needs-sel]', bar)) b.disabled = !n;
  }
}

function selectionCount() {
  let n = 0;
  for (const s of state.selection.values()) n += s.size;
  return n;
}

viewer.addEventListener('pick', ({ hit, originalEvent: e }) => {
  if (lineTool.active) { lineToolClick(hit, e); return; }
  if (measure.mode && !state.pickPlaneMode) {
    measure.handleClick(e.clientX, e.clientY);
    return;
  }
  if (state.pickPlaneMode) {
    if (hit?.normal) {
      // Put the plane 2 cm behind the face so the cut becomes visible.
      const n = hit.normal.clone().normalize();
      viewer.addPlane('custom', { normal: n, point: hit.point.clone().addScaledVector(n, -0.02) });
      renderPlanes();
    }
    setPickPlaneMode(false);
    return;
  }
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  if (!hit) { if (!additive) clearSelection(); return; }
  select(hit.model, [hit.id], { activeId: hit.id, additive, toggle: additive });
  revealInTree(hit.model, hit.id);
});

// ================================================================= context menu
// Right click (without dragging) in the 3D view or on a row of the Structure / Classes lists.
const contextMenu = new ContextMenu({
  viewer, h, toast, state,
  select: (map, { activeId = null, model = null } = {}) => {
    state.selection.clear();
    state.treeKeys.clear();
    for (const [m, ids] of map) if (ids.length) state.selection.set(m, new Set(ids));
    state.active = activeId !== null && model ? { model, id: activeId } : null;
    applySelection();
    if (state.active) revealInTree(model, activeId);
  },
  refresh: () => { refreshVisibilityUi(); renderStatus(); },
  showAll: () => showAll(),
  clearSelection: () => clearSelection(),
  fitIds: (map) => {
    if (!map) { viewer.fitBox(viewer.sceneBox()); return; }
    const box = new THREE.Box3();
    for (const [m, ids] of map) box.union(m.getBox(ids));
    if (!box.isEmpty()) viewer.fitBox(box);
  },
  setModelVisible: (m, on) => { m.setVisible(on); renderModels(); refreshVisibilityUi(); },
});
viewer.addEventListener('context', ({ hit, originalEvent: e }) => {
  if (measure.mode || state.pickPlaneMode || walk.active) return;
  contextMenu.openForHit(hit, e.clientX, e.clientY);
});
for (const list of [$('#tab-tree'), $('#tab-classes')]) {
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.node[data-key]');
    const entry = row && rowRegistry.get(row.dataset.key);
    if (!entry) return;
    e.preventDefault();
    const ids = entry.ids.length ? entry.ids : entry.selfId != null ? [entry.selfId] : [];
    contextMenu.openForRow({ model: entry.model, ids }, row.querySelector('.lbl')?.textContent || '', e.clientX, e.clientY);
  });
}

// ====================================================================== toolbar
document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('.menu-btn');
  if (menuBtn) { toggleMenu(menuBtn); return; }
  if (!e.target.closest('.menu-pop')) closeMenus();
  const btn = e.target.closest('[data-action],[data-view],[data-plane]');
  if (!btn) return;
  if (btn.closest('.menu-pop')) closeMenus();
  if (btn.dataset.view) return viewer.setView(btn.dataset.view);
  if (btn.dataset.plane) {
    if (!viewer.models.length) return toast(t('msg.loadFirst'));
    viewer.addPlane(btn.dataset.plane);
    return renderPlanes();
  }
  const actions = {
    'plane-station': () => addStationPlane(),
    profile: () => openProfileDialog(),
    'prof-show': () => showProfile(),
    'prof-export': () => exportProfile(btn.dataset.fmt),
    'prof-draw': () => { $('#profile-dialog').close(); startLineTool((path) => openProfileDialog(path)); },
    'prof-remove-line': () => { const al = profilePath(); if (al?.drawn && confirm(t('line.removeConfirm', { name: al.name }))) { removeDrawnPath(al); openProfileDialog(); } },
    drive: () => openDrive(),
    'drive-play': () => setDrivePlaying(!drive.playing),
    'drive-dir': () => { drive.dir = -drive.dir; $('#drive-dir').textContent = drive.dir > 0 ? '→' : '←'; drivePose(); },
    'drive-close': () => closeDrive(),
    fit: () => fitSelection(),
    'fit-all': () => viewer.fitAll(),
    'sel-hide': () => hideSelected({ keepSelection: true }),
    'sel-show': () => setSelectionVisible(true),
    'sel-isolate': () => isolateSelected(),
    'sel-clear': () => clearSelection(),
    'sel-opacity-reset': () => {
      if (state.selection.size) for (const [m, set] of state.selection) m.setElementOpacity(set, 1);
      else for (const m of viewer.models) m.resetElementOpacity();
      for (const r of $$('[data-sel-opacity]')) r.value = '1';
    },
    theme: () => {
      try { localStorage.setItem(THEME_KEY, currentTheme() === 'dark' ? 'light' : 'dark'); } catch { /* ignore */ }
      applyTheme();
    },
    projects: () => openProjectsDialog(),
    'project-rename': async () => {
      if (!projects.current) { await projects.saveNow(); if (!projects.current) return toast(t('proj.off')); }
      const n = prompt(t('proj.renamePrompt'), projects.current.name);
      if (n && n.trim()) projects.rename(projects.current.id, n.trim());
    },
    'project-new': async () => {
      if (viewer.models.length && !confirm(t('proj.newConfirm'))) return;
      await projects.close();
      $('#projects-dialog').close();
    },
    'proj-clear-cache': async () => { await projects.clearGeometryCache(); renderProjectsDialog(); toast(t('proj.cacheCleared'), true); },
    about: () => { renderVersion($('#about-version'), h); $('#about-dialog').showModal(); },
    'toggle-left': () => setPanelHidden('left', !document.body.classList.contains('hide-left')),
    'toggle-right': () => setPanelHidden('right', !document.body.classList.contains('hide-right')),
    map: () => openMapDialog(),
    compare: () => openCompareDialog(),
    ids: () => openIdsDialog(),
    drawing: () => openDrawingDialog(),
    'drawing-cancel': () => $('#drawing-dialog').close(),
    'drawing-run': () => exportDrawing(),
    'ids-cancel': () => $('#ids-dialog').close(),
    'ids-run': () => runIds(),
    'compare-cancel': () => $('#compare-dialog').close(),
    'compare-run': () => runCompare(),
    'map-close': () => $('#map-dialog').close(),
    'map-show': () => showMap(),
    'map-remove': () => { mapLayer.remove(); updateMapUi(); $('#map-dialog').close(); },
    'plane-face': () => {
      if (!viewer.models.length) return toast(t('msg.loadFirst'));
      setPickPlaneMode(!state.pickPlaneMode);
    },
    'section-box': () => {
      if (!viewer.models.length) return toast(t('msg.loadFirst'));
      viewer.clearPlanes();
      viewer.addSectionBox(selectionBox() || viewer.sceneBox());
      renderPlanes();
    },
    'clear-planes': () => { viewer.clearPlanes(); renderPlanes(); },
    hide: () => hideSelected(),
    isolate: () => isolateSelected(),
    'show-all': () => showAll(),
    'toggle-spaces': () => toggleSpaces(),
    'toggle-ortho': () => { if (walk.active) walk.stop(); setOrtho(!viewer.isOrtho); },
    walk: () => walk.toggle(),
    qto: () => qto.open(),
    'toggle-xray': () => setXray(!state.xray),
    'storey-cut': () => { state.storeyCut = !state.storeyCut; renderStoreyItems(); if (state.storey) showStorey(state.storey); },
    'toggle-alignments': () => {
      if (!viewer.models.some((m) => m.alignments?.length)) return toast(t('aln.none'));
      alignmentLayer.setVisible(!alignmentLayer.visible);
      $('#alignments-check').textContent = alignmentLayer.visible ? '☑' : '☐';
    },
    'toggle-edit': () => setEditMode(!state.editMode),
    merge: () => openMergeDialog(),
    'merge-cancel': () => $('#merge-dialog').close(),
    'merge-run': () => runMerge(),
    'toggle-python': () => python.toggle(),
    'toggle-measure': () => setMeasureMode(measure.mode ? null : lastMeasureMode),
    'measure-close': () => { setMeasureMode(null); measurePanelClosed = true; renderMeasure(); },
    'measure-clear': () => measure.clear(),
    'measure-copy': () => { navigator.clipboard?.writeText(measure.toText()); toast(t('measure.copied'), true); },
    screenshot: () => download(`onlineifc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`, dataUrlToBlob(viewer.screenshot())),
    help: () => $('#help-dialog').showModal(),
    'color-by-model': () => {
      viewer.models.forEach((m, i) => m.setColor(PALETTE[i % PALETTE.length]));
      renderModels();
    },
    'reset-colors': () => { for (const m of viewer.models) m.setColor(null); renderModels(); },
  };
  actions[btn.dataset.action]?.();
});

// Drop-down menus in the toolbar. The pop-ups are positioned 'fixed' because the toolbar scrolls sideways.
function toggleMenu(btn) {
  const pop = btn.parentElement.querySelector('.menu-pop');
  const open = pop.hidden;
  closeMenus();
  if (!open) return;
  if (pop.dataset.pop === 'view') renderStoreyItems();
  const r = btn.getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = `${r.bottom + 4}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  btn.classList.add('open');
}

function closeMenus() {
  for (const p of $$('.menu-pop')) p.hidden = true;
  for (const b of $$('.menu-btn.open')) b.classList.remove('open');
}
window.addEventListener('resize', closeMenus);
$('.toolbar').addEventListener('scroll', closeMenus);

function dataUrlToBlob(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: head.slice(5, head.indexOf(';')) });
}

function setPickPlaneMode(on) {
  state.pickPlaneMode = on;
  $('[data-action="plane-face"]').classList.toggle('on', on);
  $('#viewport').classList.toggle('picking', on);
  const hint = $('#mode-hint');
  hint.hidden = !on;
  hint.textContent = t('planes.faceHint');
}

function setEditMode(on) {
  state.editMode = on;
  for (const b of $$('[data-action="toggle-edit"]')) b.classList.toggle('on', on);
  document.body.classList.toggle('editing', on);
  renderProps();
}

function selectionBox() {
  if (!state.selection.size) return null;
  let box = null;
  for (const [m, set] of state.selection) {
    const b = m.getBox([...set]);
    if (b.isEmpty()) continue;
    box = box ? box.union(b) : b;
  }
  return box;
}

function fitSelection() {
  const box = selectionBox();
  if (box && !box.isEmpty()) viewer.fitBox(box);
  else viewer.fitAll();
}

function hideSelected({ keepSelection = false } = {}) {
  if (!state.selection.size) return toast(t('msg.selectFirst'));
  for (const [m, set] of state.selection) m.hide(set);
  if (!keepSelection) clearSelection();
  refreshVisibilityUi();
}

function isolateSelected() {
  if (!state.selection.size) return toast(t('msg.selectFirst'));
  for (const m of viewer.models) m.isolate(state.selection.get(m) || []);
  refreshVisibilityUi();
}

function showAll() {
  for (const m of viewer.models) m.showAll({ includeSpaces: state.spacesVisible });
  refreshVisibilityUi();
}

function toggleSpaces() {
  state.spacesVisible = !state.spacesVisible;
  for (const m of viewer.models) {
    if (state.spacesVisible) m.show(m.spaceIds);
    else m.hide(m.spaceIds);
  }
  updateSpacesUi();
  refreshVisibilityUi();
}

function updateSpacesUi() {
  $('#spaces-check').textContent = state.spacesVisible ? '☑' : '☐';
}

document.addEventListener('keydown', (e) => {
  if (lineTool.active && !e.target.closest('input, textarea, select')) {
    if (e.key === 'Enter') { e.preventDefault(); finishLineTool(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); finishLineTool(false); return; }
    if (e.key === 'Backspace') { e.preventDefault(); lineTool.pts.pop(); updateAlignments(); return; }
  }
  if (e.key === 'Escape' && drive.playing) { setDrivePlaying(false); return; }
  if (e.target.closest('input, textarea, select, .cm-editor')) return;
  if (e.key === 'Escape') {
    if ($$('.menu-pop').some((p) => !p.hidden)) closeMenus();
    else if (state.pickPlaneMode) setPickPlaneMode(false);
    else if (measure.cancel()) { /* handled by the measure tool */ }
    else clearSelection();
  } else if (e.key === 'f' || e.key === 'F') fitSelection();
  else if (e.key === 'H' && e.shiftKey) showAll();
  else if (e.key === 'h') hideSelected();
  else if (e.key === 'i' || e.key === 'I') isolateSelected();
  else if (e.key === 'e' || e.key === 'E') setEditMode(!state.editMode);
  else if (e.key === 'm' || e.key === 'M') setMeasureMode(measure.mode ? null : lastMeasureMode);
  else if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey) { if (!walk.active) setOrtho(!viewer.isOrtho); }
  else if ((e.key === 'w' || e.key === 'W') && !e.ctrlKey && !e.metaKey) walk.toggle();
  else if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) setXray(!state.xray);
  else if ((e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey) qto.open();
  else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); stepStorey(e.key === 'PageUp' ? 1 : -1); }
  else if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); $('#file-input').click(); }
});

// ========================================================================= tabs
for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === tab);
    for (const b of $$('.tab-body')) b.classList.toggle('active', b.id === `tab-${tab.dataset.tab}`);
    if (tab.dataset.tab === 'filters') filters.render();
    if (tab.dataset.tab === 'issues') issues.render();
    if (tab.dataset.tab === 'views') views.render();
  });
}

function renderAll() {
  filters.render();
  issues.render();
  views.render();
  renderModels();
  renderTree();
  renderClasses();
  renderPlanes();
  applySelection();
}

function refreshVisibilityUi() {
  refreshTreeEyes();
  renderClasses();
  renderStatus();
}

// ======================================================================= models
/** File name with line-break opportunities after _ - . (long names without spaces wrap nicely). */
function breakableName(name) {
  const out = [];
  for (const part of name.split(/(?<=[_\-.])/)) out.push(part, document.createElement('wbr'));
  out.pop();
  return out;
}

function renderModels() {
  const list = $('#model-list');
  list.replaceChildren();
  $('#models-empty').hidden = viewer.models.length > 0;
  $('#model-actions').hidden = viewer.models.length === 0;

  for (const m of viewer.models) {
    const colorInput = h('input', { type: 'color', value: m.overrideColor ? `#${m.overrideColor.getHexString()}` : '#b0b0b0', title: t('models.color') });
    const dot = h('span', { class: 'swatch-dot' });
    dot.style.background = m.overrideColor ? `#${m.overrideColor.getHexString()}` : 'conic-gradient(#e15759, #edc948, #59a14f, #4e79a7, #e15759)';
    colorInput.addEventListener('input', () => { m.setColor(colorInput.value); dot.style.background = colorInput.value; });

    const opacity = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(m.opacity) });
    const opVal = h('span', { class: 'muted', text: `${Math.round(m.opacity * 100)} %` });
    opacity.addEventListener('input', () => { m.setOpacity(+opacity.value); opVal.textContent = `${Math.round(+opacity.value * 100)} %`; });

    const vis = h('input', { type: 'checkbox', title: t('models.visible'), checked: m.visible });
    vis.addEventListener('change', () => { m.setVisible(vis.checked); renderStatus(); });

    const changes = m.changes.length
      ? h('details', { class: 'changes' },
        h('summary', {}, h('span', { class: 'badge-mod', text: t('models.modified', { n: m.changes.length }) })),
        h('ol', {}, m.changes.slice(-50).reverse().map((c) => h('li', { text: c.description }))))
      : null;

    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, vis, dot, h('span', { class: 'card-name', title: m.name }, breakableName(m.name))),
      h('div', { class: 'card-meta', text: `${m.schema} · ${t('models.elements', { n: fmtNum(m.elementIds.size) })} · ${fmtBytes(m.fileSize)}` }),
      changes,
      h('div', { class: 'card-row' }, h('label', { text: t('models.color') }), colorInput,
        h('button', { onclick: () => { m.setColor(null); renderModels(); }, text: t('models.original') })),
      h('div', { class: 'card-row' }, h('label', { text: t('models.transparency') }), opacity, opVal),
      h('div', { class: 'card-btns' },
        h('button', { onclick: () => viewer.fitBox(m.getBox()), text: t('models.zoom') }),
        h('button', { class: m.changes.length ? 'primary-outline' : null, onclick: () => saveIfc(m), text: t('models.downloadIfc') }),
        h('button', { onclick: () => exportCsv(m), text: t('models.exportCsv') }),
        h('button', {
          onclick: () => {
            const msg = m.changes.length ? t('models.removeUnsaved', { name: m.name }) : t('models.removeConfirm', { name: m.name });
            if (!confirm(msg)) return;
            state.selection.delete(m);
            if (state.active?.model === m) state.active = null;
            viewer.removeModel(m);
            afterModelsChanged();
          },
          text: t('models.remove'),
        }),
      ),
    );
    list.append(card);
  }
}

async function saveIfc(model) {
  const name = model.changes.length ? model.name.replace(/(\.ifc)?$/i, '_edited.ifc') : model.name;
  download(name, await model.getBytes(), 'application/x-step');
}

async function exportCsv(model) {
  try {
    await withLoading(async (progress) => {
      progress(t('csv.collecting', { name: model.name }), 0);
      const { cols, rows } = await model.exportRows((f) => progress(t('csv.collecting', { name: model.name }), f));
      const esc = (v) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = '﻿' + [cols.map(esc).join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
      download(model.name.replace(/\.ifc$/i, '') + '-properties.csv', csv, 'text/csv;charset=utf-8');
    });
  } catch (e) {
    console.error(e);
    toast(t('msg.exportFailed', { error: e.message || e }));
  }
}

// ========================================================================= tree
const treeRegistry = new Map(); // key -> {row, expand, ids}

function descendantIds(model, node, out = []) {
  if (model.elementIds.has(node.expressID)) out.push(node.expressID);
  for (const c of node.children || []) descendantIds(model, c, out);
  return out;
}

function renderTree() {
  treeRegistry.clear();
  for (const k of [...rowRegistry.keys()]) if (k.startsWith('tree:')) rowRegistry.delete(k);
  const root = $('#tree');
  root.replaceChildren();
  const q = $('#tree-search').value.trim();
  if (q) return renderTreeSearch(q);
  if (!viewer.models.length) {
    root.append(h('div', { class: 'empty-hint', text: t('tree.empty') }));
    return;
  }
  const ul = h('ul');
  for (const m of viewer.models) {
    const modelNode = { expressID: -1, children: [m.tree] };
    ul.append(treeNode(m, modelNode, { open: true, label: m.name, rootModel: true }));
  }
  root.append(h('div', { class: 'tree' }, ul));
}

function treeNode(model, node, { open = false, label = null, cls = null, rootModel = false, groupKey = null, groupChildren = null } = {}) {
  const id = node.expressID;
  const children = groupChildren || node.children || [];
  const hasKids = children.length > 0;
  const ids = groupChildren ? groupChildren.flatMap((c) => descendantIds(model, c)) : descendantIds(model, node);

  const caret = h('span', { class: 'caret', text: hasKids ? '▸' : '' });
  const eye = h('button', { class: 'eye', title: t('tree.toggleVisibility') });
  const typeName = rootModel ? 'Model' : cls ?? model.typeName(id);
  const text = label ?? model.label(id);
  const row = h('div', { class: `node${rootModel ? ' model-root' : ''}` },
    caret,
    ids.length ? eye : h('span', { class: 'eye' }),
    h('span', { class: 'lbl', text }),
    !rootModel && !groupChildren && text !== typeName ? h('span', { class: 'cls', text: typeName }) : null,
    groupChildren ? h('span', { class: 'count', text: String(groupChildren.length) }) : null,
  );
  const li = h('li', {}, row);
  let childUl = null;
  let expanded = false;

  const expand = () => {
    if (!hasKids || expanded) return;
    expanded = true;
    caret.textContent = '▾';
    childUl = h('ul');
    renderChildren(model, node, children, childUl, !!groupChildren);
    li.append(childUl);
    applyTreeSelection();
  };
  const collapse = () => {
    expanded = false;
    caret.textContent = '▸';
    childUl?.remove();
    childUl = null;
  };
  caret.addEventListener('click', (e) => { e.stopPropagation(); expanded ? collapse() : expand(); });
  row.addEventListener('dblclick', (e) => { e.stopPropagation(); const b = model.getBox(ids); if (!b.isEmpty()) viewer.fitBox(b); });
  const key = groupKey ?? (rootModel ? `${model.uid}:model` : `${model.uid}:${id}`);
  const rowKey = `tree:${key}`;
  row.dataset.key = rowKey;
  const entry = { row, expand, ids, eye, model, selfId: rootModel || groupChildren ? null : id };
  row.addEventListener('click', (e) => rowClick(e, rowKey, entry, rootModel || groupChildren ? null : id));
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    eyeClick(model, ids, rowKey);
  });
  treeRegistry.set(key, entry);
  rowRegistry.set(rowKey, entry);
  updateEye(treeRegistry.get(key));
  if (open) expand();
  return li;
}

function renderChildren(model, node, children, ul, isGroup) {
  const parentSpatial = !isGroup && node.expressID !== -1 && isSpatialType(model.typeName(node.expressID));
  if (!parentSpatial) {
    // Long lists (e.g. thousands of walls) are rendered 500 rows at a time
    const CHUNK = 500;
    let shown = 0;
    const more = () => {
      const end = Math.min(children.length, shown + CHUNK);
      const frag = document.createDocumentFragment();
      for (; shown < end; shown++) frag.append(treeNode(model, children[shown], { open: node.expressID === -1 }));
      ul.append(frag);
      if (shown < children.length) {
        const btn = h('li', {}, h('button', { class: 'link tree-more', text: t('tree.showMore', { n: fmtNum(Math.min(CHUNK, children.length - shown)), rest: fmtNum(children.length - shown) }) }));
        btn.firstChild.addEventListener('click', (e) => { e.stopPropagation(); btn.remove(); more(); applyTreeSelection(); refreshTreeEyes(); });
        ul.append(btn);
      }
    };
    more();
    return;
  }
  // Under spatial nodes: spatial children first, then elements grouped by class
  const groups = new Map();
  for (const c of children) {
    const t0 = model.typeName(c.expressID);
    if (isSpatialType(t0)) ul.append(treeNode(model, c, { open: t0 === 'IfcSite' || t0 === 'IfcBuilding' }));
    else {
      if (!groups.has(t0)) groups.set(t0, []);
      groups.get(t0).push(c);
    }
  }
  for (const [ty, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    ul.append(treeNode(model, node, { label: ty, cls: ty, groupChildren: list, groupKey: `${model.uid}:${node.expressID}:cls:${ty}` }));
  }
}

function updateEye(entry) {
  if (!entry?.eye || !entry.ids.length) return;
  const allHidden = entry.ids.every((x) => entry.model.isHidden(x));
  entry.eye.innerHTML = allHidden ? EYE_OFF : EYE;
  entry.eye.classList.toggle('off', allHidden);
  entry.row.classList.toggle('dim', allHidden);
}

function refreshTreeEyes() { for (const e of treeRegistry.values()) updateEye(e); }

function applyTreeSelection() {
  for (const [m, set] of state.selection) for (const id of set) treeRegistry.get(`${m.uid}:${id}`)?.row.classList.add('selected');
  for (const k of state.treeKeys) rowRegistry.get(k)?.row.classList.add('selected');
}

/** Eye button: on a selected row it applies to the whole selection, otherwise just to that row. */
function eyeClick(model, ids, rowKey) {
  const rowSelected = state.treeKeys.has(rowKey) && selectionCount() > 0;
  if (rowSelected) {
    let allHidden = true;
    for (const [m, set] of state.selection) for (const x of set) if (!m.isHidden(x)) { allHidden = false; break; }
    setSelectionVisible(allHidden);
    return;
  }
  const allHidden = ids.every((x) => model.isHidden(x));
  if (allHidden) model.show(ids); else model.hide(ids);
  refreshVisibilityUi();
}

function revealInTree(model, id) {
  if ($('#tree-search').value.trim()) return;
  const chain = [];
  let p = model.parent.get(id);
  while (p !== undefined) { chain.unshift(p); p = model.parent.get(p); }
  treeRegistry.get(`${model.uid}:model`)?.expand();
  for (let i = 0; i < chain.length; i++) {
    treeRegistry.get(`${model.uid}:${chain[i]}`)?.expand();
    const next = chain[i + 1] ?? id;
    if (isSpatialType(model.typeName(chain[i])) && !isSpatialType(model.typeName(next))) {
      treeRegistry.get(`${model.uid}:${chain[i]}:cls:${model.typeName(next)}`)?.expand();
    }
  }
  const entry = treeRegistry.get(`${model.uid}:${id}`);
  if (entry) {
    entry.row.classList.add('selected');
    if ($('#tab-tree').classList.contains('active')) entry.row.scrollIntoView({ block: 'nearest' });
  }
}

// Search in the tree
const searchIndex = new Map(); // model -> {version, items}
function buildIndex(model) {
  const cached = searchIndex.get(model);
  if (cached && cached.version === model.version) return cached.items;
  const out = [];
  const walk = (n) => {
    const line = (() => { try { return model.api.GetLine(model.modelID, n.expressID, false); } catch { return null; } })();
    const name = model.label(n.expressID);
    const cls = model.typeName(n.expressID);
    const guid = line?.GlobalId?.value || '';
    const tag = line?.Tag?.value || '';
    out.push({ id: n.expressID, name, cls, hay: `${name} ${cls} ${guid} ${tag} #${n.expressID}`.toLowerCase() });
    for (const c of n.children || []) walk(c);
  };
  walk(model.tree);
  searchIndex.set(model, { version: model.version, items: out });
  return out;
}

function renderTreeSearch(q) {
  const root = $('#tree');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const ul = h('ul');
  let total = 0;
  const LIMIT = 500;
  for (const m of viewer.models) {
    for (const item of buildIndex(m)) {
      if (!terms.every((x) => item.hay.includes(x))) continue;
      total++;
      if (total > LIMIT) continue;
      const row = h('div', { class: 'node' },
        h('span', { class: 'caret' }),
        h('span', { class: 'lbl', text: item.name }),
        h('span', { class: 'cls', text: item.cls }),
        viewer.models.length > 1 ? h('span', { class: 'count', text: m.name }) : null,
      );
      const ids = m.elementIds.has(item.id) ? [item.id] : [];
      const rowKey = `tree:${m.uid}:${item.id}`;
      row.dataset.key = rowKey;
      const entry = { row, expand: () => {}, ids, model: m, selfId: item.id };
      row.addEventListener('click', (e) => rowClick(e, rowKey, entry, item.id));
      row.addEventListener('dblclick', () => { const b = m.getBox([item.id]); if (!b.isEmpty()) viewer.fitBox(b); });
      treeRegistry.set(`${m.uid}:${item.id}`, entry);
      rowRegistry.set(rowKey, entry);
      ul.append(h('li', {}, row));
    }
  }
  root.append(h('div', { class: 'muted', style: 'padding:0 4px 6px', text: total > LIMIT ? t('tree.resultsLimited', { n: fmtNum(total), limit: LIMIT }) : t('tree.results', { n: fmtNum(total) }) }));
  root.append(h('div', { class: 'tree' }, ul));
  applyTreeSelection();
}

let searchTimer = null;
$('#tree-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTree, 250);
});

// ====================================================================== classes
function renderClasses() {
  const root = $('#classes');
  root.replaceChildren();
  if (!viewer.models.length) {
    root.append(h('div', { class: 'empty-hint', text: t('classes.empty') }));
    return;
  }
  for (const k of [...rowRegistry.keys()]) if (k.startsWith('cls:')) rowRegistry.delete(k);
  for (const m of viewer.models) {
    const ul = h('ul');
    for (const [cls, ids] of [...m.classes].sort((a, b) => a[0].localeCompare(b[0]))) {
      const rowKey = `cls:${m.uid}:${cls}`;
      const allHidden = ids.every((x) => m.isHidden(x));
      const eye = h('button', { class: `eye${allHidden ? ' off' : ''}`, title: t('classes.toggle') });
      eye.innerHTML = allHidden ? EYE_OFF : EYE;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cls === 'IfcSpace' && !state.spacesVisible && ids.every((x) => m.isHidden(x))) { state.spacesVisible = true; updateSpacesUi(); }
        eyeClick(m, ids, rowKey);
      });
      const row = h('div', { class: `node${allHidden ? ' dim' : ''}`, 'data-key': rowKey }, eye, h('span', { class: 'lbl', text: cls }), h('span', { class: 'count', text: fmtNum(ids.length) }));
      const entry = { row, ids, model: m, selfId: null };
      rowRegistry.set(rowKey, entry);
      if (state.treeKeys.has(rowKey)) row.classList.add('selected');
      row.addEventListener('click', (e) => rowClick(e, rowKey, entry));
      row.addEventListener('dblclick', () => { const b = m.getBox(ids); if (!b.isEmpty()) viewer.fitBox(b); });
      ul.append(h('li', {}, row));
    }
    root.append(h('div', { class: 'tree' }, h('div', { class: 'node model-root' }, h('span', { class: 'lbl', text: m.name })), ul));
  }
}

// =================================================================== properties
let propsToken = 0;
async function renderProps({ keepScroll = false } = {}) {
  const token = ++propsToken;
  const root = $('#props');
  const scroll = root.scrollTop;
  const count = selectionCount();
  if (!state.active && !count) {
    root.replaceChildren(h('div', { class: 'empty-hint', text: t('props.empty') }));
    return;
  }

  const parts = [];
  if (count > 1 || !state.active) {
    const byClass = new Map();
    for (const [m, set] of state.selection) for (const id of set) {
      const ty = m.typeName(id);
      byClass.set(ty, (byClass.get(ty) || 0) + 1);
    }
    parts.push(h('div', { class: 'prop-head' },
      h('div', { class: 'cls', text: t('props.selection') }),
      h('div', { class: 'name', text: t('props.nSelected', { n: fmtNum(count) }) }),
      h('ul', { class: 'multi-list' }, [...byClass].sort((a, b) => b[1] - a[1]).map(([ty, n]) => h('li', {}, h('span', { text: ty }), h('span', { class: 'muted', text: fmtNum(n) })))),
    ));
    parts.push(selectionTotals());
  }

  if (state.editMode && count > 0) parts.push(batchForm());
  else if (!state.editMode && count > 1) {
    parts.push(h('button', { class: 'btn sm hint-btn', onclick: () => setEditMode(true), text: t('props.editHint') }));
  }

  if (state.active) {
    const { model, id } = state.active;
    let data;
    try {
      data = await model.getElementData(id);
    } catch (e) {
      console.error(e);
      parts.push(h('div', { class: 'empty-hint', text: t('props.readFailed', { error: e.message }) }));
    }
    if (token !== propsToken) return;
    if (data) {
      const guidBtn = h('button', { text: t('props.copy'), onclick: () => { navigator.clipboard?.writeText(data.guid); guidBtn.textContent = t('props.copied'); } });
      parts.push(h('div', { class: 'prop-head' },
        h('div', { class: 'cls', text: data.cls }),
        h('div', { class: 'name', text: data.name || `#${id}` }),
        data.guid ? h('div', { class: 'guid' }, h('span', { text: data.guid }), guidBtn) : null,
        viewer.models.length > 1 ? h('div', { class: 'muted', text: model.name }) : null,
      ));
      for (const sec of data.sections) parts.push(renderSection(model, id, sec));
    }
  }
  if (token !== propsToken) return;
  root.replaceChildren(...parts.filter(Boolean));
  filterProps();
  if (keepScroll) root.scrollTop = scroll;
}

/** Runs an edit, reports errors and refreshes the UI. */
async function commitEdit(model, fn, { refreshTree = false } = {}) {
  try {
    const result = await fn();
    searchIndex.delete(model);
    renderModels();
    if (refreshTree) renderTree();
    await renderProps({ keepScroll: true });
    return result;
  } catch (e) {
    console.error(e);
    toast(e.message || String(e));
    await renderProps({ keepScroll: true });
    return null;
  }
}

function kindSelect(value = 'text') {
  return h('select', { class: 'kind' }, Object.keys(KIND_TYPES).map((k) => h('option', { value: k, text: t(`kind.${k}`), selected: k === value })));
}

function valueInput(meta) {
  const vt = String(meta.valueType || '').toUpperCase();
  if (vt === 'IFCBOOLEAN' || vt === 'IFCLOGICAL') {
    const sel = h('select', {},
      h('option', { value: 'true', text: t('val.true'), selected: meta.raw === 'true' }),
      h('option', { value: 'false', text: t('val.false'), selected: meta.raw === 'false' }),
      meta.raw === '' ? h('option', { value: '', text: '—', selected: true }) : null);
    return sel;
  }
  return h('input', { type: 'text', value: meta.raw ?? '' });
}

function renderSection(model, elementId, sec) {
  const tbody = h('tbody');
  const editing = state.editMode;
  for (const [k, v, meta] of sec.rows) {
    const valueCell = h('td');
    if (meta?.link !== undefined) {
      const a = h('a', { text: v });
      a.addEventListener('click', () => {
        const node = findNode(model.tree, meta.link);
        const ids = node ? descendantIds(model, node) : [];
        select(model, ids.length ? ids : [meta.link], { activeId: meta.link });
        revealInTree(model, meta.link);
      });
      valueCell.append(a);
    } else if (editing && meta?.attr) {
      const input = h('input', { type: 'text', value: v });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = v; input.blur(); } });
      input.addEventListener('change', () => commitEdit(model, () => model.setAttribute(elementId, meta.attr, input.value), { refreshTree: meta.attr === 'Name' }));
      valueCell.append(input);
    } else if (editing && meta?.propId) {
      const input = valueInput(meta);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', () => commitEdit(model, () => model.setPropertyValue(meta.propId, input.value)));
      const del = h('button', { class: 'icon-btn', title: t('edit.removeProp'), text: '✕' });
      del.addEventListener('click', () => {
        if (!confirm(t('edit.removePropConfirm', { name: k }))) return;
        commitEdit(model, () => model.removeProperty(sec.psetId, meta.propId));
      });
      valueCell.append(h('div', { class: 'edit-cell' }, input, del));
    } else valueCell.textContent = v;
    tbody.append(h('tr', { 'data-k': k.toLowerCase(), 'data-v': String(v).toLowerCase() }, h('td', { text: k }), valueCell));
  }

  if (editing && sec.psetId) {
    const name = h('input', { type: 'text', placeholder: t('edit.propName') });
    const value = h('input', { type: 'text', placeholder: t('edit.value') });
    const kind = kindSelect();
    const add = h('button', { class: 'btn sm primary', text: t('edit.add') });
    add.addEventListener('click', () => commitEdit(model, () => model.addProperty(sec.psetId, name.value.trim(), value.value, kind.value)));
    tbody.append(h('tr', { class: 'add-row', 'data-k': '', 'data-v': '' }, h('td', {}, name), h('td', {}, h('div', { class: 'edit-cell' }, value, kind, add))));
  }

  let badge = String(sec.rows.length);
  let warn = null;
  if (sec.isType && editing && sec.psetId) warn = t('edit.typeShared');
  else if (sec.shared > 1) {
    badge = `${sec.rows.length} · ${t('props.sharedBy', { n: sec.shared })}`;
    if (editing && sec.psetId) warn = t('edit.sharedWarn', { n: sec.shared });
  }
  return h('details', { class: `sec${sec.kind === 'qto' ? ' qto' : ''}${sec.kind === 'calc' ? ' calc' : ''}`, open: sec.open },
    h('summary', {}, h('span', { text: sec.title }), h('span', { class: 'badge', text: badge })),
    warn ? h('div', { class: 'warn', text: warn }) : null,
    sec.note ? h('div', { class: 'sec-note', text: sec.note }) : null,
    h('table', { class: 'props' }, tbody),
  );
}

/** Sums of the calculated quantities of the selected elements. */
function selectionTotals() {
  const tot = { count: 0, volume: 0, area: 0, planArea: 0, length: 0 };
  for (const [m, set] of state.selection) {
    const r = m.sumQuantities(set);
    for (const k of Object.keys(tot)) tot[k] += r[k];
  }
  if (!tot.count) return null;
  const f = (v, d = 3) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const tbody = h('tbody', {}, [
    [t('q.volume'), `${f(tot.volume)} m³`],
    [t('q.area'), `${f(tot.area, 2)} m²`],
    [t('q.planArea'), `${f(tot.planArea, 2)} m²`],
    [t('q.lengthSum'), `${f(tot.length)} m`],
  ].map(([k, v]) => h('tr', { 'data-k': k.toLowerCase(), 'data-v': v.toLowerCase() }, h('td', { text: k }), h('td', { text: v }))));
  return h('details', { class: 'sec calc', open: true },
    h('summary', {}, h('span', { text: t('q.totals') }), h('span', { class: 'badge', text: t('q.count', { n: fmtNum(tot.count) }) })),
    h('div', { class: 'sec-note', text: t('q.note') }),
    h('table', { class: 'props' }, tbody));
}

/** Form for setting a property on all selected elements. */
function batchForm() {
  const count = selectionCount();
  const pset = h('input', { type: 'text', placeholder: 'Pset_…', list: 'pset-names' });
  const prop = h('input', { type: 'text', placeholder: t('edit.propName') });
  const value = h('input', { type: 'text', placeholder: t('edit.value') });
  const kind = kindSelect();
  const apply = h('button', { class: 'btn primary sm', text: t('edit.applyTo', { n: fmtNum(count) }) });
  const datalist = h('datalist', { id: 'pset-names' }, ['Pset_WallCommon', 'Pset_DoorCommon', 'Pset_WindowCommon', 'Pset_SlabCommon', 'Pset_BeamCommon', 'Pset_ColumnCommon', 'Pset_SpaceCommon'].map((n) => h('option', { value: n })));
  apply.addEventListener('click', async () => {
    const psetName = pset.value.trim();
    const propName = prop.value.trim();
    if (!psetName || !propName) return toast(t('err.nameRequired'));
    let total = { edited: 0, added: 0, created: 0, others: 0 };
    for (const [m, set] of state.selection) {
      const r = await commitEdit(m, () => m.setPropertyOnElements([...set], psetName, propName, value.value, kind.value));
      if (!r) return;
      for (const k of Object.keys(total)) total[k] += r[k];
    }
    toast(t('edit.batchDone', total) + (total.others ? ` ${t('edit.batchOthers', { n: total.others })}` : ''), true);
  });
  return h('details', { class: 'batch', open: count > 1 || !state.active },
    h('summary', { class: 'batch-title', text: t('edit.batchTitle', { n: fmtNum(count) }) }),
    h('div', { class: 'batch-grid' },
      h('label', { text: t('edit.pset') }), pset,
      h('label', { text: t('edit.propName') }), prop,
      h('label', { text: t('edit.value') }), h('div', { class: 'edit-cell' }, value, kind)),
    datalist,
    h('div', { class: 'batch-foot' }, h('span', { class: 'muted small', text: t('edit.batchHelp') }), apply),
  );
}

function findNode(node, id) {
  if (node.expressID === id) return node;
  for (const c of node.children || []) { const r = findNode(c, id); if (r) return r; }
  return null;
}

function filterProps() {
  const q = $('#prop-search').value.trim().toLowerCase();
  for (const sec of $$('#props details.sec')) {
    let any = false;
    const titleHit = q && sec.querySelector('summary').textContent.toLowerCase().includes(q);
    for (const tr of $$('tr', sec)) {
      const hit = !q || titleHit || tr.dataset.k.includes(q) || tr.dataset.v.includes(q);
      tr.hidden = !hit;
      any ||= hit;
    }
    sec.hidden = !any;
    if (q && any) sec.open = true;
  }
}
$('#prop-search').addEventListener('input', filterProps);

// ====================================================================== sections
const AXIS_LABEL = { x: 'planes.x', y: 'planes.plan', z: 'planes.y', custom: 'planes.face' };

function renderPlanes() {
  const panel = $('#planes-panel');
  const list = $('#plane-list');
  list.replaceChildren();
  panel.hidden = viewer.planes.length === 0;
  const badge = $('#section-badge');
  badge.hidden = !viewer.planes.length;
  badge.textContent = String(viewer.planes.length);
  renderStatus();
  if (!viewer.planes.length) return;

  for (const p of viewer.planes) {
    if (p.station) { list.append(stationRow(p)); continue; }
    const range = viewer.planeRange(p);
    const step = (range.max - range.min) / 1000;
    const enabled = h('input', { type: 'checkbox', checked: p.enabled, title: t('planes.active') });
    enabled.addEventListener('change', () => viewer.togglePlane(p, enabled.checked));
    const slider = h('input', { type: 'range', min: String(range.min), max: String(range.max), step: String(step), value: String(viewer.getPlanePos(p)) });
    // exact position: type it, or step with the arrow buttons / arrow keys in the field
    const posInput = h('input', { type: 'number', step: 'any', title: t('planes.posTitle') });
    const val = h('div', { class: 'val' }, posInput, h('span', { text: 'm' }));
    const upd = () => { posInput.value = viewer.getPlanePos(p).toFixed(3); slider.value = String(viewer.getPlanePos(p)); };
    const moveTo = (v) => { viewer.setPlanePos(p, v); upd(); };
    slider.addEventListener('input', () => { viewer.setPlanePos(p, +slider.value); posInput.value = viewer.getPlanePos(p).toFixed(3); });
    posInput.addEventListener('change', () => { if (Number.isFinite(+posInput.value) && posInput.value !== '') moveTo(+posInput.value); else upd(); });
    posInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveTo(viewer.getPlanePos(p) + (e.key === 'ArrowUp' ? 1 : -1) * planeStep()); }
    });
    const stepBtn = (dir) => h('button', {
      class: 'step', text: dir > 0 ? '›' : '‹', title: t(dir > 0 ? 'planes.stepFwd' : 'planes.stepBack', { step: fmtNum(planeStep()) }),
      onclick: () => moveTo(viewer.getPlanePos(p) + dir * planeStep()),
    });
    upd();
    const name = p.boxPart ? `${t('planes.boxPart')} ${p.axis === 'y' ? 'Z' : p.axis === 'z' ? 'Y' : 'X'} ${p.boxPart}` : t(AXIS_LABEL[p.axis]);
    list.append(h('div', { class: 'plane-row' },
      enabled,
      h('span', { class: 'pl-name', text: name, title: name }),
      stepBtn(-1),
      slider,
      stepBtn(1),
      h('button', { title: t('planes.flip'), text: '⇄', onclick: () => { viewer.flipPlane(p); renderPlanes(); } }),
      p.boxPart ? null : h('button', { title: t('drw.title'), text: '2D', onclick: () => openDrawingDialog(p) }),
      h('button', { title: t('planes.remove'), text: '✕', onclick: () => { viewer.removePlane(p); renderPlanes(); } }),
      val,
    ));
  }
}
// ------------------------------------------------- cross sections at a station
/** All alignments of the visible models. */
const allAlignments = () => [...viewer.models.filter((m) => m.visible).flatMap((m) => m.alignments || []), ...drawnPaths];

/** Point (world) on the alignment and direction of increasing station at distance s. */
function stationFrame(al, s) {
  const q = pointAt(al, s);
  let z = heightAt(al, s);
  if (z === null) { const box = viewer.sceneBox(); z = box.isEmpty() ? 0 : viewer.toIfc(box.getCenter(new THREE.Vector3())).z; }
  const P = viewer.fromIfc(q.x, q.y, z);
  const T = viewer.fromIfc(q.x + q.dx, q.y + q.dy, z).sub(P).normalize();
  return { P, T };
}

/**
 * Makes `entry` the cross section of `al` at distance s (station = station0 + s). sign: +1 keeps
 * what lies ahead (higher stations), -1 what lies behind; by default the plane keeps its side.
 */
function setStationPlane(entry, al, s, sign = null) {
  s = Math.min(Math.max(s, 0), al.length);
  const { P, T } = stationFrame(al, s);
  if (sign === null) sign = entry.station ? (entry.plane.normal.dot(entry.station.T) >= 0 ? 1 : -1) : 1;
  entry.plane.setFromNormalAndCoplanarPoint(T.clone().multiplyScalar(sign), P);
  entry.axisVec = T.clone();
  entry.anchor = P.clone();
  entry.station = { al, s, T };
  viewer.updatePlane(entry);
}

/** Text → station in metres: "1+234.5", "1+234,5", "1234.5" (null if not a number). */
function parseStation(text) {
  const v = String(text).trim().replace(/\s+/g, '').replace(',', '.').replace(/^km/i, '');
  const m = /^(-?)(\d+)\+(\d+(?:\.\d*)?)$/.exec(v);
  if (m) return (m[1] ? -1 : 1) * (+m[2] * 1000 + +m[3]);
  return v !== '' && Number.isFinite(+v) ? +v : null;
}

function addStationPlane() {
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  const list = allAlignments();
  if (!list.length) return toast(t('aln.none'));
  // start at the alignment point nearest to the centre of the view
  const c = viewer.toIfc(viewer.controls.target);
  let best = null;
  for (const al of list) { const r = project(al, c); if (!best || r.dist < best.r.dist) best = { al, r }; }
  const { P, T } = stationFrame(best.al, best.r.s);
  const entry = viewer.addPlane('custom', { normal: T.clone().negate(), point: P });
  setStationPlane(entry, best.al, best.r.s, 1);
  renderPlanes();
  setTimeout(() => $('.plane-row.station:last-child .val input')?.select(), 0);
}

// a free plane restored from a view / viewpoint that is a cross section of an alignment
viewer.stationResolver = (entry) => {
  const n = entry.plane.normal;
  if (Math.abs(n.y) > 1e-3) return;
  for (const al of allAlignments()) {
    const { poly, cum } = al;
    const dist = (k) => { const q = viewer.fromIfc(poly[k][0], poly[k][1], 0); q.y = 0; const pl = entry.plane; return n.x * q.x + n.z * q.z + pl.constant; };
    let d0 = dist(0);
    for (let k = 1; k < poly.length; k++) {
      const d1 = dist(k);
      if ((d0 <= 0) !== (d1 <= 0)) {
        const s = cum[k - 1] + (cum[k] - cum[k - 1]) * (d0 / (d0 - d1));
        const { T } = stationFrame(al, s);
        if (Math.abs(T.dot(n)) > 0.9999) { setStationPlane(entry, al, s, T.dot(n) > 0 ? 1 : -1); return; }
      }
      d0 = d1;
    }
  }
};

/** Letter of a cross section (A, B, …) in the order the station planes were added. */
function sectionLetter(p) {
  const i = viewer.planes.filter((x) => x.station).indexOf(p);
  return i < 0 ? '' : i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`;
}
const stationText = (p) => formatStation(p.station.al.station0 + p.station.s);

/** Section mark of a station plane in IFC coordinates (line across the alignment, viewing direction). */
function stationMark(p) {
  const { al, s } = p.station;
  const q = pointAt(al, s);
  const sign = p.plane.normal.dot(p.station.T) >= 0 ? 1 : -1;
  const z = heightAt(al, s) ?? viewer.toIfc(p.anchor).z;
  const half = Math.min(Math.max(viewer.sceneRadius * 0.04, 5), 25);
  const L = [-q.dy, q.dx]; // left of the alignment
  return {
    A: [q.x + L[0] * half, q.y + L[1] * half], B: [q.x - L[0] * half, q.y - L[1] * half],
    v: [q.dx * sign, q.dy * sign], mid: [q.x, q.y], z, half, letter: sectionLetter(p), label: `${t('st.label')} ${stationText(p)}`,
  };
}

const sectionMarks = new SectionMarks(viewer, $('#viewport'));
viewer.addEventListener('planeschanged', () => sectionMarks.set(viewer.planes.filter((p) => p.station && p.enabled).map(stationMark)));

/** Drawing marks of the station planes for a plan drawing (classic section marks A–A). */
function planSectionMarks() {
  const out = [];
  for (const p of viewer.planes.filter((x) => x.station && x.enabled)) {
    const mk = stationMark(p);
    const layer = 'SECTION_MARKS';
    out.push({ line: [mk.A, mk.B], color: AXIS_COLOR, w: 0.35, dash: 'dashdot', layer });
    for (const E of [mk.A, mk.B]) {
      out.push({ arrow: E, dir: mk.v, size: 6, color: AXIS_COLOR, layer });
      out.push({ text: mk.letter, at: E, dx: mk.v[0] * 9, dy: -mk.v[1] * 9 + 1.6, size: 4.5, bold: true, anchor: 'middle', color: AXIS_COLOR, layer });
    }
    out.push({ text: stationText(p), at: mk.B, dx: -mk.v[0] * 4 + (mk.B[0] - mk.A[0]) / mk.half * 2, dy: mk.v[1] * 4 - (mk.B[1] - mk.A[1]) / mk.half * 2 + 1, size: 2.6, anchor: 'middle', color: AXIS_COLOR, layer });
  }
  return out;
}

/** Clips the segment a–b to a box (Liang–Barsky); returns [t0, t1] or null. */
function clipSegment(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - box.minX], [dx, box.maxX - a[0]], [-dy, a[1] - box.minY], [dy, box.maxY - a[1]]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

/** The alignments inside a plan drawing (box in IFC X/Y): dash-dot axis with station ticks. */
function planAlignmentMarks(box) {
  const out = [];
  const w = box.maxX - box.minX, hgt = box.maxY - box.minY;
  const pad = 0.1 * Math.max(w, hgt, 1);
  const b = { minX: box.minX - pad, maxX: box.maxX + pad, minY: box.minY - pad, maxY: box.maxY + pad };
  for (const al of allAlignments()) {
    // runs of the polyline inside the box, as [point, distance along]
    const runs = [];
    let run = null;
    for (let k = 1; k < al.poly.length; k++) {
      const a = al.poly[k - 1], c = al.poly[k];
      const tt = clipSegment(a, c, b);
      if (!tt) { run = null; continue; }
      const at = (t) => [[a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t], al.cum[k - 1] + (al.cum[k] - al.cum[k - 1]) * t];
      if (!run || tt[0] > 1e-9) { run = [at(tt[0])]; runs.push(run); }
      run.push(at(tt[1]));
      if (tt[1] < 1 - 1e-9) run = null;
    }
    for (const r of runs) {
      if (r.length < 2) continue;
      out.push({ line: r.map((x) => x[0]), color: AXIS_COLOR, w: 0.25, dash: 'dashdot', layer: 'ALIGNMENT_AXIS' });
      const s0 = r[0][1], s1 = r[r.length - 1][1];
      const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000].find((x) => (s1 - s0) / x <= 12) || 5000;
      const tick = Math.max(w, hgt, 1) / 100;
      for (let st = Math.ceil((al.station0 + s0) / step) * step; st <= al.station0 + s1 + 1e-6; st += step) {
        const q = pointAt(al, st - al.station0);
        const L = [-q.dy, q.dx];
        out.push({ line: [[q.x + L[0] * tick, q.y + L[1] * tick], [q.x - L[0] * tick, q.y - L[1] * tick]], color: AXIS_COLOR, w: 0.25, layer: 'ALIGNMENT_AXIS' });
        out.push({ text: formatStation(st), at: [q.x + L[0] * tick, q.y + L[1] * tick], dx: L[0] * 2, dy: -L[1] * 2 + 0.8, size: 2.4, anchor: 'middle', color: AXIS_COLOR, layer: 'ALIGNMENT_AXIS' });
      }
    }
  }
  return out;
}

/** Plan marks: the section marks, then the alignments inside the drawing including the marks. */
function planMarks(bounds) {
  const sec = planSectionMarks();
  const box = { ...bounds };
  for (const mk of sec) for (const p of mk.line || []) {
    box.minX = Math.min(box.minX, p[0]); box.maxX = Math.max(box.maxX, p[0]);
    box.minY = Math.min(box.minY, p[1]); box.maxY = Math.max(box.maxY, p[1]);
  }
  return [...planAlignmentMarks(box), ...sec];
}

/** Panel row of a station plane: alignment, ‹ station ›, slider. */
function stationRow(p) {
  const st = p.station;
  const al = st.al;
  const enabled = h('input', { type: 'checkbox', checked: p.enabled, title: t('planes.active') });
  enabled.addEventListener('change', () => viewer.togglePlane(p, enabled.checked));
  const slider = h('input', { type: 'range', min: '0', max: String(al.length), step: String(Math.max(0.01, al.length / 4000)), value: String(st.s) });
  const posInput = h('input', { type: 'text', inputmode: 'decimal', title: t('st.title'), class: 'station-input' });
  const upd = () => { posInput.value = formatStation(al.station0 + p.station.s); slider.value = String(p.station.s); };
  const moveTo = (s) => { setStationPlane(p, p.station.al, s); upd(); };
  slider.addEventListener('input', () => moveTo(+slider.value));
  posInput.addEventListener('change', () => {
    const v = parseStation(posInput.value);
    if (v === null) { toast(t('st.bad', { v: posInput.value })); return upd(); }
    const s = v - al.station0;
    if (s < -0.001 || s > al.length + 0.001) toast(t('st.outside', { from: formatStation(al.station0), to: formatStation(al.station0 + al.length) }));
    moveTo(s);
  });
  posInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveTo(p.station.s + (e.key === 'ArrowUp' ? 1 : -1) * planeStep()); }
  });
  const stepBtn = (dir) => h('button', {
    class: 'step', text: dir > 0 ? '›' : '‹', title: t(dir > 0 ? 'planes.stepFwd' : 'planes.stepBack', { step: fmtNum(planeStep()) }),
    onclick: () => moveTo(p.station.s + dir * planeStep()),
  });
  // several alignments: choose which one the plane follows
  const list = allAlignments();
  const name = list.length > 1
    ? h('select', { class: 'pl-name', title: t('st.alignment'), onchange: (e) => { const a = list[+e.target.value]; const r = project(a, viewer.toIfc(p.anchor)); setStationPlane(p, a, r.s); renderPlanes(); } },
      list.map((a, i) => h('option', { value: String(i), text: a.name, selected: a === al })))
    : h('span', { class: 'pl-name', text: `${t('st.section')} ${sectionLetter(p)}–${sectionLetter(p)} · ${al.name}`, title: al.name });
  upd();
  return h('div', { class: 'plane-row station' },
    name, enabled,
    stepBtn(-1), slider, stepBtn(1),
    h('button', { title: t('planes.flip'), text: '⇄', onclick: () => { viewer.flipPlane(p); renderPlanes(); } }),
    h('button', { title: t('drw.title'), text: '2D', onclick: () => openDrawingDialog(p) }),
    h('button', { title: t('planes.remove'), text: '✕', onclick: () => { viewer.removePlane(p); renderPlanes(); } }),
    h('div', { class: 'val' }, posInput, h('span', { text: 'km' })),
  );
}

// ------------------------------------------------------------------ drawn lines
// Lines drawn by the user work like alignments (station 0 at the first point): long profiles,
// cross sections at a station and driving along them.
const drawnPaths = [];
function makePath(name, pts) {
  const poly = pts.map((p) => [p[0], p[1]]);
  const zs = pts.map((p) => p[2]);
  const cum = [0];
  for (let k = 1; k < poly.length; k++) cum.push(cum[k - 1] + Math.hypot(poly[k][0] - poly[k - 1][0], poly[k][1] - poly[k - 1][1]));
  return { id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, poly, cum, length: cum[cum.length - 1], station0: 0, vertical: [], referents: [], zs, drawn: true, model: null };
}

const lineTool = { active: false, pts: [], onDone: null };
function showHint(text) { const el = $('#tool-hint'); el.textContent = text || ''; el.hidden = !text; }

function startLineTool(onDone = null) {
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  if (measure.mode) setMeasureMode(null);
  lineTool.active = true;
  lineTool.pts = [];
  lineTool.onDone = onDone;
  document.body.classList.add('line-drawing');
  showHint(t('line.hint'));
}

function lineToolClick(hit, e) {
  let p = hit?.point || null;
  if (!p) {
    // nothing under the cursor: the point lies at the height of the last point (or the bottom of the scene)
    const y = lineTool.pts.length ? viewer.fromIfc(...lineTool.pts[lineTool.pts.length - 1]).y : viewer.sceneBox().min.y;
    viewer.pick(e.clientX, e.clientY);
    p = viewer.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
    if (!p) return;
  }
  const q = viewer.toIfc(p);
  const last = lineTool.pts[lineTool.pts.length - 1];
  if (last && Math.hypot(last[0] - q.x, last[1] - q.y) < 1e-3) return; // second click of a double click
  lineTool.pts.push([q.x, q.y, q.z]);
  showHint(`${t('line.hint')} (${lineTool.pts.length})`);
  updateAlignments();
}

function finishLineTool(ok) {
  if (!lineTool.active) return;
  const pts = lineTool.pts;
  const done = lineTool.onDone;
  lineTool.active = false;
  lineTool.pts = [];
  lineTool.onDone = null;
  document.body.classList.remove('line-drawing');
  showHint('');
  let path = null;
  if (ok && pts.length >= 2) {
    path = makePath(t('line.name', { n: drawnPaths.length + 1 }), pts);
    drawnPaths.push(path);
    projects.touch?.();
  } else if (ok) toast(t('line.tooFew'));
  updateAlignments();
  done?.(path);
}

function removeDrawnPath(path) {
  const i = drawnPaths.indexOf(path);
  if (i < 0) return;
  drawnPaths.splice(i, 1);
  for (const p of viewer.planes.filter((x) => x.station?.al === path)) viewer.removePlane(p);
  renderPlanes();
  updateAlignments();
  projects.touch?.();
}

viewer.container.addEventListener('dblclick', () => { if (lineTool.active) finishLineTool(true); });

// ------------------------------------------------------------------ long profile
let profileResult = null; // {section, info, opts}

/** Station of a path as text (km+m for alignments, metres along for drawn lines too). */
const fmtSt = (st) => formatStation(st);

function openProfileDialog(select = null) {
  const list = allAlignments();
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  const sel = $('#prof-path');
  const prev = select || list[+sel.value] || null;
  sel.replaceChildren(...list.map((a, i) => h('option', { value: String(i), text: a.drawn ? `✎ ${a.name}` : a.name })));
  if (!list.length) sel.append(h('option', { value: '', text: t('prof.noPath') }));
  const idx = prev ? list.indexOf(prev) : 0;
  sel.value = String(Math.max(0, idx));
  profilePathChanged();
  $('#profile-dialog').open || $('#profile-dialog').showModal();
}

function profilePath() { return allAlignments()[+$('#prof-path').value] || null; }

function profilePathChanged() {
  const al = profilePath();
  $('#prof-remove-line').hidden = !al?.drawn;
  if (!al) return;
  $('#prof-from').value = fmtSt(al.station0);
  $('#prof-to').value = fmtSt(al.station0 + al.length);
  // a drawn line usually has no profile of its own worth exaggerating much
  $('#prof-exag').value = al.drawn ? '1' : $('#prof-exag').value;
  $('#prof-preview').replaceChildren(h('p', { class: 'muted small', text: t('prof.previewHint') }));
  profileResult = null;
}
$('#prof-path').addEventListener('change', profilePathChanged);

async function computeProfileNow() {
  const al = profilePath();
  if (!al) { toast(t('prof.noPath')); return null; }
  const from = parseStation($('#prof-from').value), to = parseStation($('#prof-to').value);
  if (from === null || to === null) { toast(t('st.bad', { v: from === null ? $('#prof-from').value : $('#prof-to').value })); return null; }
  const exag = +$('#prof-exag').value || 1;
  const colors = $('#prof-colors').value;
  const opts = { paper: $('#prof-paper').value, scale: 'fit', fill: $('#prof-fill').checked, mono: colors === 'mono', colors };
  let section;
  try {
    section = await withLoading(async (progress) => {
      progress(t('prof.cutting'), 0.3);
      await new Promise((r) => setTimeout(r, 30));
      return computeProfile(viewer, al, (s) => heightAt(al, s), { from: from - al.station0, to: to - al.station0, exag, fmt: fmtSt });
    });
  } catch (e) { console.error(e); toast(t('drw.failed', { error: e.message || e })); return null; }
  let n = 0;
  for (const L of section.layers.values()) n += L.elements;
  const info = {
    title: `${t('prof.drawingTitle')} ${fmtSt(Math.min(from, to))} – ${fmtSt(Math.max(from, to))}`,
    subtitle: `${al.name} · ${t('prof.exagText', { n: exag })} · ${t('prof.nElements', { n: fmtNum(n) })} · ${viewer.models.filter((m) => m.visible).map((m) => m.name).join(', ')}`,
    date: new Date().toISOString().slice(0, 10),
    exag,
  };
  profileResult = { section, info, opts, n };
  return profileResult;
}

async function showProfile() {
  const r = await computeProfileNow();
  if (!r) return;
  const lay = layout(r.section, r.opts);
  // as an image, so the page's styles do not touch the drawing
  const box = $('#prof-preview');
  const url = URL.createObjectURL(new Blob([toSvg(r.section, lay, r.info, r.opts)], { type: 'image/svg+xml' }));
  const img = h('img', { src: url, alt: r.info.title });
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  box.replaceChildren(img);
  if (!r.n) box.prepend(h('p', { class: 'muted small', text: t('prof.noElements') }));
}

async function exportProfile(fmt) {
  const r = profileResult || (await computeProfileNow());
  if (!r) return;
  const file = r.info.title.replace(/[^\w\-æøåÆØÅäöüÄÖÜß+ ]+/g, '').trim().replace(/\s+/g, '_') || 'profile';
  if (fmt === 'dxf') return download(`${file}.dxf`, toDxf(r.section, r.info), 'application/dxf');
  const lay = layout(r.section, r.opts);
  if (fmt === 'svg') download(`${file}.svg`, toSvg(r.section, lay, r.info, r.opts), 'image/svg+xml');
  else download(`${file}.pdf`, toPdf(r.section, lay, r.info, r.opts), 'application/pdf');
}
for (const id of ['#prof-from', '#prof-to', '#prof-exag', '#prof-colors', '#prof-paper', '#prof-fill']) $(id).addEventListener('change', () => { profileResult = null; });

// ------------------------------------------------------------- cross section series
/** Shows the series options when the chosen plane is a cross section at a station. */
function updateSeriesUi() {
  const entry = viewer.planes.find((p) => String(p.id) === $('#drw-plane').value);
  const box = $('#drw-series');
  box.hidden = !entry?.station;
  if (!entry?.station) { $('#ser-on').checked = false; return; }
  const st = entry.station.al.station0 + entry.station.s;
  const step = +$('#ser-step').value || 25;
  if (!$('#ser-from').value || box.dataset.forPlane !== String(entry.id)) {
    $('#ser-from').value = fmtSt(st);
    $('#ser-to').value = fmtSt(Math.min(st + 10 * step, entry.station.al.station0 + entry.station.al.length));
  }
  box.dataset.forPlane = String(entry.id);
}
$('#drw-plane').addEventListener('change', updateSeriesUi);

/** One PDF page per station from–to with the given interval, all at the same scale. */
async function exportSeries(entry, opts, baseName, file, withBackground) {
  const al = entry.station.al;
  const sOrig = entry.station.s;
  const from = parseStation($('#ser-from').value), to = parseStation($('#ser-to').value);
  const step = Math.abs(+$('#ser-step').value);
  if (from === null || to === null || !(step > 0)) return toast(t('ser.bad'));
  const lo = Math.max(Math.min(from, to), al.station0), hi = Math.min(Math.max(from, to), al.station0 + al.length);
  const stations = [];
  for (let st = lo; st <= hi + 1e-6 && stations.length < 500; st += step) stations.push(st);
  if (!stations.length) return toast(t('st.outside', { from: fmtSt(al.station0), to: fmtSt(al.station0 + al.length) }));
  const letter = sectionLetter(entry);
  const items = [];
  try {
    await withLoading(async (progress) => {
      for (let i = 0; i < stations.length; i++) {
        progress(t('ser.progress', { i: i + 1, n: stations.length, st: fmtSt(stations[i]) }), i / stations.length);
        await new Promise((r) => setTimeout(r, 0));
        setStationPlane(entry, al, stations[i] - al.station0);
        entry.stationLabel = `${t('st.axis')} ${fmtSt(stations[i])}`;
        items.push({ st: stations[i], section: computeSection(viewer, entry) });
      }
      // the same extent and scale on every page, with the axis at the same place
      const u = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const { section: sc } of items) {
        if (!Number.isFinite(sc.bounds.minX)) continue;
        u.minX = Math.min(u.minX, sc.bounds.minX); u.maxX = Math.max(u.maxX, sc.bounds.maxX);
        u.minY = Math.min(u.minY, sc.bounds.minY); u.maxY = Math.max(u.maxY, sc.bounds.maxY);
      }
      if (!Number.isFinite(u.minX)) throw new Error(t('drw.empty'));
      const lay = layout({ bounds: u }, opts);
      const pages = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        it.section.bounds = { ...u };
        let background = null;
        if (withBackground) {
          progress(t('ser.background', { i: i + 1, n: items.length }), i / items.length);
          await new Promise((r) => setTimeout(r, 0));
          setStationPlane(entry, al, it.st - al.station0);
          try { background = renderBackground(viewer, it.section, lay); } catch (e) { console.warn('background', e); }
        }
        pages.push({
          section: it.section, lay,
          info: { title: `${baseName} – ${t('st.section')} ${letter}–${letter} ${fmtSt(it.st)}`, subtitle: `${t('ser.page', { i: i + 1, n: items.length })} · ${al.name} · ${viewer.models.filter((m) => m.visible).map((m) => m.name).join(', ')}`, date: new Date().toISOString().slice(0, 10) },
          opts: { ...opts, background },
        });
      }
      download(`${file}.pdf`, toPdfPages(pages), 'application/pdf');
    });
    toast(t('ser.done', { n: items.length }), true);
  } catch (e) {
    console.error(e);
    toast(t('drw.failed', { error: e.message || e }));
  } finally {
    setStationPlane(entry, al, sOrig);
    renderPlanes();
  }
}

// ------------------------------------------------------------------ drive along
const drive = { al: null, s: 0, dir: 1, playing: false, last: 0, raf: 0, shown: 0 };

function openDrive() {
  const list = allAlignments();
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  if (!list.length) return toast(t('aln.none'));
  if (walk.active) walk.toggle();
  if (viewer.isOrtho) setOrtho(false);
  const c = viewer.toIfc(viewer.controls.target);
  let best = null;
  for (const al of list) { const r = project(al, c); if (!best || r.dist < best.r.dist) best = { al, r }; }
  drive.al = drive.al && list.includes(drive.al) ? drive.al : best.al;
  if (drive.al === best.al) drive.s = best.r.s;
  const sel = $('#drive-path');
  sel.replaceChildren(...list.map((a, i) => h('option', { value: String(i), text: a.drawn ? `✎ ${a.name}` : a.name, selected: a === drive.al })));
  $('#drive-panel').hidden = false;
  drivePose();
  $('#drive-station').select();
}

function drivePose() {
  const al = drive.al;
  if (!al) return;
  drive.s = Math.min(Math.max(drive.s, 0), al.length);
  const eye = +$('#drive-eye').value || 0;
  const zAt = (s) => {
    const z = heightAt(al, s);
    if (z !== null) return z;
    const box = viewer.sceneBox();
    return box.isEmpty() ? 0 : viewer.toIfc(box.getCenter(new THREE.Vector3())).z;
  };
  const q = pointAt(al, drive.s);
  const P = viewer.fromIfc(q.x, q.y, zAt(drive.s) + eye);
  // look ahead along the path (follows the curves)
  const speed = (+$('#drive-speed').value || 60) / 3.6;
  const look = Math.max(20, speed * 2.5);
  const sa = Math.min(Math.max(drive.s + drive.dir * look, 0), al.length);
  let T;
  if (Math.abs(sa - drive.s) > 1) { const qa = pointAt(al, sa); T = viewer.fromIfc(qa.x, qa.y, zAt(sa) + eye * 0.85); }
  else T = viewer.fromIfc(q.x + q.dx * drive.dir * look, q.y + q.dy * drive.dir * look, zAt(drive.s) + eye * 0.85);
  viewer.camera.position.copy(P);
  viewer.controls.target.copy(T);
  viewer.camera.lookAt(T);
  viewer.controls.update?.();
  const now = performance.now();
  if (now - drive.shown > 120 || !drive.playing) { $('#drive-station').value = fmtSt(al.station0 + drive.s); drive.shown = now; }
}

function driveTick(now) {
  if (!drive.playing) return;
  const dt = Math.min(0.1, (now - drive.last) / 1000);
  drive.last = now;
  drive.s += drive.dir * ((+$('#drive-speed').value || 60) / 3.6) * dt;
  if (drive.s <= 0 || drive.s >= drive.al.length) { drivePose(); setDrivePlaying(false); return; }
  drivePose();
  drive.raf = requestAnimationFrame(driveTick);
}

function setDrivePlaying(on) {
  if (on && !drive.al) return;
  if (on && ((drive.dir > 0 && drive.s >= drive.al.length - 0.01) || (drive.dir < 0 && drive.s <= 0.01))) drive.dir = -drive.dir; // at the end: turn round
  drive.playing = on;
  $('#drive-play').textContent = on ? '⏸' : '▶';
  $('#drive-dir').textContent = drive.dir > 0 ? '→' : '←';
  cancelAnimationFrame(drive.raf);
  if (on) { drive.last = performance.now(); drive.raf = requestAnimationFrame(driveTick); }
  else drivePose();
}

function closeDrive() { setDrivePlaying(false); $('#drive-panel').hidden = true; }

$('#drive-path').addEventListener('change', (e) => {
  const al = allAlignments()[+e.target.value];
  if (!al) return;
  const r = project(al, viewer.toIfc(viewer.camera.position));
  drive.al = al; drive.s = r.s;
  drivePose();
});
$('#drive-station').addEventListener('change', (e) => {
  const v = parseStation(e.target.value);
  if (v === null || !drive.al) { toast(t('st.bad', { v: e.target.value })); return drivePose(); }
  drive.s = v - drive.al.station0;
  drivePose();
});
$('#drive-station').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); drive.s += (e.key === 'ArrowUp' ? 1 : -1) * planeStep(); drivePose(); }
});
$('#drive-eye').addEventListener('change', () => drivePose());
// taking the camera (drag, wheel) pauses the drive
viewer.container.addEventListener('pointerdown', (e) => { if (drive.playing && e.target === viewer.renderer.domElement) setDrivePlaying(false); }, { capture: true });
viewer.container.addEventListener('wheel', () => { if (drive.playing) setDrivePlaying(false); }, { capture: true, passive: true });

/** Step length (m) for the ‹ › buttons of the section planes; remembered in the browser. */
function planeStep() {
  const v = +$('#plane-step').value;
  return Number.isFinite(v) && v > 0 ? v : 1;
}
try { const v = localStorage.getItem('onlineifc.planeStep'); if (v) $('#plane-step').value = v; } catch { /* ignore */ }
$('#plane-step').addEventListener('change', () => {
  try { localStorage.setItem('onlineifc.planeStep', String(planeStep())); } catch { /* ignore */ }
  // only the tooltips change: redrawing the rows here would swallow a click on ‹ › that blurs this field
  for (const b of $$('.plane-row button.step')) b.title = t(b.textContent === '›' ? 'planes.stepFwd' : 'planes.stepBack', { step: fmtNum(planeStep()) });
});
$('#plane-helpers').addEventListener('change', (e) => viewer.setHelpersVisible(e.target.checked));
$('#plane-fill').addEventListener('change', (e) => viewer.setSectionFill(e.target.checked));

// ====================================================================== measure
let lastMeasureMode = 'distance';
let measurePanelClosed = false;

function setMeasureMode(mode) {
  if (mode && !viewer.models.length) return toast(t('msg.loadFirst'));
  if (mode) { lastMeasureMode = mode; measurePanelClosed = false; }
  if (mode && state.pickPlaneMode) setPickPlaneMode(false);
  measure.setMode(mode);
}

function renderMeasure() {
  const panel = $('#measure-panel');
  const rows = measure.rows();
  panel.hidden = measurePanelClosed || (!measure.mode && !rows.length);
  for (const b of $$('.toolbar [data-action="toggle-measure"]')) b.classList.toggle('on', !!measure.mode);
  for (const b of $$('#measure-modes [data-measure]')) b.classList.toggle('on', b.dataset.measure === measure.mode);
  $('#measure-hint').textContent = measure.mode ? t(`measure.hint.${measure.mode}`) : t('measure.hint.off');
  $('#measure-foot').hidden = !rows.length;
  $('.spot-opts').hidden = measure.mode !== 'spot';
  $('.lock-opts').hidden = measure.mode !== 'distance';
  const list = $('#measure-list');
  list.replaceChildren(...rows.map((r) => h('div', { class: `m-item ${r.m.type}` },
    h('div', { class: 'm-item-head' },
      h('span', { class: 'm-swatch' }),
      h('a', { class: 'm-title', text: r.title, title: t('measure.zoomTo'), onclick: () => measure.focus(r.m.id) }),
      h('b', { class: 'm-value', text: r.value }),
      h('button', { class: 'icon-btn', title: t('measure.remove'), text: '✕', onclick: () => measure.remove(r.m.id) })),
    r.lines.length ? h('table', { class: 'm-lines' }, r.lines.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v })))) : null,
  )));
  renderStatus();
}
measure.addEventListener('change', renderMeasure);
for (const b of $$('#measure-modes [data-measure]')) b.addEventListener('click', () => setMeasureMode(measure.mode === b.dataset.measure ? null : b.dataset.measure));
$('#measure-snap').addEventListener('change', (e) => { measure.snapOn = e.target.checked; });
$('#measure-unit').addEventListener('change', (e) => { measure.unit = e.target.value; measure.refresh(); });
$('#station-format').addEventListener('change', (e) => { alignmentLayer.format = e.target.value; alignmentLayer.rebuild(); measure.refresh(); });

// Station marks of alignments: automatic, a fixed interval, or off (only the line)
function applyStationInterval() {
  const sel = $('#station-interval').value;
  $('#station-custom-wrap').hidden = sel !== 'custom';
  let v = sel;
  if (sel === 'custom') { const c = +$('#station-custom').value; v = Number.isFinite(c) && c > 0 ? c : 'auto'; }
  alignmentLayer.interval = v === 'auto' ? 'auto' : Number(v);
  alignmentLayer.rebuild();
  try { localStorage.setItem('onlineifc.stationInterval', JSON.stringify({ sel, custom: $('#station-custom').value })); } catch { /* ignore */ }
}
try {
  const saved = JSON.parse(localStorage.getItem('onlineifc.stationInterval') || 'null');
  if (saved) { $('#station-interval').value = saved.sel; $('#station-custom').value = saved.custom; }
} catch { /* ignore */ }
$('#station-interval').addEventListener('change', applyStationInterval);
$('#station-custom').addEventListener('change', applyStationInterval);
applyStationInterval();
for (const cb of $$('[data-spot-show]')) {
  cb.checked = !!measure.spotShow[cb.dataset.spotShow];
  cb.addEventListener('change', () => measure.setSpotShow(cb.dataset.spotShow, cb.checked));
}

// ====================================================================== filters
const filters = new FilterPanel({
  viewer, h, toast, withLoading,
  root: $('#filters'),
  setSelection: (map) => {
    state.selection.clear();
    state.treeKeys.clear();
    for (const [m, ids] of map) if (ids.length) state.selection.set(m, new Set(ids));
    state.active = null;
    applySelection();
  },
  refreshVisibility: () => refreshVisibilityUi(),
});

const qto = new QtoTable({
  viewer, h, toast, download, state,
  ensureIndex: () => filters.ensureIndex(),
  setSelection: (map) => filters.ctx.setSelection(new Map([...map].map(([m, ids]) => [m, ids]))),
}, $('#qto-dialog'));

// ======================================================================= issues
const issues = new IssuesPanel({
  viewer, h, toast, download, state,
  root: $('#issues'),
  setSelection: (map) => {
    state.selection.clear();
    state.treeKeys.clear();
    for (const [m, ids] of map) if (ids.length) state.selection.set(m, new Set(ids));
    state.active = null;
    applySelection();
  },
  setSpacesVisible: (v) => { state.spacesVisible = v; updateSpacesUi(); },
  afterVisibility: () => { refreshVisibilityUi(); renderPlanes(); },
});

const views = new ViewsPanel({
  viewer, h, toast, download, state, issues,
  root: $('#views'),
  setSelection: (map) => issues.ctx.setSelection(map),
  setSpacesVisible: (v) => issues.ctx.setSpacesVisible(v),
  afterVisibility: () => { refreshVisibilityUi(); renderPlanes(); renderModels(); },
  setXray: (on) => setXray(on),
});

// ===================================================================== projects
const projects = new ProjectManager({
  viewer, views, issues, state, h, toast,
  clearModels: () => {
    drawnPaths.length = 0;
    for (const m of [...viewer.models]) viewer.removeModel(m);
    state.selection.clear();
    state.treeKeys.clear();
    state.active = null;
    afterModelsChanged();
  },
  openFiles: (files, keys) => openIfcFiles(files, keys),
  afterRestore: () => { updateSpacesUi(); afterModelsChanged(); },
  getExtra: () => (drawnPaths.length ? { lines: drawnPaths.map((p) => ({ name: p.name, pts: p.poly.map((q, k) => [q[0], q[1], p.zs[k]]) })) } : null),
  setExtra: (x) => { drawnPaths.length = 0; for (const l of x?.lines || []) drawnPaths.push(makePath(l.name, l.pts)); updateAlignments(); },
});
viewer.addEventListener('modelremoved', ({ model }) => projects.modelRemoved(model));
projects.addEventListener('change', () => { renderProjectBar(); if (!viewer.models.length) renderRecentProjects(); if ($('#projects-dialog').open) renderProjectsDialog(); });

/** Recent projects on the start screen. */
async function renderRecentProjects() {
  const box = $('#recent-projects');
  if (!projects.enabled) { box.hidden = true; return; }
  const n = await projects.renderList($('#recent-list'), { limit: 4 });
  box.hidden = n === 0;
}

/** The project line at the top of the Models tab. */
function renderProjectBar() {
  const bar = $('#project-bar');
  bar.hidden = !viewer.models.length;
  if (bar.hidden) return;
  $('#project-name').textContent = projects.current?.name || t('proj.unsaved');
  $('#project-status').textContent = projects.statusText();
}

async function renderProjectsDialog() {
  $('#proj-enabled').checked = projects.enabled;
  const n = await projects.renderList($('#proj-list'), { onOpen: () => $('#projects-dialog').close() });
  $('#proj-empty').hidden = n > 0;
  const u = await projects.usage();
  $('#proj-usage').textContent = t('proj.usage', { files: projects.fmtBytes(u.files), geom: projects.fmtBytes(u.geom), free: u.quota ? projects.fmtBytes(u.quota) : '?' });
}

function openProjectsDialog() {
  renderProjectsDialog();
  $('#projects-dialog').showModal();
}
$('#proj-enabled').addEventListener('change', (e) => {
  if (!e.target.checked && !confirm(t('proj.disableConfirm'))) { e.target.checked = true; return; }
  projects.setEnabled(e.target.checked);
});
renderRecentProjects();

// ================================================== ortho, X-ray and storeys
function setOrtho(on) {
  viewer.setOrthographic(on);
  if (!$('#ortho-check')) return;
  $('#ortho-check').textContent = on ? '☑' : '☐';
  renderStatus();
}

function setXray(on) {
  state.xray = on;
  for (const m of viewer.models) m.setXray(on ? state.selection.get(m) || [] : null);
  $('#xray-check').textContent = on ? '☑' : '☐';
  if (on && !state.selection.size) toast(t('msg.xrayHint'), true);
  renderStatus();
}

/** All storeys of all models, sorted by elevation: [{model, id, name, elevation}] */
function allStoreys() {
  const out = [];
  for (const m of viewer.models) {
    const walk = (n) => {
      if (m.typeName(n.expressID) === 'IfcBuildingStorey') {
        const line = m.api.GetLine(m.modelID, n.expressID, false);
        const ev = line?.Elevation;
        const v = ev && typeof ev === 'object' ? Number(ev._representationValue ?? ev.value) : NaN;
        out.push({ model: m, id: n.expressID, node: n, name: m.label(n.expressID), elevation: Number.isFinite(v) ? v * (m.lengthScale || 1) : null });
      }
      for (const c of n.children || []) walk(c);
    };
    if (m.tree) walk(m.tree);
  }
  return out.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
}

function renderStoreyItems() {
  const box = $('#storey-items');
  const list = allStoreys();
  const multi = viewer.models.length > 1;
  const item = (label, sub, onclick, active = false) => {
    const b = h('button', { class: `menu-item small-item${active ? ' active' : ''}` },
      h('span', { class: 'mi-icon', text: active ? '●' : '' }),
      h('span', { class: 'mi-text' }, h('b', { text: label }), sub ? h('small', { text: sub }) : null));
    b.addEventListener('click', () => { closeMenus(); onclick(); });
    return b;
  };
  const items = [];
  if (!list.length) items.push(h('div', { class: 'menu-empty', text: t('mi.noStoreys') }));
  else {
    items.push(item(t('mi.allStoreys'), null, () => showStorey(null), !state.storey));
    for (const st of [...list].reverse()) {
      const sub = [st.elevation !== null ? `${st.elevation >= 0 ? '+' : ''}${st.elevation.toFixed(2)} m` : null, multi ? st.model.name : null].filter(Boolean).join(' · ');
      items.push(item(st.name, sub, () => showStorey(st), state.storey?.id === st.id && state.storey?.model === st.model));
    }
    const cut = h('button', { class: 'menu-item small-item' }, h('span', { class: 'mi-icon mi-check', text: state.storeyCut ? '☑' : '☐' }),
      h('span', { class: 'mi-text' }, h('b', { text: t('mi.storeyCut') }), h('small', { text: t('mi.storeyCutDesc') })));
    cut.addEventListener('click', (e) => { e.stopPropagation(); state.storeyCut = !state.storeyCut; renderStoreyItems(); if (state.storey) showStorey(state.storey); });
    items.push(cut);
  }
  box.replaceChildren(...items);
}

let storeyPlane = null;
function showStorey(st) {
  if (storeyPlane) { viewer.removePlane(storeyPlane); storeyPlane = null; }
  state.storey = st ? { model: st.model, id: st.id } : null;
  if (!st) {
    showAll();
    renderPlanes();
    return;
  }
  const ids = descendantIds(st.model, st.node);
  for (const m of viewer.models) m.isolate(m === st.model ? ids : []);
  if (state.storeyCut && st.elevation !== null) {
    storeyPlane = viewer.addPlane('y');
    const y = viewer.fromIfc(0, 0, st.elevation + 1.2).y;
    viewer.setPlanePos(storeyPlane, y);
  }
  refreshVisibilityUi();
  renderPlanes();
  const b = st.model.getBox(ids);
  if (!b.isEmpty()) viewer.fitBox(b);
  toast(t('msg.storeyShown', { name: st.name }), true);
}

function stepStorey(dir) {
  const list = allStoreys();
  if (!list.length) return;
  let i = state.storey ? list.findIndex((x) => x.id === state.storey.id && x.model === state.storey.model) : -1;
  i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
  showStorey(list[i]);
}

// ====================================================================== drawing
function planeLabel(p, i) {
  if (p.station) return `${t('st.section')} ${sectionLetter(p)}–${sectionLetter(p)} · ${t('st.label')} ${stationText(p)} (${p.station.al.name})`;
  return p.boxPart ? `${t('planes.boxPart')} ${p.axis.toUpperCase()} ${p.boxPart}` : `${i + 1}. ${t(AXIS_LABEL[p.axis])} (${viewer.getPlanePos(p).toFixed(2)} m)`;
}

function openDrawingDialog(plane = null) {
  const planes = viewer.planes.filter((p) => p.enabled);
  if (!planes.length) return toast(t('drw.noPlane'));
  $('#drw-plane').replaceChildren(...planes.map((p, i) => h('option', { value: String(p.id), text: planeLabel(p, i), selected: plane ? p === plane : i === 0 })));
  $('#drw-scale').replaceChildren(h('option', { value: 'fit', text: t('drw.fit') }), ...SCALES.map((sc) => h('option', { value: String(sc), text: `1:${sc}` })));
  const m = viewer.models[0];
  const pSel = plane || planes[0];
  $('#drw-name').value = `${m ? m.name.replace(/\.ifc$/i, '') : 'Model'} – ${pSel.station ? `${t('st.section')} ${sectionLetter(pSel)}–${sectionLetter(pSel)} (${stationText(pSel)})` : t(AXIS_LABEL[pSel.axis] || 'planes.face')}`;
  // the options chosen last time
  try {
    const saved = JSON.parse(localStorage.getItem(DRW_OPTS) || 'null');
    if (saved) for (const [id, v] of Object.entries(saved)) {
      const el = $(`#${id}`);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else if ([...el.options].some((o) => o.value === v)) el.value = v;
    }
  } catch { /* ignore */ }
  updateSeriesUi();
  $('#drawing-dialog').showModal();
}
const DRW_OPTS = 'onlineifc.drawingOptions';
function saveDrawingOptions() {
  const out = {};
  for (const id of ['drw-format', 'drw-paper', 'drw-scale', 'drw-colors', 'drw-fill', 'drw-bg']) {
    const el = $(`#${id}`);
    if (el) out[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem(DRW_OPTS, JSON.stringify(out)); } catch { /* ignore */ }
}

async function exportDrawing() {
  const entry = viewer.planes.find((p) => String(p.id) === $('#drw-plane').value);
  if (!entry) return;
  const format = $('#drw-format').value;
  const scaleVal = $('#drw-scale').value;
  const opts = { paper: $('#drw-paper').value, scale: scaleVal === 'fit' ? 'fit' : +scaleVal, fill: $('#drw-fill').checked, mono: $('#drw-colors').value === 'mono', colors: $('#drw-colors').value };
  $('#drawing-dialog').close();
  saveDrawingOptions();
  if (entry.station && $('#ser-on').checked) {
    if (format !== 'pdf') toast(t('ser.pdfOnly'));
    const base = $('#drw-name').value.trim() || 'Section';
    const file = base.replace(/[^\w\-æøåÆØÅäöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '_') || 'sections';
    return exportSeries(entry, opts, base.replace(/\s*–\s*(Section|Snit|Schnitt|सेक्शन).*$/, ''), `${file}_series`, $('#drw-bg').checked);
  }
  let section;
  try {
    if (entry.station) entry.stationLabel = `${t('st.axis')} ${formatStation(entry.station.al.station0 + entry.station.s)}`;
    const plan = planeAxes(entry).horizontal;
    section = await withLoading(async (progress) => { progress(t('drw.cutting'), 0.3); await new Promise((r) => setTimeout(r, 30)); return computeSection(viewer, entry, { marks: plan ? planMarks : [] }); });
  } catch (e) { console.error(e); return toast(t('drw.failed', { error: e.message || e })); }
  if (!section.layers.size) return toast(t('drw.empty'));
  const name = $('#drw-name').value.trim() || 'Section';
  const info = {
    title: name,
    subtitle: `${planeLabel(entry, viewer.planes.indexOf(entry))} · ${viewer.models.filter((m) => m.visible).map((m) => m.name).join(', ')}`,
    date: new Date().toISOString().slice(0, 10),
  };
  const file = name.replace(/[^\w\-æøåÆØÅäöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '_') || 'section';
  if (format === 'dxf') {
    download(`${file}.dxf`, toDxf(section, info), 'application/dxf');
  } else {
    const lay = layout(section, opts);
    if (!lay.fits) toast(t('drw.tooBig', { scale: lay.scale }));
    if ($('#drw-bg').checked) {
      const helpersWere = viewer.showPlaneHelpers;
      const fillWas = viewer.sectionFillOn !== false;
      viewer.setHelpersVisible(false);
      viewer.setSectionFill(false); // no red cut faces in the background image
      // in a plan, the cross sections at stations are marks: they do not cut the background either
      const off = planeAxes(entry).horizontal ? viewer.planes.filter((p) => p.station && p.enabled) : [];
      for (const p of off) viewer.togglePlane(p, false);
      try { opts.background = renderBackground(viewer, section, lay); } catch (e) { console.warn('background', e); }
      for (const p of off) viewer.togglePlane(p, true);
      viewer.setSectionFill(fillWas);
      viewer.setHelpersVisible(helpersWere);
    }
    if (format === 'svg') download(`${file}.svg`, toSvg(section, lay, info, opts), 'image/svg+xml');
    else download(`${file}.pdf`, toPdf(section, lay, info, opts), 'application/pdf');
  }
  let n = 0;
  for (const L of section.layers.values()) n += L.elements;
  toast(t('drw.done', { n: fmtNum(n), layers: section.layers.size }), true);
}

// ========================================================================== IDS
let idsResults = null; // [{model, report}]
let idsName = '';
const idsOpen = new Set(); // "modelUid:specIndex" of expanded specifications

function openIdsDialog() {
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  $('#ids-models').replaceChildren(...viewer.models.map((m) => h('label', { class: 'chk' },
    h('input', { type: 'checkbox', value: String(m.uid), checked: true }), h('span', { text: `${m.name} (${m.schema})` }))));
  $('#ids-dialog').showModal();
}

async function runIds() {
  const file = $('#ids-file').files[0];
  if (!file) return toast(t('ids.chooseFile'));
  const uids = $$('#ids-models input:checked').map((i) => +i.value);
  const models = viewer.models.filter((m) => uids.includes(m.uid));
  if (!models.length) return toast(t('msg.loadFirst'));
  $('#ids-dialog').close();
  const text = await file.text();
  idsName = file.name;
  const res = await runIdsCheck(python, models, text, file.name);
  if (!res) { toast(t('ids.failed')); return; }
  idsResults = res;
  idsOpen.clear();
  renderIds();
}

function idsSelect(model, ids) {
  state.selection.clear();
  state.treeKeys.clear();
  if (ids.length) state.selection.set(model, new Set(ids));
  state.active = ids.length === 1 ? { model, id: ids[0] } : null;
  applySelection();
  const b = model.getBox(ids);
  if (!b.isEmpty()) viewer.fitBox(b);
}

function renderIds() {
  const panel = $('#ids-panel');
  panel.hidden = !idsResults;
  if (!idsResults) { panel.replaceChildren(); return; }
  const parts = [
    h('div', { class: 'cmp-head' }, h('b', { text: t('ids.title') }), h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: t('common.close'), text: '✕', onclick: () => { idsResults = null; renderIds(); } })),
    h('div', { class: 'muted small', text: idsName }),
  ];
  for (const entry of idsResults) {
    const { model, report } = entry;
    const passed = report.specs.filter((s) => s.status).length;
    parts.push(h('div', { class: `ids-model ${report.status ? 'ok' : 'bad'}` },
      h('b', { text: model.name }),
      h('span', { text: t('ids.modelSummary', { pass: passed, total: report.specs.length }) })));
    report.specs.forEach((sp, i) => {
      const key = `${model.uid}:${i}`;
      const open = idsOpen.has(key);
      const head = h('button', { class: 'cmp-group-head ids-spec-head' },
        h('span', { class: `ids-icon ${sp.skipped || !sp.applicable ? 'na' : sp.status ? 'ok' : 'bad'}`, text: sp.skipped || !sp.applicable ? '–' : sp.status ? '✓' : '✗' }),
        h('span', { class: 'ids-spec-name', text: sp.name || `#${i + 1}` }),
        h('span', { class: 'muted small', text: specSummary(sp) }),
        h('span', { class: 'caret', text: open ? '▾' : '▸' }));
      head.addEventListener('click', () => { open ? idsOpen.delete(key) : idsOpen.add(key); renderIds(); });
      let body = null;
      if (open) {
        body = h('div', { class: 'cmp-group-body' },
          sp.description ? h('div', { class: 'small', text: sp.description }) : null,
          sp.instructions ? h('div', { class: 'muted small', text: sp.instructions }) : null,
          h('ul', { class: 'ids-reqs' }, sp.requirements.map((r) => h('li', { class: r.status ? 'ok' : 'bad' },
            h('span', { text: r.status ? '✓ ' : '✗ ' }), h('span', { text: r.description }), r.fail ? h('b', { text: ` (${fmtNum(r.fail)})` }) : null))),
          h('div', { class: 'flt-btns' },
            sp.failed.length ? h('button', { class: 'btn sm', text: t('ids.selectFailed', { n: fmtNum(sp.failed.length) }), onclick: () => idsSelect(model, sp.failed.map((f) => f.id)) }) : null,
            h('button', { class: 'btn sm', text: t('ids.colorSpec'), onclick: () => colorIdsResult(entry, i) })),
          sp.failed.slice(0, 200).map((f) => {
            const r = h('div', { class: 'cmp-row removed' },
              h('div', { class: 'cmp-row-head' }, h('span', { class: 'lbl', text: f.name || f.gid }), h('span', { class: 'cls', text: f.cls })),
              h('div', { class: 'muted small', text: f.reasons.join(' · ') }));
            r.addEventListener('click', () => idsSelect(model, [f.id]));
            return r;
          }),
          sp.failed.length > 200 ? h('div', { class: 'muted small', text: t('cmp.more', { n: fmtNum(sp.failed.length - 200) }) }) : null);
      }
      parts.push(h('div', { class: 'cmp-group' }, head, body));
    });
  }
  parts.push(h('div', { class: 'cmp-foot' },
    h('button', { class: 'link', text: t('ids.colorAll'), onclick: () => { for (const e of idsResults) colorIdsResult(e); } }),
    h('button', { class: 'link', text: t('flt.resetColors'), onclick: () => { for (const e of idsResults) e.model.resetElementColors(); } }),
    h('button', { class: 'link', text: t('ids.exportCsv'), onclick: () => download(`ids-${idsName.replace(/\.(ids|xml)$/i, '')}.csv`, idsCsv(idsResults), 'text/csv;charset=utf-8') })));
  panel.replaceChildren(...parts);
}

// ====================================================================== compare
let comparison = null;
const cmpOpen = { added: true, removed: true, changed: true };

function openCompareDialog() {
  if (viewer.models.length < 2) return toast(t('cmp.needTwo'));
  const opts = viewer.models.map((m, i) => [String(m.uid), `${i + 1}. ${m.name}`]);
  $('#cmp-old').replaceChildren(...opts.map(([v, l], i) => h('option', { value: v, text: l, selected: i === 0 })));
  $('#cmp-new').replaceChildren(...opts.map(([v, l], i) => h('option', { value: v, text: l, selected: i === opts.length - 1 })));
  $('#compare-dialog').showModal();
}

async function runCompare() {
  const oldM = viewer.models.find((m) => String(m.uid) === $('#cmp-old').value);
  const newM = viewer.models.find((m) => String(m.uid) === $('#cmp-new').value);
  if (!oldM || !newM || oldM === newM) return toast(t('cmp.pickTwo'));
  $('#compare-dialog').close();
  if (comparison) clearComparison(comparison);
  try {
    comparison = await withLoading(async (progress) => {
      for (const m of [oldM, newM]) {
        if (!m._pindex || m._pindex.version !== m.version) await m.buildPropertyIndex((f) => progress(t('flt.building', { name: m.name }), f * 0.6));
      }
      progress(t('cmp.running'), 0.6);
      return compareModels(oldM, newM, (f) => progress(t('cmp.running'), 0.6 + 0.4 * f));
    });
  } catch (e) {
    console.error(e);
    return toast(t('cmp.failed', { error: e.message || e }));
  }
  comparison.showUnchanged = $('#cmp-unchanged').checked;
  for (const m of viewer.models) if (m !== oldM && m !== newM) m.setVisible(false);
  showComparison(comparison, { showUnchanged: comparison.showUnchanged });
  renderComparison();
  refreshVisibilityUi();
  renderModels();
}

function endComparison() {
  if (!comparison) return;
  clearComparison(comparison);
  comparison = null;
  renderComparison();
  refreshVisibilityUi();
}

function renderComparison() {
  const panel = $('#cmp-panel');
  panel.hidden = !comparison;
  if (!comparison) { panel.replaceChildren(); return; }
  const c = comparison;
  const dot = (k) => h('span', { class: 'cmp-dot', style: `background:#${CMP_COLORS[k].toString(16).padStart(6, '0')}` });
  const row = (model, id, extra = null, kind = '') => {
    const r = h('div', { class: `cmp-row ${kind}` },
      h('div', { class: 'cmp-row-head' }, h('span', { class: 'lbl', text: model.label(id) }), h('span', { class: 'cls', text: model.typeName(id) })),
      extra);
    r.addEventListener('click', () => {
      select(model, [id], { activeId: id });
      const b = model.getBox([id]);
      if (!b.isEmpty()) viewer.fitBox(b);
    });
    return r;
  };
  const LIMIT = 300;
  const group = (key, items, make) => {
    const head = h('button', { class: 'cmp-group-head' }, dot(key), h('span', { text: t(`cmp.${key}`) }), h('b', { text: fmtNum(items.length) }), h('span', { class: 'caret', text: cmpOpen[key] ? '▾' : '▸' }));
    head.addEventListener('click', () => { cmpOpen[key] = !cmpOpen[key]; renderComparison(); });
    const body = cmpOpen[key] ? h('div', { class: 'cmp-group-body' }, items.slice(0, LIMIT).map(make),
      items.length > LIMIT ? h('div', { class: 'muted small', text: t('cmp.more', { n: fmtNum(items.length - LIMIT) }) }) : null) : null;
    return h('div', { class: 'cmp-group' }, head, body);
  };
  const diffTable = (ch) => {
    const lines = [...ch.diffs.slice(0, 12).map((d) => [keyLabel(d.key), `${fmtCmp(d.a)} → ${fmtCmp(d.b)}`]), ...geomText(ch.geom)];
    if (ch.diffs.length > 12) lines.push(['…', t('cmp.moreDiffs', { n: ch.diffs.length - 12 })]);
    return h('table', { class: 'cmp-diffs' }, lines.map(([k, v]) => h('tr', {}, h('td', { text: k }), h('td', { text: v }))));
  };
  const unchangedToggle = h('input', { type: 'checkbox', checked: c.showUnchanged });
  unchangedToggle.addEventListener('change', () => {
    c.showUnchanged = unchangedToggle.checked;
    clearComparison(c);
    showComparison(c, { showUnchanged: c.showUnchanged });
    refreshVisibilityUi();
  });
  panel.replaceChildren(
    h('div', { class: 'cmp-head' },
      h('b', { text: t('cmp.title') }), h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: t('cmp.end'), text: '✕', onclick: endComparison })),
    h('div', { class: 'muted small', text: `${c.oldM.name} → ${c.newM.name}` }),
    h('div', { class: 'cmp-summary', text: summaryText(c) }),
    h('label', { class: 'chk' }, unchangedToggle, h('span', { text: t('cmp.showUnchanged') })),
    group('added', c.added, (id) => row(c.newM, id, null, 'added')),
    group('removed', c.removed, (id) => row(c.oldM, id, null, 'removed')),
    group('changed', c.changed, (ch) => row(c.newM, ch.b, diffTable(ch), 'changed')),
    h('div', { class: 'cmp-foot' },
      h('button', { class: 'link', text: t('cmp.exportCsv'), onclick: () => download(`comparison-${c.newM.name.replace(/\.ifc$/i, '')}.csv`, comparisonCsv(c), 'text/csv;charset=utf-8') }),
      h('button', { class: 'link', text: t('cmp.end'), onclick: endComparison })),
  );
}

function fmtCmp(v) {
  if (v === undefined) return '—';
  return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v);
}

// ===================================================================== opacity
for (const r of $$('[data-sel-opacity]')) {
  r.addEventListener('input', () => {
    for (const other of $$('[data-sel-opacity]')) if (other !== r) other.value = r.value;
    for (const [m, set] of state.selection) m.setElementOpacity(set, +r.value);
  });
}
$('#measure-lock-xy').addEventListener('change', (e) => { measure.lockXY = e.target.checked; });

// ========================================================================== map
const MAP_KEY = 'onlineifc.map';
function loadMapSettings() {
  try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; } catch { return {}; }
}

function openMapDialog() {
  if (!viewer.models.length) return toast(t('msg.loadFirst'));
  const ref = viewer.models[0];
  const saved = loadMapSettings();
  const mc = ref.georef?.map;
  $('#map-detected').textContent = mc
    ? t('map.detected', { crs: mc.crs || '?', e: mc.eastings.toFixed(2), n: mc.northings.toFixed(2), rot: ((Math.atan2(mc.b, mc.a) * 180) / Math.PI).toFixed(3), name: ref.name })
    : t('map.notDetected', { name: ref.name });
  $('#map-detected').classList.toggle('ok', !!mc);
  $('#map-src-model').disabled = !mc;
  const source = mc && saved.source !== 'manual' ? 'model' : 'manual';
  $(`#map-src-${source}`).checked = true;
  $('#map-crs-list').replaceChildren(...COMMON_CRS.map(([code, name]) => h('option', { value: code, text: name })));
  $('#map-crs').value = saved.crs || (mc && normaliseCrs(mc.crs)) || 'EPSG:25832';
  $('#map-e0').value = saved.e0 ?? 0;
  $('#map-n0').value = saved.n0 ?? 0;
  $('#map-rot').value = saved.rotation ?? 0;
  $('#map-basemap').value = saved.basemap || 'ortho';
  $('#map-railway').value = saved.railway ?? '';
  $('#map-radius').value = saved.radius || '';
  $('#map-opacity').value = saved.opacity || 1;
  updateMapSource();
  $('#map-dialog').showModal();
}

function updateMapSource() {
  const manual = $('#map-src-manual').checked;
  for (const el of $$('#map-manual input')) el.disabled = !manual;
  $('#map-manual').classList.toggle('disabled', !manual);
}
for (const r of $$('input[name="map-source"]')) r.addEventListener('change', updateMapSource);
$('#map-opacity').addEventListener('input', (e) => mapLayer.setOpacity(+e.target.value));

async function showMap() {
  const opts = {
    source: $('#map-src-model').checked ? 'model' : 'manual',
    crs: $('#map-crs').value.trim(),
    e0: $('#map-e0').value, n0: $('#map-n0').value, rotation: $('#map-rot').value,
    basemap: $('#map-basemap').value, railway: $('#map-railway').value,
    radius: $('#map-radius').value, opacity: $('#map-opacity').value,
  };
  try { localStorage.setItem(MAP_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
  $('#map-dialog').close();
  try {
    const res = await withLoading(async (progress) => {
      progress(t('map.loading'), 0);
      return mapLayer.show(opts, (f) => progress(t('map.loading'), f));
    });
    if (res.failed) toast(t('map.someFailed', { n: res.failed, total: res.tiles }));
    else toast(t('map.shown', { crs: res.crs, lat: res.lat.toFixed(5), lon: res.lon.toFixed(5) }), true);
  } catch (e) {
    console.error(e);
    const known = { NO_CRS: 'map.errNoCrs', NO_MODEL: 'msg.loadFirst', BAD_COORDS: 'map.errCoords', TILES_FAILED: 'map.errTiles', NO_LAYER: 'map.errNoLayer' };
    toast(known[e.message] ? t(known[e.message]) : t('map.errOther', { error: e.message }));
  }
  updateMapUi();
}

function updateMapUi() {
  for (const b of $$('.toolbar [data-action="map"]')) b.classList.toggle('on', mapLayer.visible);
  const attr = $('#map-attribution');
  attr.hidden = !mapLayer.visible;
  attr.textContent = mapLayer.attribution;
}

// ======================================================================== merge
function openMergeDialog() {
  if (viewer.models.length < 2) return toast(t('merge.needTwo'));
  const list = $('#merge-models');
  list.replaceChildren(...viewer.models.map((m) => h('label', { class: 'chk' },
    h('input', { type: 'checkbox', value: String(m.uid), checked: true }),
    h('span', { text: `${m.name} (${m.schema})` }))));
  $('#merge-dialog').showModal();
}

async function runMerge() {
  const uids = $$('#merge-models input:checked').map((i) => +i.value);
  const models = viewer.models.filter((m) => uids.includes(m.uid));
  if (models.length < 2) return toast(t('merge.needTwo'));
  // The merged file gets the length unit of the first file. Files whose geometry is in different
  // units cannot be combined correctly in the text; a file whose unit was corrected should not be first.
  const shown = new Set(models.map((m) => +m.shownLengthScale.toPrecision(6)));
  if (shown.size > 1 && !confirm(t('units.mergeDiffer', { units: [...shown].map(unitLabel).join(' / ') }))) return;
  if (models[0].unitFix !== 1) {
    const i = models.findIndex((m) => m.unitFix === 1 && +m.shownLengthScale.toPrecision(6) === +models[0].shownLengthScale.toPrecision(6));
    if (i > 0) models.unshift(...models.splice(i, 1));
  }
  const name = ($('#merge-name').value.trim() || 'merged.ifc').replace(/(\.ifc)?$/i, '.ifc');
  const replace = $('#merge-replace').checked;
  const dl = $('#merge-download').checked;
  $('#merge-dialog').close();
  // Streamed merge on the STEP text (merge.js): fast and needs little memory, also for large models
  let res;
  try {
    const sources = [];
    for (const m of models) sources.push({ name: m.name, blob: m.changes.length || !m.sourceBlob ? new Blob([await m.getBytes()]) : m.sourceBlob });
    res = await withLoading((progress) => mergeIfcBlobs(sources, (f, file) => progress(t('merge.progress', { name: file || '' }), f)));
  } catch (e) {
    console.error(e);
    toast(t('merge.failed', { error: e.message || e }));
    return;
  }
  if (dl) download(name, res.blob, 'application/x-step');
  // remove the source models first, so their memory is free before the merged model is loaded
  if (replace) {
    for (const m of models) {
      state.selection.delete(m);
      if (state.active?.model === m) state.active = null;
      viewer.removeModel(m);
    }
    afterModelsChanged();
  }
  try {
    await loadBytes(name, res.blob);
    viewer.fitAll();
    toast(t('merge.doneMsg', { n: models.length, entities: fmtNum(res.entities), combined: res.combined }), true);
  } catch (e) {
    console.error(e);
    toast(t('msg.loadFailed', { name, error: e.message || e }));
  }
}

// ======================================================================= python
const python = new PythonPanel({
  getContext: () => ({ models: viewer.models, active: state.active?.model || [...state.selection.keys()][0] || null, selection: state.selection }),
  onActions: async (actions) => {
    for (const a of actions) {
      if (a.kind === 'update') {
        const old = viewer.models.find((m) => String(m.uid) === a.key);
        if (!old) continue;
        const nm = await loadBytes(old.name, a.bytes, { replace: old });
        python.engine.rekey(old, nm);
        nm.changes = [...old.changes, { time: new Date(), description: t('chg.python') }];
        nm.version = 1;
        python.engine.sent.set(String(nm.uid), nm.version);
        renderModels();
      } else if (a.kind === 'add') {
        await loadBytes(a.name, a.bytes);
        viewer.fitAll();
      } else if (a.kind === 'download') {
        if (a.bytes) download(a.name, a.bytes, 'application/x-step');
        else download(a.name, a.text, /\.csv$/i.test(a.name) ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8');
      } else if (a.kind === 'select') {
        state.selection.clear();
        state.active = null;
        for (const [key, ids] of Object.entries(a.ids)) {
          const m = viewer.models.find((x) => String(x.uid) === key);
          if (m) state.selection.set(m, new Set(ids));
        }
        applySelection();
      }
    }
  },
  onOpenChange: (open) => {
    for (const b of $$('.toolbar [data-action="toggle-python"]')) b.classList.toggle('on', open);
    document.body.classList.toggle('py-open', open);
    viewer.resize();
  },
});

// ======================================================================= status
function renderStatus() {
  const models = viewer.models.length;
  if (!models) { $('#statusbar').textContent = t('status.ready'); return; }
  let elements = 0, hidden = 0;
  for (const m of viewer.models) { elements += m.elementIds.size; hidden += m.hidden.size; }
  const sel = selectionCount();
  $('#statusbar').textContent = [
    t('status.models', { n: models }),
    t('status.elements', { n: fmtNum(elements) }),
    hidden ? t('status.hidden', { n: fmtNum(hidden) }) : null,
    sel ? t('status.selected', { n: fmtNum(sel) }) : null,
    viewer.planes.length ? t('status.sections', { n: viewer.planes.length }) : null,
    state.editMode ? t('status.editMode') : null,
    viewer.isOrtho ? t('status.ortho') : null,
    walk.active ? t('status.walk', { speed: walk.speed.toFixed(1) }) : null,
    state.xray ? t('status.xray') : null,
    state.storey ? t('status.storey', { name: state.storey.model.label(state.storey.id) }) : null,
    measure.mode ? t(`measure.${measure.mode}`) : null,
  ].filter(Boolean).join('  ·  ');
}

// ====================================================================== helpers
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function toast(msg, ok = false) {
  const el = h('div', { class: `toast${ok ? ' ok' : ''}`, text: msg });
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

window.addEventListener('beforeunload', (e) => {
  if (viewer.models.some((m) => m.changes.length) || issues.dirty) { e.preventDefault(); e.returnValue = ''; }
});

renderAll();

// For debugging in the console
// ================================================================ installable app
// Files opened with the installed app (file handler in the manifest)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((fh) => fh.getFile()));
    openFiles(files);
  });
}
// Service worker: offline use and fast start (only in the built app, not in the dev server)
if (import.meta.env.PROD && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e)));
}

window.onlineIfc = { viewer, state, openFiles, python, measure, views, walk, drawnPaths };
