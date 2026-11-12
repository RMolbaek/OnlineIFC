// "Smart views": colour elements by a property (with legend) and select/isolate/hide/colour
// elements that match rules such as "Pset_WallCommon.IsExternal = True".
import { t, fmtNum } from './i18n.js';

const CATEGORICAL = [0x4e79a7, 0xf28e2b, 0xe15759, 0x76b7b2, 0x59a14f, 0xedc948, 0xb07aa1, 0xff9da7, 0x9c755f, 0x2f9e44, 0x1c7ed6, 0xe8590c,
  0x845ef7, 0x0ca678, 0xd6336c, 0x868e96];
const RAMP = [0x2c7bb6, 0x00a6ca, 0x00ccbc, 0x90eb9d, 0xf9d057, 0xf29e2e, 0xe76818, 0xd7191c];
const MAX_CATEGORIES = 16;
const NO_VALUE_COLOR = 0xb4b9bf;

const ATTR_LABEL = {
  'attr:Model': 'csv.model', 'attr:Class': 'prop.class', 'attr:Name': 'csv.name', 'attr:Storey': 'csv.storey', 'attr:Type': 'sec.type',
  'attr:Material': 'mat.material', 'attr:Layer': 'ctx.layer',
};
const CALC_LABEL = { 'calc:volume': 'q.volume', 'calc:area': 'q.area', 'calc:planArea': 'q.planArea', 'calc:length': 'q.length', 'calc:width': 'q.width', 'calc:height': 'q.height' };
const CALC_UNIT = { 'calc:volume': 'm³', 'calc:area': 'm²', 'calc:planArea': 'm²', 'calc:length': 'm', 'calc:width': 'm', 'calc:height': 'm' };
const OPS = ['eq', 'ne', 'contains', 'notContains', 'gt', 'lt', 'exists', 'missing'];

export function keyLabel(key) {
  if (ATTR_LABEL[key]) return t(ATTR_LABEL[key]);
  if (CALC_LABEL[key]) return `${t(CALC_LABEL[key])} (${CALC_UNIT[key]})`;
  return key.replace(/^(attr|pset|calc):/, '');
}

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
const fmtVal = (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v));

export class FilterPanel {
  /**
   * ctx: { viewer, h, toast, withLoading, setSelection(Map), refreshVisibility(), root }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.colorKey = '';
    this.legend = null; // {key, groups: [{label, color, ids: Map(model -> [ids]), hidden}]}
    this.toneDown = true;
    this.rules = [{ key: 'attr:Class', op: 'eq', value: '' }];
    this.matchAll = true;
    this.indexReady = false;
  }

  /** Builds (or reuses) the property indexes of all models. */
  async ensureIndex() {
    const { viewer, withLoading } = this.ctx;
    const need = viewer.models.filter((m) => !m._pindex || m._pindex.version !== m.version || m._pindex.lang !== this.lang());
    if (need.length) {
      await withLoading(async (progress) => {
        for (let i = 0; i < need.length; i++) {
          const m = need[i];
          m._pindex = null;
          await m.buildPropertyIndex((f) => progress(t('flt.building', { name: m.name }), (i + f) / need.length));
          m._pindex.lang = this.lang();
        }
      });
    }
    this.indexReady = true;
  }

  lang() { return document.documentElement.lang; }

  /** All keys of all models, grouped for the property drop-down. */
  allKeys() {
    const keys = new Map();
    for (const m of this.ctx.viewer.models) {
      for (const [k, info] of m._pindex?.keys || []) {
        const cur = keys.get(k);
        if (!cur) keys.set(k, { ...info });
        else { cur.count += info.count; cur.numeric = cur.numeric && info.numeric; }
      }
    }
    return keys;
  }

