// Right-click menu for the 3D view and the Structure/Classes lists: hide, isolate or select by
// element, IFC class, presentation layer ("CAD layer"), storey or model.
import { t, fmtNum } from './i18n.js';
import { guidOf } from './bcf.js';

export class ContextMenu {
  /**
   * ctx: {viewer, h, toast, state, select(map, opts), refresh(), showAll(), fitIds(map), clearSelection(),
   *       setModelVisible(model, on)}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.el = ctx.h('div', { class: 'ctx-menu', role: 'menu', hidden: true });
    document.body.append(this.el);
    const close = () => this.close();
    window.addEventListener('pointerdown', (e) => { if (!this.el.hidden && !this.el.contains(e.target)) close(); }, true);
    window.addEventListener('wheel', (e) => { if (!this.el.contains(e.target)) close(); }, { capture: true, passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.el.hidden) { e.stopPropagation(); close(); } }, true);
  }

  close() { this.el.hidden = true; }

  // ------------------------------------------------------------------ helpers
  /** Map(model -> ids) of all elements in all models matching fn(model, id). */
  #matching(fn) {
    const out = new Map();
    for (const m of this.ctx.viewer.models) {
      const ids = [];
      for (const id of m.elementIds) if (fn(m, id)) ids.push(id);
      if (ids.length) out.set(m, ids);
    }
    return out;
  }

  #hide(map) {
    for (const [m, ids] of map) m.hide(ids);
    this.ctx.refresh();
  }

  #isolate(map) {
    for (const m of this.ctx.viewer.models) m.isolate(map.get(m) || []);
    this.ctx.refresh();
  }

  #show(map) {
    for (const [m, ids] of map) { m.setVisible(true); m.show(ids); }
    this.ctx.refresh();
  }

  #count(map) { let n = 0; for (const ids of map.values()) n += ids.length; return n; }

  /** A group of actions (hide / show only / select) for a set of elements. */
  #group(title, map, { show = false } = {}) {
    const n = this.#count(map);
    if (!n) return [];
    const items = [
      { head: `${title}`, sub: t('ctx.count', { n: fmtNum(n) }) },
      { label: t('ctx.hide'), icon: 'hide', run: () => this.#hide(map) },
      { label: t('ctx.isolate'), icon: 'isolate', run: () => this.#isolate(map) },
    ];
    if (show) items.push({ label: t('ctx.show'), icon: 'show', run: () => this.#show(map) });
    items.push({ label: t('ctx.select'), icon: 'select', run: () => this.ctx.select(map) });
    return items;
  }

  // -------------------------------------------------------------------- open
  /** Menu for an element picked in the 3D view (hit = null: empty space). */
  openForHit(hit, x, y) {
    const { state } = this.ctx;
    if (!hit) return this.#openEmpty(x, y);
    const { model, id } = hit;
    // right-clicking an element outside the selection selects it (as in most programs)
    if (!state.selection.get(model)?.has(id)) this.ctx.select(new Map([[model, [id]]]), { activeId: id, model });
    const sel = new Map([...state.selection].map(([m, s]) => [m, [...s]]));
    const nSel = this.#count(sel);
    const items = [];
    items.push({ head: model.label(id), sub: `${model.typeName(id)}${this.ctx.viewer.models.length > 1 ? ` · ${model.displayName}` : ''}` });
    items.push(
      { label: nSel > 1 ? t('ctx.hideSel', { n: fmtNum(nSel) }) : t('ctx.hideEl'), icon: 'hide', kbd: 'H', run: () => { this.#hide(sel); this.ctx.clearSelection(); } },
      { label: nSel > 1 ? t('ctx.isolateSel', { n: fmtNum(nSel) }) : t('ctx.isolateEl'), icon: 'isolate', kbd: 'I', run: () => this.#isolate(sel) },
      { label: t('ctx.transparent'), icon: 'transparent', run: () => { for (const [m, ids] of sel) m.setElementOpacity(ids, 0.25); this.ctx.refresh(); } },
      { label: t('ctx.zoom'), icon: 'zoom', kbd: 'F', run: () => this.ctx.fitIds(sel) },
    );
    const guid = guidOf(model, id);
    if (guid) items.push({ label: t('ctx.copyGuid'), icon: 'copy', run: () => { navigator.clipboard?.writeText(guid); this.ctx.toast(t('ctx.copied', { text: guid }), true); } });

    // the same IFC class in all models
    const cls = model.typeName(id);
    items.push({ sep: true }, ...this.#group(t('ctx.class', { name: cls }), this.#matching((m, x) => m.typeName(x) === cls)));
    // presentation layers of this element
    let layers = [];
    try { layers = model.layerIndex().byElement.get(id) || []; } catch { /* no layer support */ }
    for (const name of layers.slice(0, 3)) {
      const map = new Map();
      for (const m of this.ctx.viewer.models) {
        let ids = [];
        try { ids = m.layerIndex().byLayer.get(name) || []; } catch { /* ignore */ }
        if (ids.length) map.set(m, ids);
      }
      items.push({ sep: true }, ...this.#group(t('ctx.layerName', { name }), map));
    }
    // storey of this element (in this model)
    const st = model.storeyInfo?.(id);
    if (st) {
      const map = this.#matching((m, x) => m === model && m.storeyInfo(x)?.id === st.id);
      items.push({ sep: true }, ...this.#group(t('ctx.storey', { name: st.name }), map));
    }
    // the model
    if (this.ctx.viewer.models.length > 1) {
      items.push({ sep: true }, { head: t('ctx.model', { name: model.displayName }) },
        { label: t('ctx.hideModel'), icon: 'hide', run: () => this.ctx.setModelVisible(model, false) },
        { label: t('ctx.isolateModel'), icon: 'isolate', run: () => { for (const m of this.ctx.viewer.models) this.ctx.setModelVisible(m, m === model); } });
    }
    items.push({ sep: true }, { label: t('ctx.showAll'), icon: 'show', kbd: '⇧H', run: () => this.ctx.showAll() });
    this.#render(items, x, y);
  }

  /** Menu for rows of the Structure / Classes lists: entry {model, ids, label}. */
  openForRow(entry, label, x, y) {
    const map = new Map([[entry.model, entry.ids]]);
    if (!entry.ids.length) return;
    const items = [{ head: label, sub: t('ctx.count', { n: fmtNum(entry.ids.length) }) },
      { label: t('ctx.hide'), icon: 'hide', run: () => this.#hide(map) },
      { label: t('ctx.isolate'), icon: 'isolate', run: () => this.#isolate(map) },
      { label: t('ctx.show'), icon: 'show', run: () => this.#show(map) },
      { label: t('ctx.transparent'), icon: 'transparent', run: () => { entry.model.setElementOpacity(entry.ids, 0.25); this.ctx.refresh(); } },
      { label: t('ctx.select'), icon: 'select', run: () => this.ctx.select(map) },
      { label: t('ctx.zoom'), icon: 'zoom', run: () => this.ctx.fitIds(map) },
      { sep: true }, { label: t('ctx.showAll'), icon: 'show', kbd: '⇧H', run: () => this.ctx.showAll() }];
    this.#render(items, x, y);
  }

  #openEmpty(x, y) {
    const items = [
      { label: t('ctx.showAll'), icon: 'show', kbd: '⇧H', run: () => this.ctx.showAll() },
      { label: t('ctx.zoomAll'), icon: 'zoom', kbd: 'F', run: () => this.ctx.fitIds(null) },
    ];
    if (this.ctx.state.selection.size) items.push({ label: t('ctx.clearSel'), icon: 'clear', kbd: 'Esc', run: () => this.ctx.clearSelection() });
    // layers of all models: quick on/off list
    const layers = new Map();
    for (const m of this.ctx.viewer.models) {
      let idx = null;
      try { idx = m.layerIndex(); } catch { /* ignore */ }
      for (const [name, ids] of idx?.byLayer || []) {
        if (!layers.has(name)) layers.set(name, new Map());
        layers.get(name).set(m, ids);
      }
    }
    if (layers.size) {
      items.push({ sep: true }, { head: t('ctx.layers'), sub: t('ctx.layersHint') });
      for (const [name, map] of [...layers].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
        let shown = 0, total = 0;
        for (const [m, ids] of map) for (const id of ids) { total++; if (m.visible && !m.hidden.has(id)) shown++; }
        items.push({
          label: name, check: shown > 0, sub2: fmtNum(total), keepOpen: true,
          run: (row) => {
            if (shown > 0) this.#hide(map); else this.#show(map);
            shown = shown > 0 ? 0 : total;
            row.querySelector('.ctx-check').textContent = shown > 0 ? '☑' : '☐';
          },
        });
      }
    }
    this.#render(items, x, y);
  }

  // ------------------------------------------------------------------ render
  #render(items, x, y) {
    const { h } = this.ctx;
    const ICON = { hide: '◌', isolate: '◎', show: '●', select: '▣', zoom: '⌕', copy: '⧉', transparent: '◐', clear: '✕' };
    const rows = [];
    for (const it of items) {
      if (it.sep) { if (rows.length && !rows[rows.length - 1].classList.contains('ctx-sep')) rows.push(h('div', { class: 'ctx-sep' })); continue; }
      if (it.head) { rows.push(h('div', { class: 'ctx-head' }, h('b', { text: it.head }), it.sub ? h('small', { text: it.sub }) : null)); continue; }
      const row = h('button', { class: 'ctx-item', role: 'menuitem' },
        h('span', { class: `ctx-icon${it.check !== undefined ? ' ctx-check' : ''}`, text: it.check !== undefined ? (it.check ? '☑' : '☐') : ICON[it.icon] || '' }),
        h('span', { class: 'ctx-label', text: it.label }),
        it.kbd ? h('kbd', { text: it.kbd }) : it.sub2 ? h('small', { class: 'muted', text: it.sub2 }) : null);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!it.keepOpen) this.close();
        it.run(row);
      });
      rows.push(row);
    }
    this.el.replaceChildren(...rows);
    this.el.hidden = false;
    // keep it on screen
    const r = this.el.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 6);
    const py = y + r.height > window.innerHeight - 6 ? Math.max(6, window.innerHeight - r.height - 6) : y;
    this.el.style.left = `${Math.max(6, px)}px`;
    this.el.style.top = `${py}px`;
  }
}
