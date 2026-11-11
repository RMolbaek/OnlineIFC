// OnlineIFC – brugerflade.
import { Viewer } from './viewer.js';
import { loadIfcFile } from './ifc.js';
import { isSpatialType } from './model.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
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
const state = {
  selection: new Map(), // model -> Set(expressID)
  active: null, // {model, id}
  pickPlaneMode: false,
  spacesVisible: false,
};

// ======================================================================= filer
async function openFiles(files) {
  const list = [...files].filter((f) => /\.ifc$/i.test(f.name));
  if (!list.length) { toast('Vælg venligst en eller flere .ifc-filer.'); return; }
  const loading = $('#loading');
  loading.hidden = false;
  try {
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
      try {
        const model = await loadIfcFile(file, {
          onProgress: (msg, frac) => {
            $('#loading-text').textContent = prefix + msg;
            $('#loading-bar').style.width = `${Math.round(((i + frac) / list.length) * 100)}%`;
          },
        });
        viewer.addModel(model);
        if (state.spacesVisible) model.show(model.spaceIds);
      } catch (err) {
        console.error(err);
        toast(`Kunne ikke indlæse ${file.name}: ${err.message || err}`);
      }
    }
  } finally {
    loading.hidden = true;
  }
  $('#welcome').hidden = viewer.models.length > 0;
  renderAll();
  viewer.fitBox(viewer.sceneBox(), { keepDirection: viewer.models.length > list.length });
}

for (const input of [$('#file-input'), $('#file-input-2')]) {
  input.addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
}

// Træk-og-slip
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

// ================================================================== markering
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
  // marker rækker i træet
  for (const el of $$('.node.selected')) el.classList.remove('selected');
  for (const [m, set] of state.selection) {
    for (const id of set) treeRegistry.get(`${m.uid}:${id}`)?.row.classList.add('selected');
  }
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
  if (state.pickPlaneMode) {
    if (hit?.normal) {
      // Læg planet 2 cm inde bag fladen, så selve snittet bliver synligt.
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

// ================================================================ værktøjslinje
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action],[data-view],[data-plane]');
  if (!btn) return;
  if (btn.dataset.view) return viewer.setView(btn.dataset.view);
  if (btn.dataset.plane) {
    if (!viewer.models.length) return toast('Indlæs en model først.');
    viewer.addPlane(btn.dataset.plane);
    return renderPlanes();
  }
  const a = btn.dataset.action;
  const actions = {
    fit: () => fitSelection(),
    'plane-face': () => {
      if (!viewer.models.length) return toast('Indlæs en model først.');
      setPickPlaneMode(!state.pickPlaneMode);
    },
    'section-box': () => {
      if (!viewer.models.length) return toast('Indlæs en model først.');
      viewer.clearPlanes();
      viewer.addSectionBox(selectionBox() || viewer.sceneBox());
      renderPlanes();
    },
    'clear-planes': () => { viewer.clearPlanes(); renderPlanes(); },
    hide: () => hideSelected(),
    isolate: () => isolateSelected(),
    'show-all': () => showAll(),
    'toggle-spaces': () => toggleSpaces(),
    screenshot: () => {
      const a = h('a', { href: viewer.screenshot(), download: `onlineifc-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png` });
      a.click();
    },
    help: () => $('#help-dialog').showModal(),
    'color-by-model': () => {
      viewer.models.forEach((m, i) => m.setColor(PALETTE[i % PALETTE.length]));
      renderModels();
    },
    'reset-colors': () => { for (const m of viewer.models) m.setColor(null); renderModels(); },
  };
  actions[a]?.();
});

function setPickPlaneMode(on) {
  state.pickPlaneMode = on;
  $('[data-action="plane-face"]').classList.toggle('on', on);
  vp.classList.toggle('picking', on);
  const hint = $('#mode-hint');
  hint.hidden = !on;
  hint.textContent = 'Klik på en flade for at lægge et snit – Esc for at afbryde';
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
  if (!state.selection.size) return toast('Vælg først et eller flere elementer.');
  for (const [m, set] of state.selection) m.hide(set);
  clearSelection();
  refreshVisibilityUi();
}

function isolateSelected() {
  if (!state.selection.size) return toast('Vælg først et eller flere elementer.');
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
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (state.pickPlaneMode) setPickPlaneMode(false);
    else clearSelection();
  } else if (e.key === 'f' || e.key === 'F') fitSelection();
  else if (e.key === 'H' && e.shiftKey) showAll();
  else if (e.key === 'h') hideSelected();
  else if (e.key === 'i' || e.key === 'I') isolateSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); $('#file-input').click(); }
});