  // ------------------------------------------------------------------- render
  render() {
    const { h, viewer } = this.ctx;
    const root = this.ctx.root;
    root.replaceChildren();
    if (!viewer.models.length) {
      root.append(h('div', { class: 'empty-hint', text: t('flt.empty') }));
      return;
    }
    if (!this.indexReady || viewer.models.some((m) => !m._pindex || m._pindex.version !== m.version || m._pindex.lang !== this.lang())) {
      root.append(
        h('p', { class: 'muted small', text: t('flt.intro') }),
        h('button', { class: 'btn primary sm', text: t('flt.start'), onclick: async () => { await this.ensureIndex(); this.render(); } }),
      );
      return;
    }
    const keys = this.allKeys();
    root.append(this.#colorSection(keys), this.#filterSection(keys));
  }

  #keySelect(keys, value, onChange) {
    const { h } = this.ctx;
    const groups = { attr: [], calc: [], pset: new Map() };
    for (const k of [...keys.keys()].sort((a, b) => a.localeCompare(b))) {
      if (k.startsWith('attr:')) groups.attr.push(k);
      else if (k.startsWith('calc:')) groups.calc.push(k);
      else {
        const rest = k.slice(5);
        const dot = rest.indexOf('.');
        const ps = dot > 0 ? rest.slice(0, dot) : rest;
        if (!groups.pset.has(ps)) groups.pset.set(ps, []);
        groups.pset.get(ps).push(k);
      }
    }
    const opt = (k, label) => h('option', { value: k, text: label ?? keyLabel(k), selected: k === value });
    const attrOrder = ['attr:Class', 'attr:Type', 'attr:Storey', 'attr:Layer', 'attr:Material', 'attr:Name', 'attr:ObjectType', 'attr:PredefinedType', 'attr:Tag', 'attr:Description', 'attr:Model'];
    const sel = h('select', { class: 'key-select' },
      h('option', { value: '', text: t('flt.chooseProp'), selected: !value }),
      h('optgroup', { label: t('flt.groupAttr') }, attrOrder.filter((k) => keys.has(k)).map((k) => opt(k))),
      groups.calc.length ? h('optgroup', { label: t('sec.calcQuantities') }, groups.calc.map((k) => opt(k))) : null,
      [...groups.pset].sort((a, b) => a[0].localeCompare(b[0])).map(([ps, list]) =>
        h('optgroup', { label: ps }, list.map((k) => opt(k, k.slice(5 + ps.length + 1))))),
    );
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  #colorSection(keys) {
    const { h } = this.ctx;
    const sel = this.#keySelect(keys, this.colorKey, (k) => { this.colorKey = k; });
    const tone = h('input', { type: 'checkbox', checked: this.toneDown });
    tone.addEventListener('change', () => { this.toneDown = tone.checked; if (this.legend) this.applyColors(); });
    const legend = h('div', { class: 'legend' });
    if (this.legend) {
      for (const g of this.legend.groups) {
        const color = h('input', { type: 'color', value: hex(g.color), title: t('models.color') });
        color.addEventListener('input', () => { g.color = parseInt(color.value.slice(1), 16); this.applyColors(); });
        const count = [...g.ids.values()].reduce((a, l) => a + l.length, 0);
        const eye = h('button', { class: `eye${g.hidden ? ' off' : ''}`, title: t('tree.toggleVisibility'), text: g.hidden ? '◌' : '●' });
        eye.addEventListener('click', (e) => { e.stopPropagation(); g.hidden = !g.hidden; this.#applyLegendVisibility(); this.render(); });
        const row = h('div', { class: `legend-row${g.hidden ? ' dim' : ''}` }, color,
          h('span', { class: 'lbl', text: g.label, title: g.label }), h('span', { class: 'count', text: fmtNum(count) }), eye);
        row.addEventListener('click', (e) => { if (e.target !== color) this.ctx.setSelection(g.ids); });
        legend.append(row);
      }
    }
    return h('section', { class: 'flt-section' },
      h('h3', { text: t('flt.colorBy') }),
      sel,
      h('label', { class: 'chk' }, tone, h('span', { text: t('flt.toneDown') })),
      h('div', { class: 'flt-btns' },
        h('button', { class: 'btn primary sm', text: t('flt.apply'), onclick: () => this.buildLegend() }),
        h('button', { class: 'btn sm', text: t('flt.resetColors'), onclick: () => this.resetColors() })),
      this.legend ? h('div', { class: 'muted small legend-title', text: `${keyLabel(this.legend.key)} · ${t('flt.legendHint')}` }) : null,
      legend,
    );
  }

  buildLegend() {
    const key = this.colorKey;
    if (!key) return this.ctx.toast(t('flt.chooseFirst'));
    const values = new Map(); // value -> Map(model -> ids)
    const missing = new Map();
    let numeric = true;
    for (const m of this.ctx.viewer.models) {
      for (const [id, o] of m._pindex.data) {
        const v = o[key];
        const target = v === undefined ? missing : (values.has(v) ? values.get(v) : values.set(v, new Map()).get(v));
        if (v !== undefined && typeof v !== 'number') numeric = false;
        if (!target.has(m)) target.set(m, []);
        target.get(m).push(id);
      }
    }
    let groups = [];
    if (numeric && values.size > MAX_CATEGORIES) {
      // equal-interval bins
      const nums = [...values.keys()];
      const min = Math.min(...nums), max = Math.max(...nums);
      const n = RAMP.length;
      const step = (max - min) / n || 1;
      groups = RAMP.map((color, i) => ({ label: `${fmtVal(min + i * step)} – ${fmtVal(i === n - 1 ? max : min + (i + 1) * step)}`, color, ids: new Map(), hidden: false }));
      for (const [v, byModel] of values) {
        const gi = Math.min(n - 1, Math.floor((v - min) / step));
        for (const [m, ids] of byModel) {
          if (!groups[gi].ids.has(m)) groups[gi].ids.set(m, []);
          groups[gi].ids.get(m).push(...ids);
        }
      }
      groups = groups.filter((g) => g.ids.size);
    } else {
      const sorted = [...values].sort((a, b) => (numeric ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]))));
      const total = (byModel) => [...byModel.values()].reduce((a, l) => a + l.length, 0);
      let list = sorted;
      let rest = [];
      if (list.length > MAX_CATEGORIES) {
        // keep the largest groups, put the rest in "other"
        const bySize = [...sorted].sort((a, b) => total(b[1]) - total(a[1]));
        const keep = new Set(bySize.slice(0, MAX_CATEGORIES - 1).map(([v]) => v));
        list = sorted.filter(([v]) => keep.has(v));
        rest = sorted.filter(([v]) => !keep.has(v));
      }
      groups = list.map(([v, byModel], i) => ({ label: fmtVal(v), color: CATEGORICAL[i % CATEGORICAL.length], ids: byModel, hidden: false }));
      if (rest.length) {
        const ids = new Map();
        for (const [, byModel] of rest) for (const [m, l] of byModel) { if (!ids.has(m)) ids.set(m, []); ids.get(m).push(...l); }
        groups.push({ label: t('flt.other', { n: rest.length }), color: 0x495057, ids, hidden: false });
      }
    }
    if (missing.size) groups.push({ label: t('flt.noValue'), color: NO_VALUE_COLOR, ids: missing, hidden: false, missing: true });
    this.legend = { key, groups };
    this.applyColors();
    this.render();
  }

  applyColors() {
    if (!this.legend) return;
    for (const m of this.ctx.viewer.models) {
      const colors = new Map();
      const fade = [];
      for (const g of this.legend.groups) {
        const ids = g.ids.get(m) || [];
        if (g.missing && this.toneDown) fade.push(...ids);
        else for (const id of ids) colors.set(id, g.color);
      }
      m.setElementColors(colors);
      // tone down elements without a value (keeps transparency the user set on other elements)
      for (const id of m._tonedDown || []) if (m.elementOpacity.get(id) === 0.15) m.elementOpacity.delete(id);
      m._tonedDown = fade;
      if (fade.length) m.setElementOpacity(fade, 0.15);
      else m.setElementOpacity([], 1);
    }
  }

  #applyLegendVisibility() {
    for (const m of this.ctx.viewer.models) {
      const hide = [], show = [];
      for (const g of this.legend.groups) (g.hidden ? hide : show).push(...(g.ids.get(m) || []));
      if (show.length) m.show(show);
      if (hide.length) m.hide(hide);
    }
    this.ctx.refreshVisibility();
  }

  resetColors() {
    for (const m of this.ctx.viewer.models) {
      m.resetElementColors();
      for (const id of m._tonedDown || []) if (m.elementOpacity.get(id) === 0.15) m.elementOpacity.delete(id);
      m._tonedDown = [];
      m.setElementOpacity([], 1);
    }
    if (this.legend?.groups.some((g) => g.hidden)) {
      for (const g of this.legend.groups) g.hidden = false;
      this.#applyLegendVisibility();
    }
    this.legend = null;
    this.render();
  }

  // ------------------------------------------------------------------- filter
  #filterSection(keys) {
    const { h } = this.ctx;
    const list = h('div', { class: 'rules' });
    this.rules.forEach((r, i) => {
      const keySel = this.#keySelect(keys, r.key, (k) => { r.key = k; this.#updateCount(); });
      const op = h('select', { class: 'op-select' }, OPS.map((o) => h('option', { value: o, text: t(`flt.op.${o}`), selected: o === r.op })));
      const val = h('input', { type: 'text', value: r.value, placeholder: t('flt.valuePlaceholder'), list: `vals-${i}` });
      const dl = h('datalist', { id: `vals-${i}` }, this.#sampleValues(r.key).map((v) => h('option', { value: v })));
      keySel.addEventListener('change', () => { dl.replaceChildren(...this.#sampleValues(r.key).map((v) => h('option', { value: v }))); });
      op.addEventListener('change', () => { r.op = op.value; val.disabled = r.op === 'exists' || r.op === 'missing'; this.#updateCount(); });
      val.disabled = r.op === 'exists' || r.op === 'missing';
      val.addEventListener('input', () => { r.value = val.value; this.#updateCount(); });
      const del = h('button', { class: 'icon-btn', title: t('flt.removeRule'), text: '✕', onclick: () => { this.rules.splice(i, 1); this.render(); } });
      list.append(h('div', { class: 'rule' }, keySel, h('div', { class: 'rule-row' }, op, val, del), dl));
    });
    const match = h('select', { class: 'sm' },
      h('option', { value: 'all', text: t('flt.matchAll'), selected: this.matchAll }),
      h('option', { value: 'any', text: t('flt.matchAny'), selected: !this.matchAll }));
    match.addEventListener('change', () => { this.matchAll = match.value === 'all'; this.#updateCount(); });
    this.countEl = h('div', { class: 'flt-count' });
    const color = h('input', { type: 'color', value: '#e8590c', title: t('flt.colorAction') });
    const sec = h('section', { class: 'flt-section' },
      h('h3', { text: t('flt.filter') }),
      h('div', { class: 'match-row' }, h('span', { class: 'muted small', text: t('flt.match') }), match),
      list,
      h('button', { class: 'btn sm', text: `＋ ${t('flt.addRule')}`, onclick: () => { this.rules.push({ key: '', op: 'eq', value: '' }); this.render(); } }),
      this.countEl,
      h('div', { class: 'flt-btns' },
        h('button', { class: 'btn primary sm', text: t('flt.select'), onclick: () => this.ctx.setSelection(this.matches()) }),
        h('button', { class: 'btn sm', text: t('flt.isolate'), onclick: () => this.#isolate() }),
        h('button', { class: 'btn sm', text: t('flt.hide'), onclick: () => this.#hide() }),
        h('span', { class: 'color-action' }, color,
          h('button', { class: 'btn sm', text: t('flt.colorAction'), onclick: () => this.#colorMatches(parseInt(color.value.slice(1), 16)) }))),
    );
    this.#updateCount();
    return sec;
  }

  #sampleValues(key) {
    if (!key) return [];
    const vals = new Set();
    for (const m of this.ctx.viewer.models) {
      for (const o of m._pindex?.data.values() || []) {
        if (o[key] !== undefined) vals.add(fmtVal(o[key]));
        if (vals.size >= 60) break;
      }
    }
    return [...vals].sort();
  }

  #test(o, r) {
    if (!r.key) return true;
    const v = o[r.key];
    if (r.op === 'exists') return v !== undefined;
    if (r.op === 'missing') return v === undefined;
    if (v === undefined) return r.op === 'ne' || r.op === 'notContains';
    const want = r.value.trim();
    const num = Number(want.replace(',', '.'));
    const isNum = typeof v === 'number' && want !== '' && Number.isFinite(num);
    const sv = fmtVal(v).toLowerCase(), sw = want.toLowerCase();
    switch (r.op) {
      case 'eq': return isNum ? Math.abs(v - num) < 1e-9 : sv === sw || String(v).toLowerCase() === sw;
      case 'ne': return isNum ? Math.abs(v - num) >= 1e-9 : sv !== sw && String(v).toLowerCase() !== sw;
      case 'contains': return sv.includes(sw);
      case 'notContains': return !sv.includes(sw);
      case 'gt': return isNum ? v > num : sv > sw;
      case 'lt': return isNum ? v < num : sv < sw;
      default: return true;
    }
  }

  /** Map(model -> [ids]) of the elements matching the rules. */
  matches() {
    const out = new Map();
    const rules = this.rules.filter((r) => r.key);
    for (const m of this.ctx.viewer.models) {
      const ids = [];
      for (const [id, o] of m._pindex?.data || []) {
        const ok = !rules.length || (this.matchAll ? rules.every((r) => this.#test(o, r)) : rules.some((r) => this.#test(o, r)));
        if (ok) ids.push(id);
      }
      if (ids.length) out.set(m, ids);
    }
    return out;
  }

  #updateCount() {
    if (!this.countEl) return;
    let n = 0;
    for (const ids of this.matches().values()) n += ids.length;
    this.countEl.textContent = t('flt.matches', { n: fmtNum(n) });
  }

  #isolate() {
    const sel = this.matches();
    for (const m of this.ctx.viewer.models) m.isolate(sel.get(m) || []);
    this.ctx.refreshVisibility();
  }

  #hide() {
    for (const [m, ids] of this.matches()) m.hide(ids);
    this.ctx.refreshVisibility();
  }

  #colorMatches(color) {
    for (const [m, ids] of this.matches()) m.setElementColor(ids, color);
  }
}
