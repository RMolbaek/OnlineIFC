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

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;

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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const loop = () => {
      this.controls.update();
      renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------- modeller
  addModel(model) {
    // Første model definerer koordinatsystemet; efterfølgende modeller flyttes
    // så de ligger korrekt i forhold til den (federering).
    if (!this.referenceMatrix) {
      this.referenceMatrix = model.coordMatrix.clone();
      model.group.matrix.identity();
    } else {
      const inv = model.coordMatrix.clone().invert();
      model.group.matrix.copy(this.referenceMatrix).multiply(inv);
    }
    model.group.matrixWorldNeedsUpdate = true;
    this.models.push(model);
    this.modelRoot.add(model.group);
    model.setSelection([], this.highlightMaterial);
  }

  /** Swaps a model for a new version of it (e.g. after a Python script), keeping its position in the list and its look. */
  replaceModel(oldModel, newModel) {
    const idx = this.models.indexOf(oldModel);
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
    if (!this.models.length) this.referenceMatrix = null;
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
    const dist = Math.max(size, 0.5) / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.1;
    let dir = new THREE.Vector3(1, 0.8, 1).normalize();
    if (keepDirection) {
      dir = this.camera.position.clone().sub(this.controls.target);
      if (dir.lengthSq() < 1e-8) dir.set(1, 0.8, 1);
      dir.normalize();
    }
    this.#animateTo(center.clone().add(dir.multiplyScalar(dist)), center);
    this.camera.near = Math.max(size / 5000, 0.01);
    this.camera.far = Math.max(size * 50, 1000);
    this.camera.updateProjectionMatrix();
  }

  fitAll() { this.fitBox(this.sceneBox()); }

  setView(name) {
    const box = this.sceneBox();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.1;
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
  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const hit = this.pick(e.clientX, e.clientY);
      this.dispatchEvent(Object.assign(new Event('pick'), { hit, originalEvent: e }));
    });
    el.addEventListener('dblclick', (e) => {
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
    for (const m of this.models) if (m.visible) for (const b of m.buckets) if (b.mesh.visible) targets.push(b.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    const active = this.planes.filter((p) => p.enabled).map((p) => p.plane);
    for (const h of hits) {
      if (active.some((pl) => pl.distanceToPoint(h.point) < -1e-6)) continue; // bortskåret
      const { model, bucket } = h.object.userData;
      const id = model.idFromFace(bucket, h.faceIndex);
      const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      return { model, id, point: h.point.clone(), normal };
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

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
