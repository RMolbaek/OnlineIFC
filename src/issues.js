// Issues tab: BCF topics with viewpoints and comments, created from the current view.
import { t, fmtNum } from './i18n.js';
import { TOPIC_TYPES, TOPIC_STATUSES, PRIORITIES, uuid, captureViewpoint, applyViewpoint, exportBcf, importBcf, dataUrlBytes } from './bcf.js';
import { fmtValue } from './ifc.js';

const AUTHOR_KEY = 'onlineifc.bcfAuthor';

export class IssuesPanel {
  /** ctx: {viewer, h, toast, download, root, state, setSelection(Map), setSpacesVisible(bool), afterVisibility()} */
  constructor(ctx) {
    this.ctx = ctx;
    this.topics = [];
    this.openGuid = null;
    this.showNew = false;
    this.dirty = false;
    this.version = '2.1';
    this.filter = 'all';
    try { this.author = localStorage.getItem(AUTHOR_KEY) || ''; } catch { this.author = ''; }
  }

  #now() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  #snapshot() {
    // Scaled screenshot (max 1280 px wide) as PNG bytes
    const src = this.ctx.viewer.renderer.domElement;
    const scale = Math.min(1, 1280 / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    this.ctx.viewer.renderer.render(this.ctx.viewer.scene, this.ctx.viewer.camera);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return dataUrlBytes(c.toDataURL('image/png'));
  }

