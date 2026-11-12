// Quantity takeoff: a table of counts and summed quantities, grouped by up to two properties.
// Values come from the property index (attributes, property sets, IFC quantity sets and the
// quantities calculated from the 3D geometry).
import { t, fmtNum } from './i18n.js';
import { keyLabel } from './filters.js';

const CALC = [['calc:volume', 'm³'], ['calc:area', 'm²'], ['calc:planArea', 'm²'], ['calc:length', 'm']];
const NONE = '';

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '');

export class QtoTable {
  /** ctx: {viewer, h, toast, download, state, ensureIndex(), setSelection(Map)} */
  constructor(ctx, dialog) {
    this.ctx = ctx;
    this.dialog = dialog;
    this.group1 = 'attr:Class';
    this.group2 = NONE;
    this.extra = NONE; // an additional numeric property to sum (e.g. a Qto_ quantity)
    this.scope = 'visible';
    this.sort = { col: 'label', dir: 1 };
    this.result = null;
  }

  async open() {
    if (!this.ctx.viewer.models.length) return this.ctx.toast(t('msg.loadFirst'));
    await this.ctx.ensureIndex();
    this.scope = this.ctx.state.selection.size ? 'selection' : 'visible';
    this.compute();
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** All index keys of the loaded models: {key, numeric}. */
  #keys() {
    const all = new Map();
    for (const m of this.ctx.viewer.models) {
      for (const [k, info] of m._pindex?.keys || []) {
        const prev = all.get(k);
        all.set(k, { numeric: (prev ? prev.numeric : true) && info.numeric, count: (prev?.count || 0) + info.count });
      }
    }
    return all;
  }

