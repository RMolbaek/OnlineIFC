// Python panel: code editor, console and example scripts. Python runs in a worker (see python.js).
import { PythonEngine } from './python.js';
import { EXAMPLES } from './examples.js';
import { t } from './i18n.js';

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'onlineifc.script';

export class PythonPanel {
  constructor({ getContext, onActions, onOpenChange }) {
    this.getContext = getContext;
    this.onActions = onActions;
    this.onOpenChange = onOpenChange;
    this.engine = new PythonEngine();
    this.panel = $('#py-panel');
    this.console = $('#py-console');
    this.status = $('#py-status');
    this.editor = null;
    this.open = false;

    this.engine.addEventListener('output', ({ stream, text }) => this.#write(text, stream === 'stderr' ? 'err' : ''));
    this.engine.addEventListener('status', ({ key, vars }) => this.#setStatus(t(key, vars), 'busy'));
    this.engine.addEventListener('state', ({ state, error }) => {
      $('[data-action="py-stop"]').hidden = !(state === 'running' || state === 'loading');
      $('[data-action="py-run"]').disabled = state === 'running' || state === 'loading';
      if (state === 'ready') this.#setStatus(t('py.ready', { version: this.engine.version, python: this.engine.pythonVersion }), 'ok');
      else if (state === 'error') { this.#setStatus(t('py.loadFailed'), 'err'); if (error) this.#write(`${t('py.loadFailed')}: ${error}\n`, 'err'); }
      else if (state === 'idle') this.#setStatus(t('py.notLoaded'), '');
    });

    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'py-run') this.runEditor();
      else if (a === 'py-stop') { this.engine.stop(); this.#write(`${t('py.stopped')}\n`, 'err'); }
      else if (a === 'py-reset') { this.engine.reset(); this.#write(`${t('py.resetDone')}\n`, 'info'); }
      else if (a === 'py-clear') this.console.textContent = '';
    });

    $('#py-examples').addEventListener('change', (e) => {
      const ex = EXAMPLES.find((x) => x.key === e.target.value);
      e.target.value = '';
      if (!ex || !this.editor) return;
      const cur = this.editor.state.doc.toString();
      if (cur.trim() && cur !== ex.code && !confirm(t('py.replaceScript'))) return;
      this.#setCode(ex.code);
    });

    this.#initResize();
    this.translate();
  }

  translate() {
    const sel = $('#py-examples');
    sel.replaceChildren(new Option(t('py.examples'), ''), ...EXAMPLES.map((ex) => new Option(t(ex.key), ex.key)));
    if (this.engine.state === 'ready') this.#setStatus(t('py.ready', { version: this.engine.version, python: this.engine.pythonVersion }), 'ok');
    else if (this.engine.state === 'idle') this.#setStatus(t('py.notLoaded'), '');
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.panel.hidden = !this.open;
    if (this.open) {
      this.#ensureEditor().then(() => { if (this.open) this.editor.focus(); }).catch((e) => this.#write(`${e.message || e}\n`, 'err'));
      if (this.engine.state === 'idle') {
        this.#write(`${t('py.loadingInfo')}\n`, 'info');
        this.engine.ensure().catch(() => {});
      }
    }
    this.onOpenChange?.(this.open);
  }

  /** The code editor is loaded the first time the panel is opened (it is a large library). */
  #ensureEditor() {
    this.editorReady ||= this.#createEditor();
    return this.editorReady;
  }

  async #createEditor() {
    const [{ EditorView, basicSetup }, { keymap }, { Prec }, { indentWithTab }, { python: pythonLang }] = await Promise.all([
      import('codemirror'), import('@codemirror/view'), import('@codemirror/state'), import('@codemirror/commands'), import('@codemirror/lang-python'),
    ]);
    let saved = null;
    try { saved = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
    let saveTimer = null;
    this.editor = new EditorView({
      doc: saved ?? EXAMPLES[0].code,
      parent: $('#py-editor'),
      extensions: [
        basicSetup,
        pythonLang(),
        keymap.of([indentWithTab]),
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { this.runEditor(); return true; } }])),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, u.state.doc.toString()); } catch { /* ignore */ } }, 400);
        }),
      ],
    });
  }

  #setCode(code) {
    this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: code } });
  }

  #setStatus(text, cls) {
    this.status.textContent = text;
    this.status.className = `py-status ${cls || ''}`;
  }

  #write(text, cls = '') {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text.endsWith('\n') ? text : `${text}\n`;
    this.console.append(span);
    this.console.scrollTop = this.console.scrollHeight;
  }

  runEditor() {
    if (!this.editor) return;
    return this.runCode(this.editor.state.doc.toString());
  }

  /** Runs code (from the editor or generated, e.g. for merging). Returns true on success. */
  async runCode(code, opts = {}) {
    const res = await this.runCodeResult(code, opts);
    return !!res;
  }

  /** Like runCode, but returns the run result ({result, actions}) or null on failure. */
  async runCodeResult(code, { title = null, show = false, files = [] } = {}) {
    if (show && !this.open) this.toggle(true);
    if (this.engine.state === 'running') return null;
    this.#write(`>>> ${title || t('py.runningScript')}  (${new Date().toLocaleTimeString()})`, 'info');
    const started = performance.now();
    let res;
    try {
      res = await this.engine.run(code, { ...this.getContext(), files });
    } catch (e) {
      this.#write(String(e.message || e), 'err');
      return null;
    }
    if (!res.ok) {
      this.#write(res.error || 'Error', 'err');
      return null;
    }
    try {
      if (res.actions?.length) await this.onActions(res.actions);
    } catch (e) {
      console.error(e);
      this.#write(String(e.message || e), 'err');
      return null;
    }
    this.#write(t('py.finished', { s: ((performance.now() - started) / 1000).toFixed(2) }), 'ok');
    return res;
  }

  #initResize() {
    const handle = $('#py-resize');
    let startY = 0, startH = 0;
    const move = (e) => {
      const hgt = Math.min(Math.max(startH - (e.clientY - startY), 140), window.innerHeight * 0.8);
      this.panel.style.height = `${hgt}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.onOpenChange?.(this.open);
    };
    handle.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = this.panel.getBoundingClientRect().height;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }
}
