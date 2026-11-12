// Projects: the app remembers what you worked on – the IFC files, saved views, issues and the
// current view (camera, sections, visibility, colours) – locally in this browser (IndexedDB).
// A project is created automatically when the first model is opened and saved automatically.
import { t, fmtNum } from './i18n.js';
import * as store from './store.js';

const ENABLED_KEY = 'onlineifc.projects.enabled';
const AUTOSAVE_MS = 4000;

const fmtBytes = (n) => (!n ? "0 MB" : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function relTime(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  const time = d.toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 0) return t('proj.today', { time });
  if (days === 1) return t('proj.yesterday', { time });
  return d.toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export class ProjectManager extends EventTarget {
  /**
   * ctx: {viewer, views, issues, state, h, toast, confirmDiscard(), clearModels(),
   *       openFiles(files, keys) -> Promise, afterRestore()}
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.current = null; // project record (without state) of what is open now
    this.keys = new Map(); // IfcModel -> file key (fingerprint)
    this.saved = new Map(); // IfcModel -> model.version that is stored
    this.fpCache = new WeakMap(); // File/Blob -> fingerprint
    this.timer = null;
    this.restoring = false;
    this.lastSaved = null;
    try { this.enabled = localStorage.getItem(ENABLED_KEY) !== '0'; } catch { this.enabled = true; }
    if (!store.available()) this.enabled = false;
    // save when something changes: user interaction, and when the page is hidden or closed
    const mark = () => this.touch();
    for (const ev of ['pointerup', 'wheel', 'keyup']) window.addEventListener(ev, mark, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.saveNow(); });
    window.addEventListener('pagehide', () => this.saveNow());
  }

  setEnabled(on) {
    this.enabled = on && store.available();
    try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    if (this.enabled && this.ctx.viewer.models.length) this.saveNow();
    this.#emit();
  }

  #emit() { this.dispatchEvent(new Event('change')); }

  async keyOf(blob) {
    let k = this.fpCache.get(blob);
    if (!k) { k = await store.fingerprint(blob); this.fpCache.set(blob, k); }
    return k;
  }

  /** Geometry cache for the loader: {get() -> geometry|null, put(geometry)}. */
  geometryCacheFor(key) {
    if (!this.enabled) return null;
    return {
      get: () => store.getGeometry(key).catch(() => null),
      put: (g) => this.#putGeometry(key, g),
    };
  }

  async #putGeometry(key, g) {
    try {
      const est = await store.estimate();
      const bytes = g.buckets.reduce((a, b) => a + b.positions.byteLength + b.normals.byteLength + b.index.byteLength + b.items.length * 12, 0);
      if (est && est.quota && est.usage + bytes > est.quota * 0.8) return; // not enough room: just skip the cache
      await store.putGeometry(key, g);
      // keep the geometry cache within ~30 % of the available space (oldest caches go first)
      if (est?.quota) await store.trimGeometry(Math.min(est.quota * 0.3, 8e9), new Set(this.keys.values()));
    } catch (e) { console.warn('geometry cache', e); }
  }

  // ----------------------------------------------------------- model events
  /** A model was opened (file = its File/Blob, key = fingerprint). */
  async modelAdded(model, file, key) {
    this.keys.set(model, key);
    this.saved.set(model, model.version);
    if (!this.enabled || this.restoring) return;
    if (!this.current) {
      const now = Date.now();
      const base = model.name.replace(/\.ifc$/i, '');
      this.current = { id: crypto.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`, name: base, created: now, modified: now, files: [] };
    }
    await this.#storeFile(key, model.name, file);
    this.touch(true);
  }

  modelRemoved(model) {
    this.keys.delete(model);
    this.saved.delete(model);
    if (!this.restoring) this.touch(true);
  }

  /** A model was replaced by a new version (Python script, merge "replace"). */
  async modelReplaced(oldModel, model, file, key) {
    this.keys.delete(oldModel);
    this.saved.delete(oldModel);
    await this.modelAdded(model, file, key);
  }

  async #storeFile(key, name, blob) {
    try {
      const have = await store.get('files', key).catch(() => null);
      if (have) return;
      const est = await store.estimate();
      if (est?.quota && est.usage + blob.size > est.quota * 0.9) { this.ctx.toast(t('proj.noSpace', { name })); return; }
      await store.put('files', { key, name, size: blob.size, blob, added: Date.now() });
      store.persist();
    } catch (e) {
      console.warn('store file', e);
      this.ctx.toast(t('proj.storeFailed', { error: e.message || e }));
    }
  }

  // ------------------------------------------------------------------ saving
  /** Something changed: save soon. */
  touch(force = false) {
    if (!this.enabled || this.restoring) return;
    if (!force && !this.current) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), AUTOSAVE_MS);
  }

  async saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled || this.restoring || !this.current) return;
    if (this.saving) { this.again = true; return; }
    this.saving = true;
    try {
      const { viewer, views, issues, state } = this.ctx;
      // edited models: store the edited file as a new version
      for (const m of viewer.models) {
        if (m.changes.length && this.saved.get(m) !== m.version) {
          const blob = new Blob([await m.getBytes()]);
          const key = await this.keyOf(blob);
          await this.#storeFile(key, m.name, blob);
          this.keys.set(m, key);
          this.saved.set(m, m.version);
        }
      }
      const files = viewer.models.filter((m) => this.keys.has(m)).map((m) => ({ key: this.keys.get(m), name: m.name, unitFix: m.unitFix, changes: m.changes.slice(-200).map((c) => ({ time: c.time, description: c.description })) }));
      const current = viewer.models.length ? views.capture('current') : null;
      const rec = {
        ...this.current,
        modified: Date.now(),
        files,
        thumb: current?.thumb || this.current.thumb || null,
        state: {
          current,
          views: views.views,
          issues: (issues.topics || []).map((tp) => ({ ...tp, viewpoints: tp.viewpoints.map(({ _url, ...vp }) => vp) })),
          spacesVisible: !!state.spacesVisible,
          extra: this.ctx.getExtra?.() || null, // e.g. drawn lines
        },
      };
      await store.put('projects', rec);
      const { state: _s, ...meta } = rec;
      this.current = meta;
      this.lastSaved = Date.now();
      this.#emit();
    } catch (e) {
      console.warn('save project', e);
    } finally {
      this.saving = false;
      if (this.again) { this.again = false; this.touch(); }
    }
  }

  // ----------------------------------------------------------------- listing
  async list() {
    if (!store.available()) return [];
    try {
      const projects = await store.all('projects');
      return projects.map(({ state, ...p }) => ({ ...p, views: state?.views?.length || 0, issues: state?.issues?.length || 0 }))
        .sort((a, b) => b.modified - a.modified);
    } catch { return []; }
  }

  async usage() {
    const [files, geom, est] = await Promise.all([store.allMeta('files').catch(() => []), store.allMeta('geom').catch(() => []), store.estimate()]);
    return {
      files: files.reduce((a, f) => a + (f.size || 0), 0),
      geom: geom.reduce((a, g) => a + (g.size || 0), 0),
      fileSizes: new Map(files.map((f) => [f.key, f.size || 0])),
      quota: est?.quota || 0,
    };
  }

  // ------------------------------------------------------------ open / close
  async open(id) {
    const { viewer, views, issues, state } = this.ctx;
    if (this.current?.id === id && viewer.models.length) return;
    const rec = await store.get('projects', id);
    if (!rec) return;
    await this.saveNow(); // keep what is open now
    this.restoring = true;
    try {
      this.ctx.clearModels();
      this.keys.clear();
      this.saved.clear();
      const files = [];
      const keys = [];
      const missing = [];
      for (const f of rec.files) {
        const fr = await store.get('files', f.key).catch(() => null);
        if (!fr) { missing.push(f.name); continue; }
        files.push(new File([fr.blob], f.name, { type: 'application/x-step' }));
        keys.push(f.key);
      }
      if (missing.length) this.ctx.toast(t('proj.missingFiles', { names: missing.join(', ') }));
      const { state: st, ...meta } = rec;
      this.current = meta;
      this.lastSaved = rec.modified;
      views.views = st?.views || [];
      issues.topics = (st?.issues || []).map((tp) => ({ ...tp }));
      state.spacesVisible = !!st?.spacesVisible;
      await this.ctx.openFiles(files, keys);
      this.ctx.setExtra?.(st?.extra || null);
      // change logs of edited models
      viewer.models.forEach((m) => {
        const f = rec.files.find((x) => x.key === this.keys.get(m));
        if (f?.changes?.length) m.changes = f.changes.map((c) => ({ ...c, time: new Date(c.time) }));
        if (f?.unitFix && f.unitFix !== m.unitFix) viewer.setUnitFix(m, f.unitFix); // a unit chosen by hand
        this.saved.set(m, m.version);
      });
      if (st?.current) views.apply(st.current);
      views.render();
      issues.render();
      this.ctx.afterRestore();
      this.ctx.toast(t('proj.opened', { name: rec.name }), true);
    } finally {
      this.restoring = false;
      this.#emit();
    }
  }

  /** Closes the current project (it stays saved) and starts with an empty view. */
  async close() {
    await this.saveNow();
    this.restoring = true;
    try {
      this.ctx.clearModels();
      this.keys.clear();
      this.saved.clear();
      this.current = null;
      this.ctx.views.views = [];
      this.ctx.issues.topics = [];
      this.ctx.views.render();
      this.ctx.issues.render();
    } finally {
      this.restoring = false;
      this.#emit();
    }
  }

  async rename(id, name) {
    const rec = await store.get('projects', id);
    if (!rec) return;
    rec.name = name;
    await store.put('projects', rec);
    if (this.current?.id === id) this.current.name = name;
    this.#emit();
  }

  async remove(id) {
    await store.del('projects', id).catch(() => {});
    if (this.current?.id === id) this.current = null;
    await this.collectGarbage();
    this.#emit();
  }

  /** Deletes stored files that no project uses any more (and their geometry caches). */
  async collectGarbage() {
    try {
      const used = new Set();
      for (const p of await store.all('projects')) for (const f of p.files || []) used.add(f.key);
      for (const k of this.keys.values()) used.add(k);
      for (const f of await store.allMeta('files')) if (!used.has(f.key)) { await store.del('files', f.key); await store.del('geom', f.key).catch(() => {}); }
    } catch (e) { console.warn('cleanup', e); }
  }

  async clearGeometryCache() {
    await store.trimGeometry(0);
    this.#emit();
  }

  // ---------------------------------------------------------------------- UI
  /** Cards of the saved projects (used on the start screen and in the projects dialog). */
  async renderList(root, { limit = 0, compact = false, onOpen = () => {} } = {}) {
    const { h } = this.ctx;
    let list = await this.list();
    if (limit) list = list.slice(0, limit);
    const usage = compact ? null : await this.usage();
    const cards = list.map((p) => {
      const size = usage ? p.files.reduce((a, f) => a + (usage.fileSizes.get(f.key) || 0), 0) : 0;
      const open = async () => { onOpen(); await this.open(p.id); };
      const card = h('div', { class: `proj-card${this.current?.id === p.id ? ' current' : ''}`, title: t('proj.openTitle') },
        p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('div', { class: 'proj-noimg' }),
        h('div', { class: 'proj-meta' },
          h('b', { text: p.name }),
          h('small', { class: 'muted', text: [relTime(p.modified), t('proj.nModels', { n: p.files.length }), p.views ? t('proj.nViews', { n: p.views }) : null, p.issues ? t('proj.nIssues', { n: p.issues }) : null, size ? fmtBytes(size) : null].filter(Boolean).join(' · ') }),
          h('small', { class: 'muted proj-files', text: p.files.map((f) => f.name).join(', ') })),
        compact ? null : h('div', { class: 'proj-btns' },
          h('button', { class: 'btn xs', text: t('views.rename'), onclick: async (e) => { e.stopPropagation(); const n = prompt(t('proj.renamePrompt'), p.name); if (n && n.trim()) { await this.rename(p.id, n.trim()); this.renderList(root, { limit, compact, onOpen }); } } }),
          h('button', { class: 'btn xs danger', text: '✕', title: t('proj.delete'), onclick: async (e) => { e.stopPropagation(); if (confirm(t('proj.deleteConfirm', { name: p.name }))) { await this.remove(p.id); this.renderList(root, { limit, compact, onOpen }); } } })));
      card.addEventListener('click', open);
      return card;
    });
    root.replaceChildren(...cards);
    return list.length;
  }

  statusText() {
    if (!this.enabled) return t('proj.off');
    if (!this.current) return t('proj.none');
    return this.lastSaved ? t('proj.savedAt', { time: new Date(this.lastSaved).toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' }) }) : t('proj.notSavedYet');
  }

  fmtBytes(n) { return fmtBytes(n); }
  fmtNum(n) { return fmtNum(n); }
}
