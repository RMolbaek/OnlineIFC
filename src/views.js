// Saved views (camera, visibility, colours, sections, selection) and the workspace file.
// A view is a BCF-style viewpoint (elements are referenced by GlobalId, so views keep working
// with a newer version of the model) plus some extra viewer state (model colour/opacity, X-ray).
// The workspace file (.onlineifc.json) holds the saved views and the issues, but not the IFC files.
import { t, fmtNum } from './i18n.js';
import { uuid, guidOf, guidIndex, captureViewpoint, applyViewpoint } from './bcf.js';

const STORE_KEY = 'onlineifc.views';
const THUMB_W = 240;

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export class ViewsPanel {
  /** ctx: {viewer, h, toast, download, root, state, issues, setSelection, setSpacesVisible, afterVisibility, setOrtho, setXray} */
  constructor(ctx) {
    this.ctx = ctx;
    this.views = [];
    this.editing = null;
    try { this.views = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { this.views = []; }
  }

  #persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.views)); } catch { /* quota or private mode: views stay for this session */ }
  }

  #thumb() {
    const v = this.ctx.viewer;
    const src = v.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = THUMB_W;
    c.height = Math.round((src.height / src.width) * THUMB_W) || 135;
    v.renderer.render(v.scene, v.camera);
    const g = c.getContext('2d');
    // the canvas is transparent (the page background shows through), JPEG needs a solid one
    const bg = getComputedStyle(v.container).backgroundColor;
    g.fillStyle = bg && !bg.startsWith('rgba(0, 0, 0, 0') && bg !== 'transparent' ? bg : (document.documentElement.dataset.theme === 'dark' ? '#1d2127' : '#e9edf2');
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }

  /** The current view as a plain JSON object. */
  capture(name) {
    const { viewer, state } = this.ctx;
    const vp = captureViewpoint({ viewer, selection: state.selection, spacesVisible: state.spacesVisible });
    const models = viewer.models.map((m) => ({
      name: m.name, visible: m.visible, opacity: m.opacity,
      color: m.overrideColor ? `#${m.overrideColor.getHexString()}` : null,
    }));
    const opacity = {};
    for (const m of viewer.models) {
      for (const [id, op] of m.elementOpacity) {
        const g = guidOf(m, id);
        if (!g) continue;
        (opacity[op] ||= []).push(g);
      }
    }
    return {
      id: uuid(), name, created: new Date().toISOString(), thumb: this.#thumb(),
      viewpoint: vp, models, opacity, xray: !!state.xray,
    };
  }

  apply(view) {
    const { viewer } = this.ctx;
    const missing = applyViewpoint(view.viewpoint, this.ctx);
    const byName = new Map((view.models || []).map((x) => [x.name, x]));
    for (const m of viewer.models) {
      const s = byName.get(m.name);
      m.setColor(s?.color || null);
      m.setOpacity(s?.opacity ?? 1);
      if (s && s.visible === false) m.setVisible(false);
    }
    const idx = guidIndex(viewer.models);
    for (const m of viewer.models) m.resetElementOpacity();
    for (const [op, guids] of Object.entries(view.opacity || {})) {
      const per = new Map();
      for (const g of guids) for (const { model, id } of idx.get(g) || []) {
        if (!per.has(model)) per.set(model, []);
        per.get(model).push(id);
      }
      for (const [m, ids] of per) m.setElementOpacity(ids, Number(op));
    }
    this.ctx.setXray?.(!!view.xray);
    this.ctx.afterVisibility?.();
    if (missing) this.ctx.toast(t('bcf.missing', { n: fmtNum(missing) }));
  }

  add(name) {
    if (!this.ctx.viewer.models.length) return this.ctx.toast(t('msg.loadFirst'));
    this.views.push(this.capture(name || t('views.defaultName', { n: this.views.length + 1 })));
    this.#persist();
    this.render();
  }

  // ------------------------------------------------------------------ workspace
  /** Workspace as JSON text: models (names only), saved views and issues. */
  workspaceJson() {
    const { viewer, issues } = this.ctx;
    const topics = (issues?.topics || []).map((tp) => ({
      ...tp,
      viewpoints: tp.viewpoints.map(({ _url, snapshot, ...vp }) => ({ ...vp, snapshot: snapshot ? toB64(snapshot) : null })),
    }));
    return JSON.stringify({
      app: 'OnlineIFC', format: 'workspace', version: 1, saved: new Date().toISOString(),
      models: viewer.models.map((m) => ({ name: m.name, schema: m.schema, fileSize: m.fileSize })),
      current: this.capture('current'),
      views: this.views,
      issues: topics,
    }, null, 1);
  }

  saveWorkspace() {
    const { viewer, download } = this.ctx;
    const base = viewer.models[0]?.name.replace(/\.ifc$/i, '') || 'workspace';
    download(`${base}.onlineifc.json`, new TextEncoder().encode(this.workspaceJson()), 'application/json');
  }

  async openWorkspace(file) {
    const { viewer, issues, toast } = this.ctx;
    let ws;
    try {
      ws = JSON.parse(await file.text());
      if (ws.format !== 'workspace') throw new Error('format');
    } catch {
      toast(t('views.badFile'));
      return;
    }
    const known = new Set(this.views.map((v) => v.id));
    for (const v of ws.views || []) if (!known.has(v.id)) this.views.push(v);
    this.#persist();
    if (issues && ws.issues?.length) {
      const have = new Set(issues.topics.map((x) => x.guid));
      for (const tp of ws.issues) {
        if (have.has(tp.guid)) continue;
        tp.viewpoints = (tp.viewpoints || []).map((vp) => ({ ...vp, snapshot: vp.snapshot ? fromB64(vp.snapshot) : null }));
        issues.topics.push(tp);
      }
      issues.render();
    }
    const loaded = new Set(viewer.models.map((m) => m.name));
    const missing = (ws.models || []).map((m) => m.name).filter((n) => !loaded.has(n));
    this.pendingCurrent = missing.length ? ws.current || null : null; // shown as a button once the models are open
    if (missing.length) toast(t('views.openModels', { names: missing.join(', ') }));
    else if (ws.current) this.apply(ws.current);
    this.render();
  }

  // ------------------------------------------------------------------------ UI
  render() {
    const { h, root } = this.ctx;
    const nameInput = h('input', { type: 'text', placeholder: t('views.namePh') });
    const save = () => { this.add(nameInput.value.trim()); };
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) this.openWorkspace(fileInput.files[0]); fileInput.value = ''; });
    const parts = [
      h('div', { class: 'flt-section' },
        h('h3', { text: t('views.saveTitle') }),
        h('div', { class: 'views-add' }, nameInput, h('button', { class: 'btn primary sm', text: t('views.save'), onclick: save }))),
    ];
    if (!this.views.length) parts.push(h('div', { class: 'empty-hint', text: t('views.empty') }));
    const list = h('div', { class: 'views-list' });
    for (const v of this.views) list.append(this.#card(v));
    parts.push(list);
    const restore = this.pendingCurrent
      ? h('button', { class: 'btn sm', text: t('views.restoreWs'), onclick: () => { this.apply(this.pendingCurrent); this.pendingCurrent = null; this.render(); } })
      : null;
    parts.push(h('div', { class: 'flt-section' },
      h('h3', { text: t('views.wsTitle') }),
      h('div', { class: 'muted small', text: t('views.wsDesc') }),
      h('div', { class: 'flt-btns' },
        h('button', { class: 'btn sm', text: t('views.wsSave'), onclick: () => { if (!this.ctx.viewer.models.length) return this.ctx.toast(t('msg.loadFirst')); this.saveWorkspace(); } }),
        h('button', { class: 'btn sm', text: t('views.wsOpen'), onclick: () => fileInput.click() }),
        restore, fileInput)));
    root.replaceChildren(...parts);
  }

  #card(v) {
    const { h } = this.ctx;
    const title = this.editing === v.id
      ? (() => {
        const inp = h('input', { type: 'text', value: v.name, class: 'views-rename' });
        const done = () => { v.name = inp.value.trim() || v.name; this.editing = null; this.#persist(); this.render(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { this.editing = null; this.render(); } });
        inp.addEventListener('blur', done);
        setTimeout(() => inp.focus(), 0);
        return inp;
      })()
      : h('b', { text: v.name });
    const card = h('div', { class: 'view-card', title: t('views.applyTitle') },
      v.thumb ? h('img', { src: v.thumb, alt: '' }) : h('div', { class: 'view-noimg' }),
      h('div', { class: 'view-meta' }, title,
        h('small', { class: 'muted', text: new Date(v.created).toLocaleString() }),
        h('div', { class: 'view-btns' },
          h('button', { class: 'btn xs', text: t('views.update'), title: t('views.updateTitle'), onclick: (e) => { e.stopPropagation(); Object.assign(v, { ...this.capture(v.name), id: v.id }); this.#persist(); this.render(); } }),
          h('button', { class: 'btn xs', text: t('views.rename'), onclick: (e) => { e.stopPropagation(); this.editing = v.id; this.render(); } }),
          h('button', { class: 'btn xs', text: '↑', title: t('views.up'), onclick: (e) => { e.stopPropagation(); this.#move(v, -1); } }),
          h('button', { class: 'btn xs danger', text: '✕', title: t('views.delete'), onclick: (e) => { e.stopPropagation(); this.views = this.views.filter((x) => x !== v); this.#persist(); this.render(); } }))));
    card.addEventListener('click', (e) => { if (e.target.closest('input')) return; this.apply(v); });
    return card;
  }

  #move(v, d) {
    const i = this.views.indexOf(v), j = i + d;
    if (j < 0 || j >= this.views.length) return;
    [this.views[i], this.views[j]] = [this.views[j], this.views[i]];
    this.#persist();
    this.render();
  }
}