// ========================================================================= faner
for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.tab')) t.classList.toggle('active', t === tab);
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

// ===================================================================== modeller
function renderModels() {
  const list = $('#model-list');
  list.replaceChildren();
  $('#models-empty').hidden = viewer.models.length > 0;
  $('#model-actions').hidden = viewer.models.length === 0;

  for (const m of viewer.models) {
    const colorInput = h('input', { type: 'color', value: m.overrideColor ? `#${m.overrideColor.getHexString()}` : '#b0b0b0', title: 'Modelfarve' });
    colorInput.addEventListener('input', () => { m.setColor(colorInput.value); dot.style.background = colorInput.value; });
    const dot = h('span', { class: 'swatch-dot' });
    dot.style.background = m.overrideColor ? `#${m.overrideColor.getHexString()}` : 'conic-gradient(#e15759, #edc948, #59a14f, #4e79a7, #e15759)';

    const opacity = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(m.opacity) });
    const opVal = h('span', { class: 'muted', text: `${Math.round(m.opacity * 100)} %` });
    opacity.addEventListener('input', () => { m.setOpacity(+opacity.value); opVal.textContent = `${Math.round(+opacity.value * 100)} %`; });

    const vis = h('input', { type: 'checkbox', title: 'Vis/skjul model', checked: m.visible });
    vis.addEventListener('change', () => { m.setVisible(vis.checked); renderStatus(); });

    const card = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, vis, dot, h('span', { class: 'card-name', title: m.name, text: m.name })),
      h('div', { class: 'card-meta', text: `${m.schema} · ${m.elementIds.size.toLocaleString('da-DK')} elementer · ${fmtBytes(m.fileSize)}` }),
      h('div', { class: 'card-row' }, h('label', { text: 'Farve' }), colorInput,
        h('button', { onclick: () => { m.setColor(null); renderModels(); }, text: 'Original' })),
      h('div', { class: 'card-row' }, h('label', { text: 'Gennemsigtig' }), opacity, opVal),
      h('div', { class: 'card-btns' },
        h('button', { onclick: () => viewer.fitBox(m.getBox()), text: 'Zoom til' }),
        h('button', { onclick: () => exportCsv(m), text: 'Eksportér egenskaber (CSV)' }),
        h('button', {
          onclick: () => {
            if (!confirm(`Fjern ${m.name} fra visningen?`)) return;
            state.selection.delete(m);
            if (state.active?.model === m) state.active = null;
            viewer.removeModel(m);
            $('#welcome').hidden = viewer.models.length > 0;
            renderAll();
          },
          text: 'Fjern',
        }),
      ),
    );
    list.append(card);
  }
}

