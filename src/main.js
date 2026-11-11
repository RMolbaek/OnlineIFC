// OnlineIFC – user interface.
import { Viewer } from './viewer.js';
import { loadIfcFile } from './ifc.js';
import { isSpatialType, KIND_TYPES } from './model.js';
import { t, getLang, setLang, applyStaticTranslations, fmtNum } from './i18n.js';
import { PythonPanel } from './scripting.js';
import { MeasureTool } from './measure.js';

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
const state = {
  selection: new Map(), // model -> Set(expressID)
  active: null, // {model, id}
  pickPlaneMode: false,
  spacesVisible: false,
  editMode: false,
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
  const list = [...files].filter((f) => /\.ifc$/i.test(f.name));
  if (!list.length) { toast(t('msg.chooseIfc')); return; }
  const before = viewer.models.length;
  await withLoading(async (progress) => {
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
      try {
        const model = await loadIfcFile(file, { onProgress: (msg, frac) => progress(prefix + msg, (i + frac) / list.length) });
        viewer.addModel(model);
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

/** Loads IFC bytes (e.g. produced by Python) into the viewer, optionally replacing a model. */
async function loadBytes(name, data, { replace = null } = {}) {
  const model = await withLoading((progress) => loadIfcFile({ name, data }, { onProgress: progress }));
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

function afterModelsChanged() {
  $('#welcome').hidden = viewer.models.length > 0;
  renderAll();
}

for (const input of [$('#file-input'), $('#file-input-2')]) {
  input.addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
}

// Drag and drop
const vp = $('#viewport');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; vp.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; vp.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  vp.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});

function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ==================================================================== selection
function select(model, ids, { activeId = null, additive = false, toggle = false } = {}) {
  if (!additive) state.selection.clear();
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
  state.active = null;
  applySelection();
}

function applySelection() {
  for (const m of viewer.models) m.setSelection(state.selection.get(m) || [], viewer.highlightMaterial);
  for (const el of $$('.node.selected')) el.classList.remove('selected');
  applyTreeSelection();
  if (state.active) treeRegistry.get(`${state.active.model.uid}:${state.active.id}`)?.row.classList.add('selected');
  renderProps();
  renderStatus();
}

function selectionCount() {
  let n = 0;
  for (const s of state.selection.values()) n += s.size;
  return n;
}

viewer.addEventListener('pick', ({ hit, originalEvent: e }) => {
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

// ====================================================================== toolbar
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action],[data-view],[data-plane]');
  if (!btn) return;
  if (btn.dataset.view) return viewer.setView(btn.dataset.view);
  if (btn.dataset.plane) {
    if (!viewer.models.length) return toast(t('msg.loadFirst'));
    viewer.addPlane(btn.dataset.plane);
    return renderPlanes();
  }
  const actions = {
    fit: () => fitSelection(),
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
  vp.classList.toggle('picking', on);
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

function hideSelected() {
  if (!state.selection.size) return toast(t('msg.selectFirst'));
  for (const [m, set] of state.selection) m.hide(set);
  clearSelection();
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
  $('[data-action="toggle-spaces"]').classList.toggle('on', state.spacesVisible);
  refreshVisibilityUi();
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, .cm-editor')) return;
  if (e.key === 'Escape') {
    if (state.pickPlaneMode) setPickPlaneMode(false);
    else if (measure.cancel()) { /* handled by the measure tool */ }
    else clearSelection();
  } else if (e.key === 'f' || e.key === 'F') fitSelection();
  else if (e.key === 'H' && e.shiftKey) showAll();
  else if (e.key === 'h') hideSelected();
  else if (e.key === 'i' || e.key === 'I') isolateSelected();
  else if (e.key === 'e' || e.key === 'E') setEditMode(!state.editMode);
  else if (e.key === 'm' || e.key === 'M') setMeasureMode(measure.mode ? null : lastMeasureMode);
  else if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); $('#file-input').click(); }
});

// ========================================================================= tabs
for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === tab);
    for (const b of $$('.tab-body')) b.classList.toggle('active', b.id === `tab-${tab.dataset.tab}`);
  });
}

function renderAll() {
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
      h('div', { class: 'card-head' }, vis, dot, h('span', { class: 'card-name', title: m.name, text: m.name })),
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

function saveIfc(model) {
  const name = model.changes.length ? model.name.replace(/(\.ifc)?$/i, '_edited.ifc') : model.name;
  download(name, model.getBytes(), 'application/x-step');
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
  row.addEventListener('click', (e) => {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    if (rootModel || groupChildren) { select(model, ids, { additive }); return; }
    select(model, ids.length ? ids : [id], { activeId: id, additive });
  });
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    const allHidden = ids.every((x) => model.isHidden(x));
    if (allHidden) model.show(ids); else model.hide(ids);
    refreshVisibilityUi();
  });

  const key = groupKey ?? (rootModel ? `${model.uid}:model` : `${model.uid}:${id}`);
  treeRegistry.set(key, { row, expand, ids, eye, model });
  updateEye(treeRegistry.get(key));
  if (open) expand();
  return li;
}

