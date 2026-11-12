// Main-thread client for the Python (Pyodide + IfcOpenShell) worker.
import { getPythonConfig } from './config.js';

export class PythonEngine extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.state = 'idle'; // idle | loading | ready | running | error
    this.version = null;
    this.sent = new Map(); // model key -> version the worker has
    this.pending = new Map();
    this.seq = 1;
    this.readyPromise = null;
  }

  #emit(type, detail) { this.dispatchEvent(Object.assign(new Event(type), detail)); }

  #setState(state, extra = {}) {
    this.state = state;
    this.#emit('state', { state, ...extra });
  }

  #start() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./python-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this.#onMessage(data);
    this.worker.onerror = (e) => {
      this.#setState('error', { error: e.message || 'Worker error' });
      this.#rejectAll(new Error(e.message || 'Worker error'));
    };
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'status':
        this.#emit('status', { key: msg.key, vars: msg.vars });
        break;
      case 'ready':
        this.version = msg.version;
        this.pythonVersion = msg.python;
        this.#setState('ready');
        this.readyResolve?.();
        break;
      case 'stdout':
      case 'stderr':
        this.#emit('output', { stream: msg.type, text: msg.text });
        break;
      case 'done': {
        // models the script released from Python's memory are sent again next time
        for (const k of msg.released || []) this.sent.delete(String(k));
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.#setState('ready');
        p?.resolve(msg);
        break;
      }
      case 'error': {
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id).resolve({ ok: false, error: msg.error, actions: [] });
          this.pending.delete(msg.id);
          this.#setState(this.version ? 'ready' : 'error', { error: msg.error });
        } else {
          this.#setState('error', { error: msg.error });
          this.readyReject?.(new Error(msg.error));
        }
        break;
      }
      default:
        break;
    }
  }

  #rejectAll(err) {
    for (const p of this.pending.values()) p.resolve({ ok: false, error: err.message, actions: [] });
    this.pending.clear();
    this.readyReject?.(err);
  }

  /** Loads Pyodide and IfcOpenShell (first time only). */
  ensure() {
    if (this.state === 'ready' || this.state === 'running') return Promise.resolve();
    if (this.readyPromise && this.state === 'loading') return this.readyPromise;
    this.#start();
    this.#setState('loading');
    this.readyPromise = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.worker.postMessage({ type: 'init', config: getPythonConfig() });
    return this.readyPromise;
  }

  /**
   * Runs Python code.
   * @param {string} code
   * @param {{models: import('./model.js').IfcModel[], active?: any, selection?: Map}} ctx
   */
  async run(code, { models, active = null, selection = new Map(), files = [] }) {
    await this.ensure();
    const transfer = [];
    const payload = [];
    for (const m of models) {
      const key = String(m.uid);
      const entry = { key, name: m.name };
      if (this.sent.get(key) !== m.version) {
        const bytes = await m.getBytes(); // a fresh copy (read from the file or written by web-ifc)
        entry.bytes = bytes.buffer;
        transfer.push(bytes.buffer);
        this.sent.set(key, m.version);
      }
      payload.push(entry);
    }
    for (const k of [...this.sent.keys()]) if (!models.some((m) => String(m.uid) === k)) this.sent.delete(k);
    const sel = {};
    for (const [m, set] of selection) sel[String(m.uid)] = [...set];
    const id = this.seq++;
    this.#setState('running');
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.worker.postMessage({ type: 'run', id, code, models: payload, active: active ? String(active.uid) : null, selection: sel, files, config: getPythonConfig() }, transfer);
    });
  }

  /** Tells the worker that a model got a new key (after the viewer reloaded it). */
  rekey(oldModel, newModel) {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'rekey', from: String(oldModel.uid), to: String(newModel.uid), name: newModel.name });
    this.sent.delete(String(oldModel.uid));
    this.sent.set(String(newModel.uid), newModel.version);
  }

  /** Forgets all Python variables and reloads the models on the next run. */
  reset() {
    this.sent.clear();
    this.worker?.postMessage({ type: 'reset' });
  }

  /** Stops a running script by terminating the worker (Python must be loaded again). */
  stop() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.sent.clear();
    this.version = null;
    this.readyPromise = null;
    this.#rejectAll(new Error('Stopped'));
    this.#setState('idle');
  }
}