  #viewpoint() {
    const vp = captureViewpoint({ viewer: this.ctx.viewer, selection: this.ctx.state.selection, spacesVisible: this.ctx.state.spacesVisible });
    vp.snapshot = this.#snapshot();
    return vp;
  }

  #thumb(vp) {
    if (!vp?.snapshot) return null;
    if (!vp._url) vp._url = URL.createObjectURL(new Blob([vp.snapshot], { type: 'image/png' }));
    return vp._url;
  }

  #setAuthor(v) {
    this.author = v;
    try { localStorage.setItem(AUTHOR_KEY, v); } catch { /* ignore */ }
  }

  create({ title, description, type, priority, assignedTo }) {
    const vp = this.#viewpoint();
    const topic = {
      guid: uuid(), title, description, type, status: 'Open', priority, assignedTo, labels: [],
      created: this.#now(), author: this.author || 'Vispecta', comments: [], viewpoints: [vp],
    };
    this.topics.unshift(topic);
    this.openGuid = topic.guid;
    this.dirty = true;
  }

  show(topic, vp = topic.viewpoints[0]) {
    if (!vp) return;
    const missing = applyViewpoint(vp, this.ctx);
    if (missing) this.ctx.toast(t('bcf.missing', { n: fmtNum(missing) }));
  }

  #touch(topic) {
    topic.modified = this.#now();
    topic.modifiedAuthor = this.author || 'Vispecta';
    this.dirty = true;
  }

  async importFile(file) {
    try {
      const { version, topics } = importBcf(new Uint8Array(await file.arrayBuffer()));
      const known = new Set(this.topics.map((x) => x.guid));
      let added = 0;
      for (const tp of topics) if (!known.has(tp.guid)) { this.topics.push(tp); added++; }
      this.ctx.toast(t('bcf.imported', { n: added, version }), true);
      this.render();
    } catch (e) {
      console.error(e);
      this.ctx.toast(t('bcf.importFailed', { error: e.message || e }));
    }
  }

  export() {
    if (!this.topics.length) return this.ctx.toast(t('bcf.nothing'));
    const files = this.ctx.viewer.models.map((m) => ({
      name: m.name,
      project: fmtValue(m.api.GetLine(m.modelID, m.tree.expressID, false)?.GlobalId) || '',
    }));
    const zip = exportBcf(this.topics, files, this.version, this.ctx.viewer.models[0]?.name || 'Vispecta');
    const stamp = new Date().toISOString().slice(0, 10);
    this.ctx.download(`issues-${stamp}.bcfzip`, zip, 'application/octet-stream');
    this.dirty = false;
  }

  // ------------------------------------------------------------------- render
  render() {
    const { h } = this.ctx;
    const root = this.ctx.root;
    const author = h('input', { type: 'text', value: this.author, placeholder: t('bcf.authorPh') });
    author.addEventListener('change', () => this.#setAuthor(author.value.trim()));
    const fileInput = h('input', { type: 'file', accept: '.bcf,.bcfzip,.zip', hidden: true });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) this.importFile(fileInput.files[0]); fileInput.value = ''; });
    const ver = h('select', { class: 'sm', title: t('bcf.versionTitle') }, ['2.1', '3.0'].map((v) => h('option', { value: v, text: `BCF ${v}`, selected: v === this.version })));
    ver.addEventListener('change', () => { this.version = ver.value; });
    const filter = h('select', { class: 'sm' },
      h('option', { value: 'all', text: t('bcf.filterAll'), selected: this.filter === 'all' }),
      h('option', { value: 'open', text: t('bcf.filterOpen'), selected: this.filter === 'open' }),
      h('option', { value: 'closed', text: t('bcf.filterClosed'), selected: this.filter === 'closed' }));
    filter.addEventListener('change', () => { this.filter = filter.value; this.render(); });

    const parts = [
      h('div', { class: 'bcf-top' },
        h('label', { class: 'field' }, h('span', { text: t('bcf.author') }), author),
        h('div', { class: 'flt-btns' },
          h('button', { class: 'btn primary sm', text: `＋ ${t('bcf.new')}`, onclick: () => { if (!this.ctx.viewer.models.length) return this.ctx.toast(t('msg.loadFirst')); this.showNew = !this.showNew; this.render(); } }),
          h('button', { class: 'btn sm', text: t('bcf.import'), onclick: () => fileInput.click() }),
          h('span', { class: 'color-action' }, ver, h('button', { class: 'btn sm', text: t('bcf.export'), onclick: () => this.export() })),
          fileInput)),
    ];
    if (this.showNew) parts.push(this.#newForm());
    const visible = this.topics.filter((tp) => this.filter === 'all' || (this.filter === 'closed') === ['Closed', 'Resolved'].includes(tp.status));
    parts.push(h('div', { class: 'bcf-listhead' }, h('span', { class: 'muted small', text: t('bcf.count', { n: this.topics.length }) }), filter));
    if (!this.topics.length) parts.push(h('div', { class: 'empty-hint', text: t('bcf.empty') }));
    for (const tp of visible) parts.push(this.#card(tp));
    root.replaceChildren(...parts);
  }

  #newForm() {
    const { h } = this.ctx;
    const title = h('input', { type: 'text', placeholder: t('bcf.titlePh') });
    const desc = h('textarea', { rows: 3, placeholder: t('bcf.descPh') });
    const type = h('select', {}, TOPIC_TYPES.map((x) => h('option', { value: x, text: t(`bcf.type.${x}`) })));
    const prio = h('select', {}, PRIORITIES.map((x) => h('option', { value: x, text: t(`bcf.prio.${x}`), selected: x === 'Normal' })));
    const assigned = h('input', { type: 'text', placeholder: t('bcf.assignedPh') });
    const create = () => {
      if (!title.value.trim()) { title.focus(); return this.ctx.toast(t('bcf.titleRequired')); }
      this.create({ title: title.value.trim(), description: desc.value.trim(), type: type.value, priority: prio.value, assignedTo: assigned.value.trim() });
      this.showNew = false;
      this.render();
      this.ctx.toast(t('bcf.created'), true);
    };
    setTimeout(() => title.focus(), 0);
    return h('div', { class: 'flt-section bcf-new' },
      h('h3', { text: t('bcf.newTitle') }),
      h('p', { class: 'muted small', text: t('bcf.newHint') }),
      title, desc,
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', { text: t('bcf.typeLabel') }), type), h('label', { class: 'field' }, h('span', { text: t('bcf.priority') }), prio)),
      h('label', { class: 'field' }, h('span', { text: t('bcf.assigned') }), assigned),
      h('div', { class: 'flt-btns' },
        h('button', { class: 'btn primary sm', text: t('bcf.create'), onclick: create }),
        h('button', { class: 'btn sm', text: t('common.cancel'), onclick: () => { this.showNew = false; this.render(); } })));
  }

  #card(tp) {
    const { h } = this.ctx;
    const open = this.openGuid === tp.guid;
    const thumb = this.#thumb(tp.viewpoints[0]);
    const statusClass = { Open: 'open', 'In Progress': 'progress', Resolved: 'resolved', Closed: 'closed' }[tp.status] || 'open';
    const head = h('div', { class: 'bcf-head' },
      thumb ? h('img', { class: 'bcf-thumb', src: thumb, alt: '' }) : h('div', { class: 'bcf-thumb empty' }),
      h('div', { class: 'bcf-headtext' },
        h('div', { class: 'bcf-title', text: tp.title || t('bcf.untitled') }),
        h('div', { class: 'bcf-meta' },
          h('span', { class: `bcf-status ${statusClass}`, text: t(`bcf.status.${tp.status}`) === `bcf.status.${tp.status}` ? tp.status : t(`bcf.status.${tp.status}`) }),
          tp.priority ? h('span', { text: t(`bcf.prio.${tp.priority}`) === `bcf.prio.${tp.priority}` ? tp.priority : t(`bcf.prio.${tp.priority}`) }) : null,
          h('span', { text: `💬 ${tp.comments.length}` }),
          h('span', { class: 'muted', text: (tp.created || '').slice(0, 10) }))));
    head.addEventListener('click', () => {
      this.openGuid = open ? null : tp.guid;
      if (!open) this.show(tp);
      this.render();
    });
    const card = h('div', { class: `bcf-card${open ? ' open' : ''}` }, head);
    if (!open) return card;

    const status = h('select', {}, [...new Set([...TOPIC_STATUSES, tp.status])].map((x) => h('option', { value: x, text: t(`bcf.status.${x}`) === `bcf.status.${x}` ? x : t(`bcf.status.${x}`), selected: x === tp.status })));
    status.addEventListener('change', () => { tp.status = status.value; this.#touch(tp); this.render(); });
    const prio = h('select', {}, [...new Set([...PRIORITIES, tp.priority].filter(Boolean))].map((x) => h('option', { value: x, text: t(`bcf.prio.${x}`) === `bcf.prio.${x}` ? x : t(`bcf.prio.${x}`), selected: x === tp.priority })));
    prio.addEventListener('change', () => { tp.priority = prio.value; this.#touch(tp); });
    const assigned = h('input', { type: 'text', value: tp.assignedTo || '', placeholder: t('bcf.assignedPh') });
    assigned.addEventListener('change', () => { tp.assignedTo = assigned.value.trim(); this.#touch(tp); });
    const commentBox = h('textarea', { rows: 2, placeholder: t('bcf.commentPh') });
    const withView = h('input', { type: 'checkbox' });
    const addComment = () => {
      const text = commentBox.value.trim();
      if (!text) return;
      let vpGuid = null;
      if (withView.checked) { const vp = this.#viewpoint(); tp.viewpoints.push(vp); vpGuid = vp.guid; }
      tp.comments.push({ guid: uuid(), date: this.#now(), author: this.author || 'Vispecta', text, viewpoint: vpGuid });
      this.#touch(tp);
      this.render();
    };
    card.append(h('div', { class: 'bcf-body' },
      h('div', { class: 'small muted', text: `${t(`bcf.type.${tp.type}`) === `bcf.type.${tp.type}` ? tp.type : t(`bcf.type.${tp.type}`)} · ${tp.author || ''}` }),
      tp.description ? h('div', { class: 'bcf-desc', text: tp.description }) : null,
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', { text: t('bcf.statusLabel') }), status), h('label', { class: 'field' }, h('span', { text: t('bcf.priority') }), prio)),
      h('label', { class: 'field' }, h('span', { text: t('bcf.assigned') }), assigned),
      h('div', { class: 'bcf-comments' }, tp.comments.map((c) => h('div', { class: 'bcf-comment' },
        h('div', { class: 'small muted' }, h('b', { text: c.author || '' }), ` · ${(c.date || '').replace('T', ' ').slice(0, 16)}`,
          c.viewpoint ? h('button', { class: 'link small', text: ` 👁 ${t('bcf.showView')}`, onclick: () => this.show(tp, tp.viewpoints.find((v) => v.guid === c.viewpoint)) }) : null),
        h('div', { text: c.text })))),
      commentBox,
      h('div', { class: 'flt-btns' },
        h('label', { class: 'chk' }, withView, h('span', { text: t('bcf.withView') })),
        h('button', { class: 'btn primary sm', text: t('bcf.addComment'), onclick: addComment })),
      h('div', { class: 'flt-btns bcf-actions' },
        h('button', { class: 'btn sm', text: t('bcf.showView'), onclick: () => this.show(tp) }),
        h('button', { class: 'btn sm', text: t('bcf.updateView'), onclick: () => { tp.viewpoints[0] = { ...this.#viewpoint(), guid: tp.viewpoints[0]?.guid || uuid() }; this.#touch(tp); this.render(); } }),
        h('button', { class: 'btn sm danger', text: t('bcf.delete'), onclick: () => { if (confirm(t('bcf.deleteConfirm', { title: tp.title }))) { this.topics = this.topics.filter((x) => x !== tp); this.dirty = true; this.render(); } } })),
    ));
    return card;
  }
}