function renderChildren(model, node, children, ul, isGroup) {
  const parentSpatial = !isGroup && node.expressID !== -1 && isSpatialType(model.typeName(node.expressID));
  if (!parentSpatial) {
    for (const c of children) ul.append(treeNode(model, c, { open: node.expressID === -1 }));
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
      row.addEventListener('click', (e) => select(m, ids.length ? ids : [item.id], { activeId: item.id, additive: e.ctrlKey || e.metaKey || e.shiftKey }));
      row.addEventListener('dblclick', () => { const b = m.getBox([item.id]); if (!b.isEmpty()) viewer.fitBox(b); });
      treeRegistry.set(`${m.uid}:${item.id}`, { row, expand: () => {}, ids, model: m });
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
  for (const m of viewer.models) {
    const ul = h('ul');
    for (const [cls, ids] of [...m.classes].sort((a, b) => a[0].localeCompare(b[0]))) {
      const allHidden = ids.every((x) => m.isHidden(x));
      const eye = h('button', { class: `eye${allHidden ? ' off' : ''}`, title: t('classes.toggle') });
      eye.innerHTML = allHidden ? EYE_OFF : EYE;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ids.every((x) => m.isHidden(x))) {
          m.show(ids);
          if (cls === 'IfcSpace' && !state.spacesVisible) { state.spacesVisible = true; $('[data-action="toggle-spaces"]').classList.add('on'); }
        } else m.hide(ids);
        refreshVisibilityUi();
      });
      const row = h('div', { class: `node${allHidden ? ' dim' : ''}` }, eye, h('span', { class: 'lbl', text: cls }), h('span', { class: 'count', text: fmtNum(ids.length) }));
      row.addEventListener('click', (e) => select(m, ids, { additive: e.ctrlKey || e.metaKey || e.shiftKey }));
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
  root.replaceChildren(...parts);
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
  return h('details', { class: `sec${sec.kind === 'qto' ? ' qto' : ''}`, open: sec.open },
    h('summary', {}, h('span', { text: sec.title }), h('span', { class: 'badge', text: badge })),
    warn ? h('div', { class: 'warn', text: warn }) : null,
    h('table', { class: 'props' }, tbody),
  );
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
  renderStatus();
  if (!viewer.planes.length) return;

  for (const p of viewer.planes) {
    const range = viewer.planeRange(p);
    const step = (range.max - range.min) / 1000;
    const enabled = h('input', { type: 'checkbox', checked: p.enabled, title: t('planes.active') });
    enabled.addEventListener('change', () => viewer.togglePlane(p, enabled.checked));
    const slider = h('input', { type: 'range', min: String(range.min), max: String(range.max), step: String(step), value: String(viewer.getPlanePos(p)) });
    const val = h('div', { class: 'val' });
    const upd = () => { val.textContent = `${viewer.getPlanePos(p).toFixed(3)} m`; };
    slider.addEventListener('input', () => { viewer.setPlanePos(p, +slider.value); upd(); });
    upd();
    const name = p.boxPart ? `${t('planes.boxPart')} ${p.axis === 'y' ? 'Z' : p.axis === 'z' ? 'Y' : 'X'} ${p.boxPart}` : t(AXIS_LABEL[p.axis]);
    list.append(h('div', { class: 'plane-row' },
      enabled,
      h('span', { class: 'pl-name', text: name }),
      slider,
      h('button', { title: t('planes.flip'), text: '⇄', onclick: () => { viewer.flipPlane(p); renderPlanes(); } }),
      h('button', { title: t('planes.remove'), text: '✕', onclick: () => { viewer.removePlane(p); renderPlanes(); } }),
      val,
    ));
  }
}
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
  const name = ($('#merge-name').value.trim() || 'merged.ifc').replace(/(\.ifc)?$/i, '.ifc');
  const replace = $('#merge-replace').checked;
  const dl = $('#merge-download').checked;
  $('#merge-dialog').close();
  const keys = models.map((m) => String(m.uid));
  const code = `_merged = merge_models([_files[k] for k in ${JSON.stringify(keys)}])
print("${t('merge.done')}:", len(_merged.by_type("IfcProduct")), "IfcProduct")
app.add_model(_merged, ${JSON.stringify(name)})
${dl ? `app.download(_merged, ${JSON.stringify(name)})` : ''}
del _merged`;
  const ok = await python.runCode(code, { title: t('merge.running'), show: true });
  if (ok && replace) {
    for (const m of models) {
      state.selection.delete(m);
      if (state.active?.model === m) state.active = null;
      viewer.removeModel(m);
    }
    afterModelsChanged();
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
        download(a.name, a.text, /\.csv$/i.test(a.name) ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8');
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
  if (viewer.models.some((m) => m.changes.length)) { e.preventDefault(); e.returnValue = ''; }
});

renderAll();

// For debugging in the console
window.onlineIfc = { viewer, state, openFiles, python, measure };
