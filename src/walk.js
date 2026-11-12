import * as THREE from 'three';

/**
 * First-person walk mode.
 * Drag with the left mouse button (or one finger) to look around; W/A/S/D or the arrow keys
 * move, Q/E (or PageDown/PageUp) go down/up, Shift is faster, the mouse wheel changes the speed
 * and Esc leaves walk mode. Movement is horizontal, as when walking through a building.
 */
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'pageup', 'pagedown']);
const LOOK_DIST = 2; // the orbit target is kept this far in front of the eye

export class WalkMode extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.active = false;
    this.speed = 1.6; // metres per second
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.last = 0;
    this.drag = null;
    this.onKeyDown = (e) => this.#keyDown(e);
    this.onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this.onBlur = () => this.keys.clear();
    this.onPointerDown = (e) => this.#pointerDown(e);
    this.onPointerMove = (e) => this.#pointerMove(e);
    this.onPointerUp = () => { this.drag = null; };
    this.onWheel = (e) => this.#wheel(e);
    this.tick = () => this.#tick();
  }

  start() {
    if (this.active) return;
    const v = this.viewer;
    if (v.isOrtho) v.setOrthographic(false);
    this.active = true;
    v.controls.enabled = false;
    const dir = new THREE.Vector3();
    v.camera.getWorldDirection(dir);
    this.yaw = Math.atan2(dir.x, dir.z);
    this.pitch = Math.max(-1.45, Math.min(1.45, Math.asin(Math.max(-1, Math.min(1, dir.y)))));
    this.keys.clear();
    this.last = performance.now();
    const el = v.renderer.domElement;
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    el.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    v.container.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    v.container.classList.add('walking');
    v.renderHooks.push(this.tick);
    this.dispatchEvent(new Event('change'));
  }

  stop() {
    if (!this.active) return;
    const v = this.viewer;
    this.active = false;
    const el = v.renderer.domElement;
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    el.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    v.container.removeEventListener('wheel', this.onWheel, { capture: true });
    v.container.classList.remove('walking');
    v.renderHooks = v.renderHooks.filter((f) => f !== this.tick);
    v.controls.enabled = true;
    this.#place();
    this.dispatchEvent(new Event('change'));
  }

  toggle() { if (this.active) this.stop(); else this.start(); }

  #forward() {
    const c = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.yaw) * c, Math.sin(this.pitch), Math.cos(this.yaw) * c);
  }

  /** Points the camera along yaw/pitch and keeps the orbit target in front of it. */
  #place() {
    const v = this.viewer;
    const f = this.#forward();
    v.controls.target.copy(v.camera.position).addScaledVector(f, LOOK_DIST);
    v.camera.lookAt(v.controls.target);
  }

  #keyDown(e) {
    if (e.target.closest?.('input, textarea, select, .cm-editor')) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      this.stop();
      return;
    }
    if (!MOVE_KEYS.has(k)) return;
    e.preventDefault(); e.stopPropagation(); // keep the viewer's own shortcuts (E, Page Up …) out of the way
    this.keys.add(k);
  }

  #pointerDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.drag = { x: e.clientX, y: e.clientY };
  }

  #pointerMove(e) {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag = { x: e.clientX, y: e.clientY };
    const k = (this.viewer.fov * Math.PI / 180) / (this.viewer.container.clientHeight || 600);
    this.yaw -= dx * k;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * k));
  }

  #wheel(e) {
    e.preventDefault(); e.stopPropagation();
    this.speed = Math.min(50, Math.max(0.2, this.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
    this.dispatchEvent(new Event('speed'));
  }

  #tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const k = this.keys;
    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const side = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    const up = (k.has('e') || k.has('pageup') ? 1 : 0) - (k.has('q') || k.has('pagedown') ? 1 : 0);
    if (fwd || side || up) {
      const s = this.speed * (k.has('shift') ? 3 : 1) * dt;
      const flat = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = new THREE.Vector3(-flat.z, 0, flat.x);
      const move = flat.multiplyScalar(fwd).addScaledVector(right, side);
      if (move.lengthSq() > 0) move.normalize();
      move.multiplyScalar(s);
      move.y += up * s;
      this.viewer.camera.position.add(move);
    }
    this.#place();
  }
}