async function exportCsv(model) {
  const loading = $('#loading');
  loading.hidden = false;
  $('#loading-text').textContent = `Samler egenskaber fra ${model.name}…`;
  try {
    const { cols, rows } = await model.exportRows((f) => { $('#loading-bar').style.width = `${Math.round(f * 100)}%`; });
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = '﻿' + [cols.map(esc).join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    h('a', { href: url, download: model.name.replace(/\.ifc$/i, '') + '-egenskaber.csv' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    console.error(e);
    toast(`Eksport mislykkedes: ${e.message || e}`);
  } finally {
    loading.hidden = true;
  }
}

// ======================================================================= træ
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
    root.append(h('div', { class: 'empty-hint', text: 'Indlæs en model for at se dens struktur.' }));
    return;
  }
  const ul = h('ul');
  for (const m of viewer.models) {
    const modelNode = { expressID: -1, children: [m.tree], __model: true };
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
  const eye = h('button', { class: 'eye', title: 'Vis/skjul' });
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
    if (rootModel) { select(model, ids, { additive }); return; }
    if (groupChildren) { select(model, ids, { additive }); return; }
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
  if (!parentSpatial || isGroup || node.expressID === -1) {
    for (const c of children) ul.append(treeNode(model, c, { open: node.expressID === -1 }));
    return;
  }
  // Under rumlige noder: rumlige børn først, derefter elementer grupperet efter klasse
  const groups = new Map();
  for (const c of children) {
    const t0 = model.typeName(c.expressID);
    if (isSpatialType(t0)) ul.append(treeNode(model, c, { open: t0 === 'IfcSite' || t0 === 'IfcBuilding' }));
    else {
      const t = model.typeName(c.expressID);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(c);
    }
  }
  for (const [t, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    ul.append(treeNode(model, node, { label: t, cls: t, groupChildren: list, groupKey: `${model.uid}:${node.expressID}:cls:${t}` }));
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

// Søgning i struktur
const searchIndex = new WeakMap();
function buildIndex(model) {
  if (searchIndex.has(model)) return searchIndex.get(model);
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
  searchIndex.set(model, out);
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
      if (!terms.every((t) => item.hay.includes(t))) continue;
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
  root.append(h('div', { class: 'muted', style: 'padding:0 4px 6px', text: total > LIMIT ? `${total} resultater – viser de første ${LIMIT}` : `${total} resultater` }));
  root.append(h('div', { class: 'tree' }, ul));
  applyTreeSelection();
}

let searchTimer = null;
$('#tree-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderTree, 250);
});

// ===================================================================== klasser
function renderClasses() {
  const root = $('#classes');
  root.replaceChildren();
  if (!viewer.models.length) {
    root.append(h('div', { class: 'empty-hint', text: 'Indlæs en model for at se dens IFC-klasser.' }));
    return;
  }
  for (const m of viewer.models) {
    const ul = h('ul');
    for (const [cls, ids] of [...m.classes].sort((a, b) => a[0].localeCompare(b[0]))) {
      const allHidden = ids.every((x) => m.isHidden(x));
      const eye = h('button', { class: `eye${allHidden ? ' off' : ''}`, title: 'Vis/skjul klasse' });
      eye.innerHTML = allHidden ? EYE_OFF : EYE;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ids.every((x) => m.isHidden(x))) {
          m.show(ids);
          if (cls === 'IfcSpace' && !state.spacesVisible) { state.spacesVisible = true; $('[data-action="toggle-spaces"]').classList.add('on'); }
        } else m.hide(ids);
        refreshVisibilityUi();
      });
      const row = h('div', { class: `node${allHidden ? ' dim' : ''}` }, eye, h('span', { class: 'lbl', text: cls }), h('span', { class: 'count', text: ids.length.toLocaleString('da-DK') }));
      row.addEventListener('click', (e) => select(m, ids, { additive: e.ctrlKey || e.metaKey || e.shiftKey }));
      row.addEventListener('dblclick', () => { const b = m.getBox(ids); if (!b.isEmpty()) viewer.fitBox(b); });
      ul.append(h('li', {}, row));
    }
    root.append(h('div', { class: 'tree' }, h('div', { class: 'node model-root' }, h('span', { class: 'lbl', text: m.name })), ul));
  }
}

// ================================================================== egenskaber
let propsToken = 0;
async function renderProps() {
  const token = ++propsToken;
  const root = $('#props');
  const count = selectionCount();
  if (!state.active && !count) {
    root.replaceChildren(h('div', { class: 'empty-hint', text: 'Klik på et element for at se dets metadata.' }));
    return;
  }

  const parts = [];
  if (count > 1 || !state.active) {
    // Oversigt over flere valgte elementer
    const byClass = new Map();
    for (const [m, set] of state.selection) for (const id of set) {
      const t = m.typeName(id);
      byClass.set(t, (byClass.get(t) || 0) + 1);
    }
    parts.push(h('div', { class: 'prop-head' },
      h('div', { class: 'cls', text: 'Markering' }),
      h('div', { class: 'name', text: `${count.toLocaleString('da-DK')} elementer valgt` }),
      h('ul', { class: 'multi-list' }, [...byClass].sort((a, b) => b[1] - a[1]).map(([t, n]) => h('li', {}, h('span', { text: t }), h('span', { class: 'muted', text: n.toLocaleString('da-DK') })))),
    ));
  }

  if (state.active) {
    const { model, id } = state.active;
    let data;
    try {
      data = await model.getElementData(id);
    } catch (e) {
      console.error(e);
      parts.push(h('div', { class: 'empty-hint', text: `Kunne ikke læse egenskaber: ${e.message}` }));
    }
    if (token !== propsToken) return;
    if (data) {
      const guidBtn = h('button', { text: 'Kopiér', onclick: () => { navigator.clipboard?.writeText(data.guid); guidBtn.textContent = 'Kopieret'; } });
      parts.push(h('div', { class: 'prop-head' },
        h('div', { class: 'cls', text: data.cls }),
        h('div', { class: 'name', text: data.name || `#${id}` }),
        data.guid ? h('div', { class: 'guid' }, h('span', { text: data.guid }), guidBtn) : null,
        viewer.models.length > 1 ? h('div', { class: 'muted', text: model.name }) : null,
      ));
      for (const sec of data.sections) parts.push(renderSection(model, sec));
    }
  }
  if (token !== propsToken) return;
  root.replaceChildren(...parts);
  filterProps();
}

function renderSection(model, sec) {
  const tbody = h('tbody');
  for (const [k, v, linkId] of sec.rows) {
    const valueCell = h('td');
    if (sec.links && linkId !== undefined) {
      const a = h('a', { text: v });
      a.addEventListener('click', () => {
        const node = findNode(model.tree, linkId);
        const ids = node ? descendantIds(model, node) : [];
        select(model, ids.length ? ids : [linkId], { activeId: linkId });
        revealInTree(model, linkId);
      });
      valueCell.append(a);
    } else valueCell.textContent = v;
    tbody.append(h('tr', { 'data-k': k.toLowerCase(), 'data-v': String(v).toLowerCase() }, h('td', { text: k }), valueCell));
  }
  return h('details', { class: `sec${sec.kind === 'qto' ? ' qto' : ''}`, open: sec.open },
    h('summary', {}, h('span', { text: sec.title }), h('span', { class: 'badge', text: String(sec.rows.length) })),
    h('table', { class: 'props' }, tbody),
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

// ======================================================================= snit
const AXIS_LABEL = { x: 'Snit X', y: 'Plan', z: 'Snit Y', custom: 'Flade' };

function renderPlanes() {
  const panel = $('#planes-panel');
  const list = $('#plane-list');
  list.replaceChildren();
  panel.hidden = viewer.planes.length === 0;
  const hasPlanes = viewer.planes.length > 0;
  renderStatus();
  if (!hasPlanes) return;

  for (const p of viewer.planes) {
    const range = viewer.planeRange(p);
    const step = (range.max - range.min) / 1000;
    const enabled = h('input', { type: 'checkbox', checked: p.enabled, title: 'Aktiv' });
    enabled.addEventListener('change', () => viewer.togglePlane(p, enabled.checked));
    const slider = h('input', { type: 'range', min: String(range.min), max: String(range.max), step: String(step), value: String(viewer.getPlanePos(p)) });
    const val = h('div', { class: 'val' });
    const upd = () => { val.textContent = `${viewer.getPlanePos(p).toFixed(3)} m`; };
    slider.addEventListener('input', () => { viewer.setPlanePos(p, +slider.value); upd(); });
    upd();
    const name = p.boxPart ? `Kasse ${p.axis === 'y' ? 'Z' : p.axis === 'z' ? 'Y' : 'X'} ${p.boxPart}` : AXIS_LABEL[p.axis];
    list.append(h('div', { class: 'plane-row' },
      enabled,
      h('span', { class: 'pl-name', text: name }),
      slider,
      h('button', { title: 'Vend snitretning', text: '⇄', onclick: () => { viewer.flipPlane(p); renderPlanes(); } }),
      h('button', { title: 'Fjern snit', text: '✕', onclick: () => { viewer.removePlane(p); renderPlanes(); } }),
      val,
    ));
  }
}
$('#plane-helpers').addEventListener('change', (e) => viewer.setHelpersVisible(e.target.checked));
$('#plane-fill').addEventListener('change', (e) => viewer.setSectionFill(e.target.checked));

// ===================================================================== status
function renderStatus() {
  const models = viewer.models.length;
  if (!models) { $('#statusbar').textContent = 'Klar – åbn eller træk IFC-filer ind'; return; }
  let elements = 0, hidden = 0;
  for (const m of viewer.models) { elements += m.elementIds.size; hidden += m.hidden.size; }
  const sel = selectionCount();
  $('#statusbar').textContent = [
    `${models} ${models === 1 ? 'model' : 'modeller'}`,
    `${elements.toLocaleString('da-DK')} elementer`,
    hidden ? `${hidden.toLocaleString('da-DK')} skjult` : null,
    sel ? `${sel.toLocaleString('da-DK')} valgt` : null,
    viewer.planes.length ? `${viewer.planes.length} snit` : null,
  ].filter(Boolean).join('  ·  ');
}

// ===================================================================== hjælpere
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function toast(msg, ok = false) {
  const t = h('div', { class: `toast${ok ? ' ok' : ''}`, text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

renderAll();

// Til fejlsøgning i konsollen
window.onlineIfc = { viewer, state, openFiles };