  #elements() {
    const { viewer, state } = this.ctx;
    const out = [];
    for (const m of viewer.models) {
      if (this.scope === 'selection') {
        for (const id of state.selection.get(m) || []) out.push([m, id]);
      } else {
        if (!m.visible) continue;
        for (const id of m.elementIds) if (!m.hidden.has(id)) out.push([m, id]);
      }
    }
    return out;
  }

  compute() {
    const groups = new Map();
    const cols = [...CALC.map(([k]) => k), ...(this.extra ? [this.extra] : [])];
    const blank = () => ({ count: 0, sums: Object.fromEntries(cols.map((c) => [c, 0])), has: Object.fromEntries(cols.map((c) => [c, false])), ids: new Map() });
    const total = blank();
    const label = (v) => (v === undefined || v === '' ? t('qto.unset') : String(v));
    for (const [m, id] of this.#elements()) {
      const d = m._pindex?.data.get(id);
      if (!d) continue;
      const g1 = label(d[this.group1]);
      const g2 = this.group2 ? label(d[this.group2]) : null;
      const key = g2 === null ? g1 : `${g1}\u0000${g2}`;
      let g = groups.get(key);
      if (!g) { g = { ...blank(), g1, g2 }; groups.set(key, g); }
      for (const tgt of [g, total]) {
        tgt.count++;
        for (const c of cols) {
          const v = d[c];
          if (typeof v === 'number') { tgt.sums[c] += v; tgt.has[c] = true; }
        }
        if (!tgt.ids.has(m)) tgt.ids.set(m, []);
        tgt.ids.get(m).push(id);
      }
    }
    this.result = { cols, rows: [...groups.values()], total };
  }

  #sorted() {
    const { col, dir } = this.sort;
    const rows = [...this.result.rows];
    const val = (r) => (col === 'label' ? null : col === 'count' ? r.count : r.sums[col]);
    rows.sort((a, b) => {
      if (col === 'label') return dir * (a.g1.localeCompare(b.g1, undefined, { numeric: true }) || (a.g2 || '').localeCompare(b.g2 || '', undefined, { numeric: true }));
      return dir * (val(a) - val(b));
    });
    return rows;
  }

  #keySelect(value, onChange, { numeric = false, allowNone = false } = {}) {
    const { h } = this.ctx;
    const keys = [...this.#keys()].filter(([k, info]) => (numeric ? info.numeric && !k.startsWith('calc:') : !k.startsWith('calc:')));
    const groups = { attr: [], pset: [] };
    for (const [k] of keys) (groups[k.split(':')[0]] || groups.pset).push(k);
    groups.pset.sort();
    const sel = h('select', { class: 'sm' },
      allowNone ? h('option', { value: NONE, text: t('qto.none'), selected: value === NONE }) : null,
      ...Object.entries(groups).filter(([, ks]) => ks.length).map(([g, ks]) => h('optgroup', { label: t(g === 'attr' ? 'flt.groupAttr' : 'qto.groupPset') },
        ks.map((k) => h('option', { value: k, text: keyLabel(k), selected: k === value })))));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  render() {
    const { h } = this.ctx;
    const r = this.result;
    const recompute = () => { this.compute(); this.render(); };
    const scope = h('select', { class: 'sm' },
      h('option', { value: 'visible', text: t('qto.scopeVisible'), selected: this.scope === 'visible' }),
      h('option', { value: 'selection', text: t('qto.scopeSelection'), selected: this.scope === 'selection' }));
    scope.addEventListener('change', () => { this.scope = scope.value; recompute(); });
    const controls = h('div', { class: 'qto-controls' },
      h('label', { class: 'field' }, h('span', { text: t('qto.scope') }), scope),
      h('label', { class: 'field' }, h('span', { text: t('qto.group1') }), this.#keySelect(this.group1, (v) => { this.group1 = v; recompute(); })),
      h('label', { class: 'field' }, h('span', { text: t('qto.group2') }), this.#keySelect(this.group2, (v) => { this.group2 = v; recompute(); }, { allowNone: true })),
      h('label', { class: 'field' }, h('span', { text: t('qto.extra') }), this.#keySelect(this.extra, (v) => { this.extra = v; recompute(); }, { numeric: true, allowNone: true })));

    const head = (col, text, num = true) => {
      const arrow = this.sort.col === col ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return h('th', { class: num ? 'num' : '', text: text + arrow, onclick: () => { this.sort = { col, dir: this.sort.col === col ? -this.sort.dir : (col === 'label' ? 1 : -1) }; this.render(); } });
    };
    const colTitle = (c) => (c.startsWith('calc:') ? keyLabel(c) : keyLabel(c));
    const thead = h('thead', {}, h('tr', {},
      head('label', keyLabel(this.group1), false),
      this.group2 ? h('th', { text: keyLabel(this.group2) }) : null,
      head('count', t('qto.count')),
      r.cols.map((c) => head(c, colTitle(c)))));
    const cell = (g, c) => h('td', { class: 'num', text: g.has[c] ? fmt(g.sums[c]) : '' });
    const tbody = h('tbody', {}, this.#sorted().map((g) => {
      const tr = h('tr', { title: t('qto.rowTitle') },
        h('td', { text: g.g1 }), this.group2 ? h('td', { text: g.g2 }) : null,
        h('td', { class: 'num', text: fmtNum(g.count) }), r.cols.map((c) => cell(g, c)));
      tr.addEventListener('click', () => this.ctx.setSelection(g.ids));
      return tr;
    }));
    const tfoot = h('tfoot', {}, h('tr', {},
      h('td', { text: t('qto.total') }), this.group2 ? h('td') : null,
      h('td', { class: 'num', text: fmtNum(r.total.count) }), r.cols.map((c) => cell(r.total, c))));
    const table = r.rows.length
      ? h('div', { class: 'qto-wrap' }, h('table', { class: 'qto-table' }, thead, tbody, tfoot))
      : h('div', { class: 'empty-hint', text: t('qto.empty') });
    this.dialog.replaceChildren(
      h('h2', { text: t('qto.title') }),
      h('p', { class: 'muted small', text: t('qto.intro') }),
      controls, table,
      h('div', { class: 'dialog-btns' },
        h('button', { class: 'btn', text: t('qto.csv'), onclick: () => this.ctx.download('quantities.csv', this.csv(), 'text/csv;charset=utf-8') }),
        h('button', { class: 'btn primary', text: t('common.close'), onclick: () => this.dialog.close() })));
  }

  csv() {
    const r = this.result;
    const esc = (v) => { const s = String(v ?? ''); return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const dec = (1.5).toLocaleString().charAt(1); // decimal separator of the user's locale (Excel reads it that way)
    const num = (g, c) => (g.has[c] ? String(Math.round(g.sums[c] * 1000) / 1000).replace('.', dec) : '');
    const header = [keyLabel(this.group1), ...(this.group2 ? [keyLabel(this.group2)] : []), t('qto.count'), ...r.cols.map((c) => keyLabel(c))];
    const lines = [header, ...this.#sorted().map((g) => [g.g1, ...(this.group2 ? [g.g2] : []), g.count, ...r.cols.map((c) => num(g, c))]),
      [t('qto.total'), ...(this.group2 ? [''] : []), r.total.count, ...r.cols.map((c) => num(r.total, c))]];
    return '﻿' + lines.map((l) => l.map(esc).join(';')).join('\r\n');
  }
}
