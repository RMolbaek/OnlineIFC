// three.js-scene: kamera, navigation, lys, picking og snitplaner.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sectionFill } from './model.js';

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.models = [];

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = false;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 20000);
    this.camera.position.set(20, 15, 20);
    this.perspCamera = this.camera;
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.isOrtho = false;
    this.orthoHeight = 20; // visible height in metres in orthographic mode

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.001;
    this.controls.maxDistance = Infinity;
    // Navigation: left = pan (Shift/Ctrl+left = rotate), middle/wheel button = rotate,
    // right = rotate, wheel = zoom towards the surface under the cursor (handled below).
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.sceneRadius = 10;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1, 0.4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-0.5, 0.3, -0.8);
    this.scene.add(fill);

    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.highlightMaterial = new THREE.MeshLambertMaterial({
      color: 0xff9f1a,
      emissive: 0x663a00,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    // Snitplaner
    this.planes = []; // {id, plane, axis, helper, enabled}
    this.planeSeq = 1;
    this.showPlaneHelpers = true;

    this.raycaster = new THREE.Raycaster();
    this.#bindPointer();
    this.#initGizmo();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderHooks = []; // functions called every frame after rendering (e.g. measurement labels)
    this.dblclickCenters = true;
    const loop = () => {
      this.controls.update();
      this.#updateClip();
      renderer.render(this.scene, this.camera);
      this.#renderGizmo();
      for (const fn of this.renderHooks) fn();
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    this.#updateOrthoFrustum();
  }

  /** Field of view of the perspective camera (also used to size the orthographic view). */
  get fov() { return this.perspCamera.fov; }

  #updateOrthoFrustum() {
    const c = this.orthoCamera;
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
    const h = this.orthoHeight / 2;
    c.left = -h * aspect; c.right = h * aspect; c.top = h; c.bottom = -h;
    const r = Math.max(this.sceneRadius * 20, 2000);
    c.near = -r; c.far = r; // negative near: nothing is clipped behind the camera
    c.zoom = 1;
    c.updateProjectionMatrix();
  }

  /** Switches between perspective and orthographic (parallel) projection, keeping the view. */
  setOrthographic(on) {
    if (on === this.isOrtho) return;
    const from = this.camera;
    const to = on ? this.orthoCamera : this.perspCamera;
    const target = this.controls.target;
    const tan = Math.tan((this.fov * Math.PI) / 360);
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    if (on) {
      this.orthoHeight = Math.max(0.5, 2 * from.position.distanceTo(target) * tan);
    } else {
      // place the perspective camera so the model appears the same size
      const dir = from.position.clone().sub(target).normalize();
      to.position.copy(target).addScaledVector(dir, Math.max(0.5, this.orthoHeight / (2 * tan)));
    }
    this.camera = to;
    this.controls.object = to;
    this.isOrtho = on;
    this.#updateOrthoFrustum();
    this.controls.update();
    this.dispatchEvent(new Event('camera'));
  }

  setOrthoHeight(h) { this.orthoHeight = Math.max(0.02, h); this.#updateOrthoFrustum(); }

  /** Visible height (orthographic) for a bounding size. */
  #fitOrtho(size) {
    if (!this.isOrtho) return;
    this.orthoHeight = Math.max(size, 0.5) * 1.1;
    this.#updateOrthoFrustum();
  }

  // -------------------------------------------------------------- modeller
  addModel(model) {
    // Første model definerer koordinatsystemet; efterfølgende modeller flyttes
    // så de ligger korrekt i forhold til den (federering).
    if (!this.referenceMatrix) {
      this.referenceMatrix = model.coordMatrix.clone();
      this.referenceModel = model;
    }
    this.#place(model);
    this.models.push(model);
    this.modelRoot.add(model.group);
    model.setSelection([], this.highlightMaterial);
    this.#updateSceneRadius();
  }

  /** Group matrix of a model: from its own coordinates into those of the reference model. */
  #place(model) {
    const f = model.unitFix || 1;
    const mat = model.group.matrix.copy(this.referenceMatrix).multiply(model.coordMatrix.clone().invert());
    if (f !== 1) mat.multiply(new THREE.Matrix4().makeScale(f, f, f));
    model.group.matrixWorldNeedsUpdate = true;
  }

  /**
   * Corrects the length unit of a model (f = 1000: the file says millimetres but the coordinates are
   * metres). When the model defines the coordinate system, the other models are placed again.
   */
  setUnitFix(model, f) {
    model.setUnitFix(f);
    if (model === this.referenceModel) {
      this.referenceMatrix = model.coordMatrix.clone();
      for (const m of this.models) this.#place(m);
    } else {
      this.#place(model);
    }
    this.modelRoot.updateMatrixWorld(true);
    this.#updateSceneRadius();
    this.dispatchEvent(Object.assign(new Event('modelmoved'), { model }));
  }

  #updateSceneRadius() {
    const box = this.sceneBox({ visibleOnly: false });
    this.sceneRadius = box.isEmpty() ? 10 : Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  }

  /** Swaps a model for a new version of it (e.g. after a Python script), keeping its position in the list and its look. */
  replaceModel(oldModel, newModel) {
    const idx = this.models.indexOf(oldModel);
    if (oldModel.unitFix !== 1) newModel.setUnitFix(oldModel.unitFix);
    if (oldModel === this.referenceModel) this.referenceModel = newModel;
    this.addModel(newModel);
    this.models.pop();
    this.models.splice(idx < 0 ? this.models.length : idx, 0, newModel);
    if (oldModel.overrideColor) newModel.setColor(oldModel.overrideColor);
    if (oldModel.opacity !== 1) newModel.setOpacity(oldModel.opacity);
    newModel.setVisible(oldModel.visible);
    if (idx >= 0) this.removeModel(oldModel);
  }

  removeModel(model) {
    this.models = this.models.filter((m) => m !== model);
    model.dispose();
    if (!this.models.length) { this.referenceMatrix = null; this.referenceModel = null; }
    this.#updateSceneRadius();
    this.dispatchEvent(Object.assign(new Event('modelremoved'), { model }));
  }

  sceneBox({ visibleOnly = true } = {}) {
    const box = new THREE.Box3();
    for (const m of this.models) {
      if (visibleOnly && !m.visible) continue;
      box.union(m.getBox());
    }
    return box;
  }

  // ------------------------------------------------------------ kamera
  fitBox(box, { keepDirection = true } = {}) {
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.max(size, 0.5) / (2 * Math.tan((this.fov * Math.PI) / 360)) * 1.1;
    this.#fitOrtho(size);
    let dir = new THREE.Vector3(1, 0.8, 1).normalize();
    if (keepDirection) {
      dir = this.camera.position.clone().sub(this.controls.target);
      if (dir.lengthSq() < 1e-8) dir.set(1, 0.8, 1);
      dir.normalize();
    }
    this.#animateTo(center.clone().add(dir.multiplyScalar(dist)), center);
  }

  fitAll() { this.fitBox(this.sceneBox()); }

  setView(name) {
    const box = this.sceneBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = size / (2 * Math.tan((this.fov * Math.PI) / 360)) * 1.1;
    this.#fitOrtho(size);
    const dirs = {
      top: new THREE.Vector3(0, 1, 0.0001),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      left: new THREE.Vector3(-1, 0, 0),
      right: new THREE.Vector3(1, 0, 0),
      iso: new THREE.Vector3(1, 0.8, 1),
    };
    const d = (dirs[name] || dirs.iso).clone().normalize();
    this.#animateTo(center.clone().add(d.multiplyScalar(dist)), center);
  }

  /** Animates the camera to a position looking at a target. */
  flyTo(pos, target) { this.#animateTo(pos, target); }

  #animateTo(pos, target) {
    const p0 = this.camera.position.clone();
    const t0 = this.controls.target.clone();
    const start = performance.now();
    const dur = 450;
    const step = (now) => {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(p0, pos, e);
      this.controls.target.lerpVectors(t0, target, e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ picking
  // ------------------------------------------------------------- axis gizmo
  /** Small X/Y/Z axis cross in the top-left corner that follows the camera (IFC axes: Z is up). */
  #initGizmo() {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xe5484d, label: 'X' },
      { dir: new THREE.Vector3(0, 0, -1), color: 0x30a46c, label: 'Y' }, // IFC Y = -Z in three.js
      { dir: new THREE.Vector3(0, 1, 0), color: 0x3e7bfa, label: 'Z' }, // IFC Z (up) = Y in three.js
    ];
    const up = new THREE.Vector3(0, 1, 0);
    for (const a of axes) {
      const mat = new THREE.MeshBasicMaterial({ color: a.color, depthTest: true });
      const q = new THREE.Quaternion().setFromUnitVectors(up, a.dir);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.85, 10), mat);
      shaft.position.copy(a.dir).multiplyScalar(0.425);
      shaft.quaternion.copy(q);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 14), mat);
      head.position.copy(a.dir).multiplyScalar(0.95);
      head.quaternion.copy(q);
      scene.add(shaft, head);
      // faint negative axis
      const neg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.3 }));
      neg.position.copy(a.dir).multiplyScalar(-0.3);
      neg.quaternion.copy(q);
      scene.add(neg);
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = `#${new THREE.Color(a.color).getHexString()}`;
      g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(a.label, 32, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.position.copy(a.dir).multiplyScalar(1.3);
      sprite.scale.setScalar(0.42);
      sprite.renderOrder = 2;
      scene.add(sprite);
    }
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0x8a8f99 })));
    this.gizmo = { scene, cam, size: 92, margin: 8 };
  }

  #renderGizmo() {
    const gz = this.gizmo;
    if (!gz) return;
    const r = this.renderer;
    const hgt = r.domElement.clientHeight;
    const q = this.camera.quaternion;
    gz.cam.position.set(0, 0, 4).applyQuaternion(q);
    gz.cam.quaternion.copy(q);
    const planes = r.clippingPlanes;
    r.clippingPlanes = [];
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(gz.margin, hgt - gz.size - gz.margin, gz.size, gz.size);
    r.setViewport(gz.margin, hgt - gz.size - gz.margin, gz.size, gz.size);
    r.clearDepth();
    r.render(gz.scene, gz.cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, r.domElement.clientWidth, hgt);
    r.autoClear = true;
    r.clippingPlanes = planes;
  }

  /** IFC (metres, Z up) -> viewer coordinates. Inverse of toIfc. */
  fromIfc(x, y, z) {
    const q = new THREE.Vector3(x, z, -y);
    if (this.referenceMatrix) q.applyMatrix4(this.referenceMatrix);
    return q;
  }

  /** Keeps near/far planes suited to how close the camera is to the model. */
  #updateClip() {
    if (this.isOrtho) return;
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.min(Math.max(d / 200, 0.002), 5);
    // Far plane: the whole scene, but no more than 200 000 × the near plane (the depth buffer loses
    // precision when the two are too far apart – models far from each other would flicker or vanish
    // when zooming in on one of them).
    const far = Math.min(Math.max(this.sceneRadius * 6 + this.camera.position.length() * 2, 1000), Math.max(near * 2e5, 1000));
    if (Math.abs(near - this.camera.near) / this.camera.near > 0.15 || Math.abs(far - this.camera.far) / this.camera.far > 0.15) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Moves the orbit pivot to the depth of a point, without turning the view.
   * Rotation and panning then feel anchored to what is under the cursor.
   */
  #pivotAtDepthOf(point) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const depth = point.clone().sub(this.camera.position).dot(dir);
    if (depth > 1e-4) this.controls.target.copy(this.camera.position).addScaledVector(dir, depth);
  }

  /** Distance along `ray` to the depth of the nearest geometry within ~80 px of the cursor (or null). */
  #nearbyDepth(x, y, ray) {
    for (const r of [10, 25, 50, 80]) {
      let best = null;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const h = this.pick(x + Math.cos(a) * r, y + Math.sin(a) * r);
        if (!h) continue;
        const t = h.point.clone().sub(ray.origin).dot(ray.direction);
        if (t > 0 && (best === null || t < best)) best = t;
      }
      if (best !== null) return best;
    }
    return null;
  }

  /** Wheel zoom: moves towards the point under the cursor, so you can zoom all the way in. */
  #onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.controls.enabled) return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    dy = Math.max(-300, Math.min(300, dy));
    if (this.isOrtho) {
      // orthographic: change the visible height, keeping the point under the cursor in place
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector3(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1, 0);
      const before = ndc.clone().unproject(this.camera);
      this.orthoHeight = Math.min(Math.max(this.orthoHeight * Math.pow(0.85, -dy / 100), 0.02), this.sceneRadius * 40 + 100);
      this.#updateOrthoFrustum();
      const after = ndc.clone().unproject(this.camera);
      const delta = before.sub(after);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      return;
    }
    const hit = this.pick(e.clientX, e.clientY); // also aims this.raycaster at the cursor
    const cam = this.camera.position;
    const ray = this.raycaster.ray.clone();
    let P;
    if (hit) P = hit.point;
    else {
      // Nothing under the cursor (thin elements, gaps): zoom towards the depth of the nearest
      // geometry around the cursor, so the camera does not fly past or through the model.
      const near = this.#nearbyDepth(e.clientX, e.clientY, ray);
      const box = this.sceneBox();
      const d = near ?? Math.max(cam.distanceTo(this.controls.target), box.isEmpty() ? 0 : box.distanceToPoint(cam), 0.5);
      P = ray.at(d, new THREE.Vector3());
    }
    const s = Math.pow(0.85, -dy / 100); // < 1 zooms in
    const toCam = cam.clone().sub(P);
    let dist = toCam.length() * s;
    if (dist < 0.02 && s < 1) {
      // Right at the surface: keep going forward at a small fixed step (lets you pass through)
      const step = Math.min(Math.max(this.sceneRadius * 0.002, 0.05), 1);
      cam.addScaledVector(ray.direction, step);
      this.controls.target.addScaledVector(ray.direction, step);
      return;
    }
    dist = Math.max(dist, 0.02);
    const newPos = P.clone().add(toCam.setLength(dist));
    const delta = newPos.clone().sub(cam);
    cam.copy(newPos);
    this.controls.target.add(delta);
    this.#pivotAtDepthOf(P);
  }

  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    // Capture-phase listeners on the container run before OrbitControls' own listeners.
    this.container.addEventListener('wheel', (e) => this.#onWheel(e), { capture: true, passive: false });
    this.container.addEventListener('pointerdown', (e) => {
      if (e.target !== el || e.pointerType === 'touch') return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.#pivotAtDepthOf(hit.point);
    }, { capture: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (down && e.button === 2) {
        // right click without dragging (dragging with the right button rotates): context menu
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved <= 5) this.dispatchEvent(Object.assign(new Event('context'), { hit: this.pick(e.clientX, e.clientY), originalEvent: e }));
        return;
      }
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const hit = this.pick(e.clientX, e.clientY);
      this.dispatchEvent(Object.assign(new Event('pick'), { hit, originalEvent: e }));
    });
    el.addEventListener('dblclick', (e) => {
      if (!this.dblclickCenters) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.#animateTo(
        this.camera.position.clone().sub(this.controls.target).multiplyScalar(0.6).add(hit.point),
        hit.point,
      );
    });
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [];
    for (const m of this.models) if (m.visible) targets.push(...m.pickTargets());
    const hits = this.raycaster.intersectObjects(targets, false);
    const active = this.planes.filter((p) => p.enabled).map((p) => p.plane);
    for (const h of hits) {
      if (active.some((pl) => pl.distanceToPoint(h.point) < -1e-6)) continue; // cut away by a section
      const { model } = h.object.userData;
      const id = model.idFromHit(h.object, h.faceIndex);
      if (model.hidden.has(id)) continue;
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      return { model, id, point: h.point.clone(), normal, object: h.object, face: h.face };
    }
    return null;
  }

  // ------------------------------------------------------------ snit
  /**
   * Tilføjer et snitplan.
   * axis: 'x' | 'y' | 'z' | 'custom'. Normalen peger mod den side der bevares.
   */
  addPlane(axis, { normal = null, point = null } = {}) {
    const box = this.sceneBox();
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    let n;
    if (axis === 'x') n = new THREE.Vector3(-1, 0, 0);
    else if (axis === 'y') n = new THREE.Vector3(0, -1, 0); // vandret snit: behold det nedenunder
    else if (axis === 'z') n = new THREE.Vector3(0, 0, -1);
    else n = normal.clone().normalize().negate(); // klik på flade: skær det foran væk
    const p = point ? point.clone() : center;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
    const axisVec = axis === 'custom' ? n.clone().negate() : AXES[axis].clone();
    const entry = { id: this.planeSeq++, axis, axisVec, plane, enabled: true, helper: null };
    this.planes.push(entry);
    this.#updateClipping();
    return entry;
  }

  /** Planets position langs dets akse (i meter). */
  getPlanePos(entry) {
    return -entry.plane.constant * entry.plane.normal.dot(entry.axisVec);
  }

  setPlanePos(entry, pos) {
    entry.plane.constant = -pos / entry.plane.normal.dot(entry.axisVec);
    this.#updateHelper(entry);
  }

  /** Område planet kan flyttes i, ud fra scenens bounding box. */
  planeRange(entry) {
    const box = this.sceneBox();
    if (box.isEmpty()) return { min: -10, max: 10 };
    const e = entry.axisVec;
    const d = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) d.push(e.x * x + e.y * y + e.z * z);
    const lo = Math.min(...d), hi = Math.max(...d);
    const pad = 0.02 * (hi - lo || 1);
    return { min: lo - pad, max: hi + pad };
  }

  flipPlane(entry) { entry.plane.negate(); this.#updateClipping(); }

  togglePlane(entry, on) { entry.enabled = on; this.#updateClipping(); }

  removePlane(entry) {
    this.planes = this.planes.filter((p) => p !== entry);
    if (entry.helper) { this.helpers.remove(entry.helper); entry.helper.geometry.dispose(); }
    this.#updateClipping();
  }

  clearPlanes() { for (const p of [...this.planes]) this.removePlane(p); }

  /** Snitkasse: seks planer rundt om de markerede elementer eller hele scenen. */
  addSectionBox(box) {
    if (box.isEmpty()) return [];
    const pad = box.getSize(new THREE.Vector3()).multiplyScalar(0.02);
    const b = box.clone().expandByVector(pad);
    const defs = [
      [new THREE.Vector3(1, 0, 0), b.min, 'x'], [new THREE.Vector3(-1, 0, 0), b.max, 'x'],
      [new THREE.Vector3(0, 1, 0), b.min, 'y'], [new THREE.Vector3(0, -1, 0), b.max, 'y'],
      [new THREE.Vector3(0, 0, 1), b.min, 'z'], [new THREE.Vector3(0, 0, -1), b.max, 'z'],
    ];
    const out = [];
    for (const [n, p, axis] of defs) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
      const entry = { id: this.planeSeq++, axis, axisVec: AXES[axis].clone(), plane, enabled: true, helper: null, boxPart: n.dot(AXES[axis]) > 0 ? 'min' : 'max' };
      this.planes.push(entry);
      out.push(entry);
    }
    this.#updateClipping();
    return out;
  }

  setSectionFill(v) { this.sectionFillOn = v; this.#updateClipping(); }

  setHelpersVisible(v) { this.showPlaneHelpers = v; this.#updateClipping(); }

  #updateClipping() {
    this.renderer.clippingPlanes = this.planes.filter((p) => p.enabled).map((p) => p.plane);
    sectionFill.active.value = this.renderer.clippingPlanes.length && this.sectionFillOn !== false ? 1 : 0;
    for (const p of this.planes) this.#updateHelper(p);
  }

  #updateHelper(entry) {
    if (!entry.helper) {
      const geom = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geom, mat);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.6 }));
      mesh.add(edges);
      mesh.raycast = () => {};
      edges.raycast = () => {};
      entry.helper = mesh;
      this.helpers.add(mesh);
    }
    const h = entry.helper;
    h.visible = this.showPlaneHelpers && entry.enabled && !entry.boxPart;
    const box = this.sceneBox();
    const size = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length() * 0.8;
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const pt = entry.plane.projectPoint(center, new THREE.Vector3());
    h.position.copy(pt);
    h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), entry.plane.normal);
    h.scale.set(size, size, 1);
  }

  /** Viewer (three.js) coordinates -> IFC coordinates of the first model (metres, Z up). */
  toIfc(p) {
    const q = p.clone();
    if (this.referenceMatrix) q.applyMatrix4(this.referenceMatrix.clone().invert());
    return new THREE.Vector3(q.x, -q.z, q.y);
  }

  /** World point -> pixel position in the viewport (null when behind the camera). */
  toScreen(p) {
    const v = p.clone().project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    const w = this.renderer.domElement.clientWidth;
    const hgt = this.renderer.domElement.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * hgt };
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
