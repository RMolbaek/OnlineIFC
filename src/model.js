// A loaded IFC model: geometry, visibility, colours, selection, metadata and editing.
import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { fmtValue, prettyTypeName, prettyRawName, decodeIfcString } from './ifc.js';
import { t } from './i18n.js';

let nextUid = 1;

/** Delte uniforms: når et snit er aktivt, farves bagsider (= indersiden af snitflader). */
export const sectionFill = {
  active: { value: 0 },
  color: { value: new THREE.Color(0xd8443c) },
};

function installSectionFill(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSectionActive = sectionFill.active;
    shader.uniforms.uSectionColor = sectionFill.color;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSectionActive;\nuniform vec3 uSectionColor;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nif (uSectionActive > 0.5 && !gl_FrontFacing) diffuseColor.rgb = uSectionColor;');
  };
  material.customProgramCacheKey = () => 'ifc-section';
}

export class IfcModel {
  constructor({ name, api, modelID, buckets, schema, fileSize, coordMatrix, spaceIds, sourceBytes }) {
    this.uid = nextUid++;
    this.name = name;
    this.api = api;
    this.modelID = modelID;
    this.schema = schema;
    this.fileSize = fileSize;
    this.coordMatrix = coordMatrix;
    this.spaceIds = spaceIds || new Set();
    this.sourceBytes = sourceBytes || null; // original file, used while there are no edits
    this.version = 0; // incremented on every metadata edit
    this.changes = []; // human readable change log

    this.group = new THREE.Group();
    this.group.name = name;
    this.group.matrixAutoUpdate = false;

    this.visible = true;
    this.overrideColor = null; // THREE.Color eller null for originale farver
    this.opacity = 1;
    this.hidden = new Set(); // skjulte expressIDs
    this.selected = new Set();
    this.highlightMaterial = null;

    this.buckets = buckets.map((b) => this.#createBucket(b));
    this.elementIds = new Set();
    for (const b of this.buckets) for (const it of b.items) this.elementIds.add(it.id);

    // Spaces are hidden by default.
    for (const id of this.spaceIds) this.hidden.add(id);
    this.#rebuildAll();
  }

  #createBucket(b) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(b.index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    installSectionFill(material);
    const mesh = new THREE.Mesh(geometry, material);
    const bucket = {
      ...b,
      geometry,
      material,
      mesh,
      // aktuelle (synlige) intervaller i indeksbufferen, til picking
      curStarts: null,
      curIds: null,
      highlight: null,
    };
    mesh.userData.model = this;
    mesh.userData.bucket = bucket;
    this.group.add(mesh);
    this.#applyMaterial(bucket);
    return bucket;
  }

  // ------------------------------------------------------------------ udseende
  #applyMaterial(b) {
    const m = b.material;
    m.color.copy(this.overrideColor || b.color);
    const op = b.opacity * this.opacity;
    const transparent = op < 0.999;
    if (m.transparent !== transparent) m.needsUpdate = true;
    m.transparent = transparent;
    m.opacity = op;
    m.depthWrite = !transparent;
  }

  setColor(color) {
    this.overrideColor = color ? new THREE.Color(color) : null;
    for (const b of this.buckets) this.#applyMaterial(b);
  }

  setOpacity(op) {
    this.opacity = op;
    for (const b of this.buckets) this.#applyMaterial(b);
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  // ---------------------------------------------------------------- synlighed
  #rebuild(b) {
    const anyHidden = b.items.some((it) => this.hidden.has(it.id));
    const starts = [];
    const ids = [];
    if (!anyHidden) {
      if (b.geometry.index.array !== b.index) b.geometry.setIndex(new THREE.BufferAttribute(b.index, 1));
      for (const it of b.items) { starts.push(it.start); ids.push(it.id); }
    } else {
      let total = 0;
      for (const it of b.items) if (!this.hidden.has(it.id)) total += it.count;
      const out = new Uint32Array(total);
      let o = 0;
      for (const it of b.items) {
        if (this.hidden.has(it.id)) continue;
        starts.push(o); ids.push(it.id);
        out.set(b.index.subarray(it.start, it.start + it.count), o);
        o += it.count;
      }
      b.geometry.setIndex(new THREE.BufferAttribute(out, 1));
    }
    b.curStarts = Int32Array.from(starts);
    b.curIds = Int32Array.from(ids);
    b.mesh.visible = ids.length > 0;
  }

  #rebuildAll() {
    for (const b of this.buckets) this.#rebuild(b);
    this.#updateHighlight();
  }

  hide(ids) { for (const id of ids) this.hidden.add(id); this.#rebuildAll(); }
  show(ids) { for (const id of ids) this.hidden.delete(id); this.#rebuildAll(); }
  showAll({ includeSpaces = false } = {}) {
    this.hidden.clear();
    if (!includeSpaces) for (const id of this.spaceIds) this.hidden.add(id);
    this.#rebuildAll();
  }
  /** Vis kun de givne elementer. */
  isolate(ids) {
    const keep = new Set(ids);
    this.hidden.clear();
    for (const id of this.elementIds) if (!keep.has(id)) this.hidden.add(id);
    this.#rebuildAll();
  }
  isHidden(id) { return this.hidden.has(id); }

  // ------------------------------------------------------------------ picking
  /** expressID for en ramt trekant. */
  idFromFace(bucket, faceIndex) {
    const pos = faceIndex * 3;
    const s = bucket.curStarts;
    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return bucket.curIds[lo];
  }

  // ---------------------------------------------------------------- markering
  setSelection(ids, material) {
    this.highlightMaterial = material;
    this.selected = new Set(ids);
    this.#updateHighlight();
  }

  #updateHighlight() {
    for (const b of this.buckets) {
      if (b.highlight) {
        this.group.remove(b.highlight);
        b.highlight.geometry.dispose();
        b.highlight = null;
      }
      if (!this.selected.size || !this.highlightMaterial) continue;
      let total = 0;
      for (const it of b.items) if (this.selected.has(it.id) && !this.hidden.has(it.id)) total += it.count;
      if (!total) continue;
      const out = new Uint32Array(total);
      let o = 0;
      for (const it of b.items) {
        if (!this.selected.has(it.id) || this.hidden.has(it.id)) continue;
        out.set(b.index.subarray(it.start, it.start + it.count), o);
        o += it.count;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', b.geometry.getAttribute('position'));
      g.setAttribute('normal', b.geometry.getAttribute('normal'));
      g.setIndex(new THREE.BufferAttribute(out, 1));
      g.boundingBox = b.geometry.boundingBox;
      g.boundingSphere = b.geometry.boundingSphere;
      const hm = new THREE.Mesh(g, this.highlightMaterial);
      hm.renderOrder = 10;
      hm.raycast = () => {}; // markeringen skal ikke selv kunne vælges
      b.highlight = hm;
      this.group.add(hm);
    }
  }

  /** Bounding box (i verdenskoordinater) for nogle elementer eller hele modellen. */
  getBox(ids = null) {
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const want = ids ? new Set(ids) : null;
    for (const b of this.buckets) {
      if (!want) {
        if (!b.mesh.visible) continue;
        const bb = b.geometry.boundingBox.clone().applyMatrix4(this.group.matrixWorld);
        box.union(bb);
        continue;
      }
      const pos = b.positions;
      for (const it of b.items) {
        if (!want.has(it.id)) continue;
        for (let k = it.start; k < it.start + it.count; k++) {
          const vi = b.index[k] * 3;
          v.set(pos[vi], pos[vi + 1], pos[vi + 2]).applyMatrix4(this.group.matrixWorld);
          box.expandByPoint(v);
        }
      }
    }
    return box;
  }

  // ---------------------------------------------------------- rumlig struktur
  async loadStructure() {
    const api = this.api;
    this.tree = await api.properties.getSpatialStructure(this.modelID, false);
    this.parent = new Map();
    this.spatialIds = new Set();
    const walk = (node, parent) => {
      if (parent) this.parent.set(node.expressID, parent.expressID);
      if (node.children?.length || isSpatialType(node.type)) this.spatialIds.add(node.expressID);
      for (const c of node.children || []) walk(c, node);
    };
    walk(this.tree, null);

    // Classes of all elements with geometry
    this.typeOf = new Map();
    this.classes = new Map(); // klassenavn -> [ids]
    for (const id of this.elementIds) {
      const t = prettyTypeName(api, api.GetLineType(this.modelID, id));
      this.typeOf.set(id, t);
      if (!this.classes.has(t)) this.classes.set(t, []);
      this.classes.get(t).push(id);
    }
    this.units = this.#readUnits();
    this.lengthScale = this.#readLengthScale();
    this.georef = this.#readGeoref();
    this.header = this.#readHeader();
  }

  typeName(id) {
    if (this.typeOf?.has(id)) return this.typeOf.get(id);
    try { return prettyTypeName(this.api, this.api.GetLineType(this.modelID, id)); } catch { return ''; }
  }

  nameOf(id) {
    try {
      const line = this.api.GetLine(this.modelID, id, false);
      return fmtValue(line?.Name) || fmtValue(line?.LongName) || '';
    } catch { return ''; }
  }

  label(id) {
    const n = this.nameOf(id);
    return n ? `${n}` : `${this.typeName(id)} #${id}`;
  }

  #readHeader() {
    const out = {};
    try {
      const fn = this.api.GetHeaderLine(this.modelID, WebIFC.FILE_NAME);
      const args = fn?.arguments || [];
      const s = (x) => fmtValue(Array.isArray(x) ? x : x);
      out['hdr.fileName'] = s(args[0]);
      out['hdr.timestamp'] = s(args[1]);
      out['hdr.author'] = s(args[2]);
      out['hdr.organization'] = s(args[3]);
      out['hdr.preprocessor'] = s(args[4]);
      out['hdr.originatingSystem'] = s(args[5]);
    } catch { /* valgfrit */ }
    return out;
  }

  #readUnits() {
    const units = {};
    try {
      const ids = this.api.GetLineIDsWithType(this.modelID, WebIFC.IFCUNITASSIGNMENT);
      if (!ids.size()) return units;
      const ua = this.api.GetLine(this.modelID, ids.get(0), true);
      for (const u of ua.Units || []) {
        const type = u?.UnitType?.value;
        if (!type) continue;
        if (u.Name?.value) {
          units[type] = siSymbol(u.Prefix?.value, u.Name.value);
        } else if (u.Name) {
          units[type] = fmtValue(u.Name);
        }
      }
    } catch { /* valgfrit */ }
    return units;
  }

  /** Metres per project length unit (1 for m, 0.001 for mm …). */
  #readLengthScale() {
    try {
      const ids = this.api.GetLineIDsWithType(this.modelID, WebIFC.IFCUNITASSIGNMENT);
      if (!ids.size()) return 1;
      const ua = this.api.GetLine(this.modelID, ids.get(0), true);
      for (const u of ua.Units || []) {
        if (u?.UnitType?.value !== 'LENGTHUNIT') continue;
        return unitScale(u);
      }
    } catch { /* optional */ }
    return 1;
  }

  /**
   * Georeferencing: IfcMapConversion (IFC4+) and IfcSite.RefElevation.
   * Returns null when the model is not georeferenced.
   */
  #readGeoref() {
    const api = this.api;
    const out = { refElevation: null, map: null };
    try {
      const sites = api.GetLineIDsWithType(this.modelID, WebIFC.IFCSITE);
      if (sites.size()) {
        const site = api.GetLine(this.modelID, sites.get(0), false);
        const re = site?.RefElevation;
        const v = re && typeof re === 'object' ? Number(re._representationValue ?? re.value) : null;
        if (Number.isFinite(v)) out.refElevation = v * this.lengthScale;
      }
    } catch { /* optional */ }
    try {
      if (WebIFC.IFCMAPCONVERSION) {
        const ids = api.GetLineIDsWithType(this.modelID, WebIFC.IFCMAPCONVERSION);
        if (ids.size()) {
          const mc = api.GetLine(this.modelID, ids.get(0), true);
          const num = (x, d = 0) => {
            if (x === null || x === undefined) return d;
            const n = Number(typeof x === 'object' ? x._representationValue ?? x.value : x);
            return Number.isFinite(n) ? n : d;
          };
          const crs = mc.TargetCRS || {};
          const mapScale = crs.MapUnit && typeof crs.MapUnit === 'object' ? unitScale(crs.MapUnit) : this.lengthScale;
          let a = num(mc.XAxisAbscissa, 1), b = num(mc.XAxisOrdinate, 0);
          const len = Math.hypot(a, b) || 1;
          a /= len; b /= len;
          out.map = {
            eastings: num(mc.Eastings), northings: num(mc.Northings), height: num(mc.OrthogonalHeight),
            a, b, scale: num(mc.Scale, 1), mapScale, crs: fmtValue(crs.Name) || '',
          };
        }
      }
    } catch (e) { console.warn('IfcMapConversion', e); }
    return out.map || out.refElevation !== null ? out : null;
  }

  /**
   * Converts IFC project coordinates (metres) to map coordinates (metres) with IfcMapConversion.
   * Returns {e, n, h, crs} or null.
   */
  toMap(p) {
    const m = this.georef?.map;
    if (!m) return null;
    const x = p.x / this.lengthScale, y = p.y / this.lengthScale, z = p.z / this.lengthScale; // project units
    const e = m.eastings + m.scale * (m.a * x - m.b * y);
    const n = m.northings + m.scale * (m.b * x + m.a * y);
    const hh = m.height + z * m.scale;
    return { e: e * m.mapScale, n: n * m.mapScale, h: hh * m.mapScale, crs: m.crs };
  }

  /** The storey an element belongs to: {id, name, elevation (m)} or null. */
  storeyInfo(id) {
    let p = this.parent.get(id);
    while (p !== undefined) {
      if (this.typeName(p) === 'IfcBuildingStorey') {
        const line = this.api.GetLine(this.modelID, p, false);
        const ev = line?.Elevation;
        const v = ev && typeof ev === 'object' ? Number(ev._representationValue ?? ev.value) : NaN;
        return { id: p, name: this.label(p), elevation: Number.isFinite(v) ? v * this.lengthScale : null };
      }
      p = this.parent.get(p);
    }
    return null;
  }

  // ------------------------------------------------------------------ metadata
  /**
   * Collects all metadata for an element as sections for the properties panel.
   * Row format: [label, value, meta] where meta can describe a link or an editable value.
   */
  async getElementData(id) {
    const api = this.api;
    const mid = this.modelID;
    const sections = [];

    const line = api.GetLine(mid, id, false);
    const cls = this.typeName(id);

    // Attributes
    const attrs = [[t('prop.class'), cls], [t('prop.expressId'), `#${id}`]];
    for (const [k, v] of Object.entries(line || {})) {
      if (k === 'expressID' || k === 'type') continue;
      const editable = isEditableAttr(k, v);
      attrs.push([k, this.#fmtAttr(v), editable ? { attr: k } : null]);
    }
    sections.push({ title: t('sec.attributes'), rows: attrs, open: true, kind: 'attrs' });

    // Location in the spatial structure
    const chain = [];
    let p = this.parent.get(id);
    while (p !== undefined) {
      chain.unshift([this.typeName(p), this.label(p), { link: p }]);
      p = this.parent.get(p);
    }
    if (chain.length) sections.push({ title: t('sec.location'), rows: chain, open: true });

    // Instance property sets and quantities
    try {
      const psets = await api.properties.getPropertySets(mid, id, true, false);
      for (const ps of psets) sections.push(this.#psetSection(ps, ''));
    } catch (e) { console.warn(e); }

    // Type and type properties
    try {
      const types = await api.properties.getTypeProperties(mid, id, true);
      for (const ty of types) {
        const rows = [[t('prop.class'), prettyTypeName(api, ty.type)], [t('prop.expressId'), `#${ty.expressID}`]];
        for (const k of ['Name', 'Description', 'GlobalId', 'Tag', 'ElementType', 'PredefinedType', 'ApplicableOccurrence']) {
          if (ty[k]) rows.push([k, fmtValue(ty[k])]);
        }
        sections.push({ title: `${t('sec.type')}: ${fmtValue(ty.Name) || prettyTypeName(api, ty.type)}`, rows, open: true });
        for (const ps of ty.HasPropertySets || []) {
          if (ps && typeof ps === 'object' && 'expressID' in ps) sections.push(this.#psetSection(ps, ` (${t('sec.typeSuffix')})`, true));
        }
      }
    } catch (e) { console.warn(e); }

    // Materials
    try {
      const mats = await api.properties.getMaterialsProperties(mid, id, true, true);
      const rows = [];
      for (const m of mats) collectMaterials(m, rows, api, 0);
      if (rows.length) sections.push({ title: t('sec.materials'), rows, open: true });
    } catch (e) { console.warn(e); }

    // Classifications (e.g. CCS, Uniclass, OmniClass) via IfcRelAssociatesClassification
    try {
      const rows = this.#classifications(id);
      if (rows.length) sections.push({ title: t('sec.classification'), rows, open: true });
    } catch (e) { console.warn(e); }

    sections.push({
      title: t('sec.model'),
      rows: [[t('hdr.file'), this.name], [t('hdr.schema'), this.schema], ...Object.entries(this.header).filter(([, v]) => v).map(([k, v]) => [t(k), v])],
      open: false,
    });

    return { id, cls, name: fmtValue(line?.Name), guid: fmtValue(line?.GlobalId), sections };
  }

  #fmtAttr(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.type === 5 && typeof v.value === 'number') {
      return `${this.typeName(v.value)} #${v.value}`;
    }
    if (Array.isArray(v) && v.length && v.every((x) => x && x.type === 5)) {
      return v.slice(0, 10).map((x) => `${this.typeName(x.value)} #${x.value}`).join(', ') + (v.length > 10 ? ` … (+${v.length - 10})` : '');
    }
    return fmtValue(v);
  }

  #psetSection(ps, suffix, isType = false) {
    const rows = [];
    const isQto = Array.isArray(ps.Quantities);
    const isPset = Array.isArray(ps.HasProperties);
    const list = ps.HasProperties || ps.Quantities || [];
    for (const prop of list) this.#propRows(prop, rows, '', isPset);
    if (!list.length) {
      // IfcPreDefinedPropertySet etc.: the attributes are the properties
      for (const [k, v] of Object.entries(ps)) {
        if (['expressID', 'type', 'GlobalId', 'OwnerHistory', 'Name', 'Description'].includes(k)) continue;
        const s = fmtValue(v);
        if (s) rows.push([k, s]);
      }
    }
    const shared = isType ? 0 : this.#relIndex().psetToElements.get(ps.expressID)?.length || 0;
    return {
      title: `${fmtValue(ps.Name) || prettyTypeName(this.api, ps.type)}${suffix}`,
      rows,
      open: true,
      kind: isQto ? 'qto' : 'pset',
      psetId: isPset ? ps.expressID : null,
      shared,
      isType,
    };
  }

  #propRows(prop, rows, prefix, editableSet) {
    if (!prop || typeof prop !== 'object') return;
    const name = prefix + (fmtValue(prop.Name) || `#${prop.expressID}`);
    if (Array.isArray(prop.HasProperties)) {
      for (const sub of prop.HasProperties) this.#propRows(sub, rows, `${name} › `, false);
      return;
    }
    let value = '';
    let unitType = null;
    if ('NominalValue' in prop) value = fmtValue(prop.NominalValue);
    else if ('EnumerationValues' in prop) value = fmtValue(prop.EnumerationValues);
    else if ('ListValues' in prop) value = fmtValue(prop.ListValues);
    else if ('UpperBoundValue' in prop || 'LowerBoundValue' in prop) {
      value = `${fmtValue(prop.LowerBoundValue)} – ${fmtValue(prop.UpperBoundValue)}`;
    } else if ('DefiningValues' in prop) {
      value = `${fmtValue(prop.DefiningValues)} → ${fmtValue(prop.DefinedValues)}`;
    } else if ('UsageName' in prop) {
      value = fmtValue(prop.PropertyReference) || fmtValue(prop.UsageName);
    } else {
      for (const [k, ut] of QTO_UNITS) {
        if (k in prop) { value = fmtValue(prop[k]); unitType = ut; break; }
      }
    }
    let unit = '';
    if (prop.Unit && typeof prop.Unit === 'object') {
      if (prop.Unit.Name?.value) unit = siSymbol(prop.Unit.Prefix?.value, prop.Unit.Name.value);
    } else if (unitType && this.units[unitType]) unit = this.units[unitType];
    else if (!unitType && prop.NominalValue?.name) {
      const ut = MEASURE_UNITS[prop.NominalValue.name];
      if (ut && this.units[ut]) unit = this.units[ut];
    }
    const meta = editableSet && 'NominalValue' in prop
      ? { propId: prop.expressID, raw: rawValue(prop.NominalValue), valueType: prop.NominalValue?.name || 'IFCLABEL' }
      : null;
    rows.push([name, value + (unit && value !== '' ? ` ${unit}` : ''), meta]);
  }

  #classifications(id) {
    const api = this.api;
    const rows = [];
    if (!this._clsIndex) {
      const rels = api.GetLineIDsWithType(this.modelID, WebIFC.IFCRELASSOCIATESCLASSIFICATION);
      this._clsIndex = new Map();
      for (let i = 0; i < rels.size(); i++) {
        const rel = api.GetLine(this.modelID, rels.get(i), false);
        for (const r of rel.RelatedObjects || []) {
          const oid = r.value;
          if (!this._clsIndex.has(oid)) this._clsIndex.set(oid, []);
          this._clsIndex.get(oid).push(rel.RelatingClassification?.value);
        }
      }
    }
    for (const cid of this._clsIndex.get(id) || []) {
      if (!cid) continue;
      const c = api.GetLine(this.modelID, cid, false);
      let system = '';
      const src = c.ReferencedSource?.value;
      if (src) system = fmtValue(api.GetLine(this.modelID, src, false)?.Name);
      const code = fmtValue(c.Identification) || fmtValue(c.ItemReference) || '';
      rows.push([system || t('sec.classification'), [code, fmtValue(c.Name)].filter(Boolean).join(' – ')]);
    }
    return rows;
  }

  /** Index over IfcRelDefinesByProperties: element -> psets and pset -> elements. */
  #relIndex() {
    if (this._relIndex) return this._relIndex;
    const api = this.api;
    const elementToPsets = new Map();
    const psetToElements = new Map();
    const rels = api.GetLineIDsWithType(this.modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      const rel = api.GetLine(this.modelID, rels.get(i), false);
      const def = rel.RelatingPropertyDefinition;
      const defs = Array.isArray(def) ? def.map((d) => d.value) : [def?.value];
      for (const r of rel.RelatedObjects || []) {
        for (const d of defs) {
          if (!d) continue;
          if (!elementToPsets.has(r.value)) elementToPsets.set(r.value, []);
          elementToPsets.get(r.value).push(d);
          if (!psetToElements.has(d)) psetToElements.set(d, []);
          psetToElements.get(d).push(r.value);
        }
      }
    }
    this._relIndex = { elementToPsets, psetToElements };
    return this._relIndex;
  }

  // ------------------------------------------------------------------- editing
  #touch(description) {
    this.version++;
    this.changes.push({ time: new Date(), description });
    this._clsIndex = null;
  }

  /** Changes a string attribute (Name, Description, ObjectType, Tag, LongName …). */
  setAttribute(id, key, text) {
    const api = this.api;
    const line = api.GetLine(this.modelID, id, false);
    if (!line || !(key in line)) throw new Error(t('err.noAttribute', { key }));
    const cur = line[key];
    const typeName = cur?.name || STRING_ATTRS[key] || 'IFCLABEL';
    const old = fmtValue(cur);
    line[key] = text === '' ? null : api.CreateIfcType(this.modelID, api.GetTypeCodeFromName(typeName), text);
    api.WriteLine(this.modelID, line);
    this.#touch(t('chg.attr', { key, id, old, value: text }));
  }

  /** Changes the value of an IfcPropertySingleValue, keeping its value type. */
  setPropertyValue(propId, text, kind = null) {
    const api = this.api;
    const prop = api.GetLine(this.modelID, propId, false);
    const typeName = kind ? KIND_TYPES[kind] : prop.NominalValue?.name || 'IFCLABEL';
    const old = fmtValue(prop.NominalValue);
    prop.NominalValue = text === '' ? null : api.CreateIfcType(this.modelID, api.GetTypeCodeFromName(typeName), parseTyped(typeName, text));
    api.WriteLine(this.modelID, prop);
    this.#touch(t('chg.prop', { name: fmtValue(prop.Name), old, value: text }));
  }

  #newProperty(name, text, kind) {
    const api = this.api;
    const typeName = KIND_TYPES[kind] || 'IFCLABEL';
    const value = text === '' ? null : api.CreateIfcType(this.modelID, api.GetTypeCodeFromName(typeName), parseTyped(typeName, text));
    const prop = api.CreateIfcEntity(this.modelID, WebIFC.IFCPROPERTYSINGLEVALUE,
      api.CreateIfcType(this.modelID, WebIFC.IFCIDENTIFIER, name), null, value, null);
    api.WriteLine(this.modelID, prop);
    return prop.expressID;
  }

  /** Adds a single-value property to an existing property set. */
  addProperty(psetId, name, text, kind = 'text') {
    if (!name) throw new Error(t('err.nameRequired'));
    const api = this.api;
    const pset = api.GetLine(this.modelID, psetId, false);
    const existing = (pset.HasProperties || []).map((h) => api.GetLine(this.modelID, h.value, false));
    if (existing.some((p) => fmtValue(p?.Name) === name)) throw new Error(t('err.propExists', { name }));
    const pid = this.#newProperty(name, text, kind);
    pset.HasProperties = [...(pset.HasProperties || []), new WebIFC.Handle(pid)];
    api.WriteLine(this.modelID, pset);
    this.#touch(t('chg.addProp', { name, pset: fmtValue(pset.Name), value: text }));
  }

  /** Removes a property from a property set. */
  removeProperty(psetId, propId) {
    const api = this.api;
    const pset = api.GetLine(this.modelID, psetId, false);
    const remaining = (pset.HasProperties || []).filter((h) => h.value !== propId);
    if (!remaining.length) throw new Error(t('err.lastProperty'));
    const prop = api.GetLine(this.modelID, propId, false);
    pset.HasProperties = remaining;
    api.WriteLine(this.modelID, pset);
    this.#touch(t('chg.removeProp', { name: fmtValue(prop?.Name), pset: fmtValue(pset.Name) }));
  }

  /**
   * Sets a property on many elements at once. Existing values are overwritten, missing
   * properties are added, and elements without the property set get a new (shared) one.
   */
  async setPropertyOnElements(ids, psetName, propName, text, kind = 'text') {
    if (!psetName || !propName) throw new Error(t('err.nameRequired'));
    const api = this.api;
    const mid = this.modelID;
    const index = this.#relIndex();
    const handled = new Set();
    const missing = [];
    let edited = 0, added = 0;
    for (const id of ids) {
      const psetId = (index.elementToPsets.get(id) || []).find((pid) => {
        const ps = api.GetLine(mid, pid, false);
        return ps && Array.isArray(ps.HasProperties) && fmtValue(ps.Name) === psetName;
      });
      if (!psetId) { missing.push(id); continue; }
      if (handled.has(psetId)) continue;
      handled.add(psetId);
      const ps = api.GetLine(mid, psetId, false);
      const propHandle = (ps.HasProperties || []).find((h) => fmtValue(api.GetLine(mid, h.value, false)?.Name) === propName);
      const typeName = KIND_TYPES[kind] || 'IFCLABEL';
      const value = text === '' ? null : api.CreateIfcType(mid, api.GetTypeCodeFromName(typeName), parseTyped(typeName, text));
      if (propHandle) {
        const prop = api.GetLine(mid, propHandle.value, false);
        if ('NominalValue' in prop) { prop.NominalValue = value; api.WriteLine(mid, prop); edited++; }
      } else {
        const pid = this.#newProperty(propName, text, kind);
        ps.HasProperties = [...ps.HasProperties, new WebIFC.Handle(pid)];
        api.WriteLine(mid, ps);
        added++;
      }
    }
    if (missing.length) {
      const pid = this.#newProperty(propName, text, kind);
      const owner = api.GetLine(mid, missing[0], false)?.OwnerHistory ?? null;
      const pset = api.CreateIfcEntity(mid, WebIFC.IFCPROPERTYSET, api.CreateIFCGloballyUniqueId(mid), owner,
        api.CreateIfcType(mid, WebIFC.IFCLABEL, psetName), null, [new WebIFC.Handle(pid)]);
      api.WriteLine(mid, pset);
      const rel = api.CreateIfcEntity(mid, WebIFC.IFCRELDEFINESBYPROPERTIES, api.CreateIFCGloballyUniqueId(mid), owner,
        null, null, missing.map((x) => new WebIFC.Handle(x)), new WebIFC.Handle(pset.expressID));
      api.WriteLine(mid, rel);
      this._relIndex = null;
    }
    // Count elements that share an edited pset but were not part of the request
    const want = new Set(ids);
    let others = 0;
    for (const psid of handled) for (const e of index.psetToElements.get(psid) || []) if (!want.has(e)) others++;
    this.#touch(t('chg.batch', { pset: psetName, name: propName, value: text, count: ids.length }));
    return { edited, added, created: missing.length, others };
  }

  /** The current file content (including edits). */
  getBytes() {
    if (!this.changes.length && this.sourceBytes) return this.sourceBytes;
    return this.api.SaveModel(this.modelID);
  }

  /** Collects all properties of all elements (for CSV export). */
  async exportRows(onProgress = () => {}) {
    const ids = [...this.elementIds];
    const rows = [];
    const c = { model: t('csv.model'), id: 'ExpressID', guid: 'GlobalId', cls: t('csv.class'), name: t('csv.name'), storey: t('csv.storey') };
    const cols = new Set(Object.values(c));
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const line = this.api.GetLine(this.modelID, id, false);
      const row = {
        [c.model]: this.name,
        [c.id]: id,
        [c.guid]: fmtValue(line?.GlobalId),
        [c.cls]: this.typeName(id),
        [c.name]: fmtValue(line?.Name),
        [c.storey]: this.#storeyOf(id),
      };
      try {
        const psets = await this.api.properties.getPropertySets(this.modelID, id, true, true);
        for (const ps of psets) {
          const sec = this.#psetSection(ps, '', true);
          for (const [k, v] of sec.rows) {
            const col = `${sec.title}.${k}`;
            cols.add(col);
            row[col] = v;
          }
        }
      } catch { /* ignore */ }
      rows.push(row);
      if (i % 200 === 0) { onProgress(i / ids.length); await new Promise((r) => setTimeout(r, 0)); }
    }
    return { cols: [...cols], rows };
  }

  #storeyOf(id) {
    let p = this.parent.get(id);
    while (p !== undefined) {
      if (this.typeName(p) === 'IfcBuildingStorey') return this.label(p);
      p = this.parent.get(p);
    }
    return '';
  }

  dispose() {
    for (const b of this.buckets) {
      b.geometry.dispose();
      b.material.dispose();
      if (b.highlight) b.highlight.geometry.dispose();
    }
    this.group.removeFromParent();
    try { this.api.CloseModel(this.modelID); } catch { /* already closed */ }
  }
}

const STRING_ATTRS = {
  Name: 'IFCLABEL',
  Description: 'IFCTEXT',
  ObjectType: 'IFCLABEL',
  Tag: 'IFCIDENTIFIER',
  LongName: 'IFCLABEL',
  ElementType: 'IFCLABEL',
  Identification: 'IFCIDENTIFIER',
};

function isEditableAttr(key, v) {
  if (!(key in STRING_ATTRS)) return false;
  return v === null || v === undefined || (typeof v === 'object' && v.type === 1);
}

/** Value kinds the user can choose when adding properties. */
export const KIND_TYPES = {
  text: 'IFCLABEL',
  number: 'IFCREAL',
  integer: 'IFCINTEGER',
  bool: 'IFCBOOLEAN',
};

const INTEGER_TYPES = new Set(['IFCINTEGER', 'IFCCOUNTMEASURE', 'IFCDAYINMONTHNUMBER', 'IFCMONTHINYEARNUMBER', 'IFCYEARNUMBER', 'IFCNUMERICMEASURE_INT']);
const STRING_TYPES = new Set(['IFCLABEL', 'IFCTEXT', 'IFCIDENTIFIER', 'IFCDESCRIPTIVEMEASURE', 'IFCDATE', 'IFCDATETIME', 'IFCTIME', 'IFCDURATION', 'IFCURIREFERENCE', 'IFCGLOBALLYUNIQUEID']);

/** Converts user input into the JS value web-ifc expects for the given IFC value type. */
export function parseTyped(typeName, text) {
  const tn = String(typeName).toUpperCase();
  if (tn === 'IFCBOOLEAN' || tn === 'IFCLOGICAL') {
    const s = String(text).trim().toLowerCase();
    if (['true', 't', 'yes', 'y', '1', 'ja', 'sand', 'wahr'].includes(s)) return true;
    if (['false', 'f', 'no', 'n', '0', 'nej', 'falsk', 'nein', 'falsch'].includes(s)) return false;
    if (tn === 'IFCLOGICAL') return 'U';
    throw new Error(t('err.boolean', { value: text }));
  }
  if (STRING_TYPES.has(tn)) return String(text);
  if (INTEGER_TYPES.has(tn)) {
    const n = Number(String(text).replace(',', '.'));
    if (!Number.isInteger(n)) throw new Error(t('err.integer', { value: text }));
    return n;
  }
  if (/MEASURE|IFCREAL|IFCNUMBER|RATIO|IFCPOSITIVE/.test(tn)) {
    const n = Number(String(text).replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(t('err.number', { value: text }));
    return n;
  }
  return String(text);
}

/** The raw value of an IFC value object, for prefilling edit fields. */
function rawValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('_representationValue' in v) return String(v._representationValue);
    if ('value' in v) {
      if (v.value === true || v.value === 'T') return 'true';
      if (v.value === false || v.value === 'F') return 'false';
      return typeof v.value === 'string' ? decodeIfcString(v.value) : String(v.value);
    }
  }
  return String(v);
}

const QTO_UNITS = [
  ['LengthValue', 'LENGTHUNIT'],
  ['AreaValue', 'AREAUNIT'],
  ['VolumeValue', 'VOLUMEUNIT'],
  ['WeightValue', 'MASSUNIT'],
  ['TimeValue', 'TIMEUNIT'],
  ['CountValue', null],
  ['NumberValue', null],
];

const MEASURE_UNITS = {
  IFCLENGTHMEASURE: 'LENGTHUNIT',
  IFCPOSITIVELENGTHMEASURE: 'LENGTHUNIT',
  IFCNONNEGATIVELENGTHMEASURE: 'LENGTHUNIT',
  IFCAREAMEASURE: 'AREAUNIT',
  IFCVOLUMEMEASURE: 'VOLUMEUNIT',
  IFCMASSMEASURE: 'MASSUNIT',
  IFCPLANEANGLEMEASURE: 'PLANEANGLEUNIT',
  IFCTHERMODYNAMICTEMPERATUREMEASURE: 'THERMODYNAMICTEMPERATUREUNIT',
};

const SI_PREFIX = { EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k', HECTO: 'h', DECA: 'da', DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ', NANO: 'n' };
const SI_NAME = {
  METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g', SECOND: 's', RADIAN: 'rad', DEGREE_CELSIUS: '°C',
  KELVIN: 'K', NEWTON: 'N', PASCAL: 'Pa', WATT: 'W', JOULE: 'J', VOLT: 'V', AMPERE: 'A', HERTZ: 'Hz', LUMEN: 'lm', LUX: 'lx',
};

const SI_FACTOR = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9 };

/** Metres per unit for an IfcSIUnit or IfcConversionBasedUnit (length). */
function unitScale(u) {
  if (!u || typeof u !== 'object') return 1;
  if (u.ConversionFactor) {
    const vc = u.ConversionFactor.ValueComponent;
    const f = Number(vc && typeof vc === 'object' ? vc._representationValue ?? vc.value : vc);
    const base = unitScale(u.ConversionFactor.UnitComponent);
    return Number.isFinite(f) ? f * base : 1;
  }
  const prefix = u.Prefix?.value;
  return prefix ? SI_FACTOR[prefix] ?? 1 : 1;
}

function siSymbol(prefix, name) {
  const p = prefix ? SI_PREFIX[prefix] ?? '' : '';
  const n = SI_NAME[name] ?? name.toLowerCase();
  return p + n;
}

export function isSpatialType(ty) {
  const n = String(ty).toUpperCase();
  return ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY', 'IFCMARINEFACILITY'].includes(n);
}

function collectMaterials(obj, rows, api, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  const tn = api.GetNameFromTypeCode(obj.type);
  const name = (o) => decodeIfcString(o?.Name?.value ?? '');
  switch (tn) {
    case 'IFCMATERIAL':
      rows.push([t('mat.material'), name(obj)]);
      return;
    case 'IFCMATERIALLAYERSETUSAGE':
      collectMaterials(obj.ForLayerSet, rows, api, depth + 1);
      return;
    case 'IFCMATERIALLAYERSET': {
      if (obj.LayerSetName) rows.push([t('mat.layerSet'), fmtValue(obj.LayerSetName)]);
      (obj.MaterialLayers || []).forEach((l, i) => {
        const th = fmtValue(l.LayerThickness);
        rows.push([`${t('mat.layer')} ${i + 1}`, `${name(l.Material) || fmtValue(l.Name) || '?'}${th ? ` (${th})` : ''}`]);
      });
      return;
    }
    case 'IFCMATERIALLIST':
      for (const m of obj.Materials || []) collectMaterials(m, rows, api, depth + 1);
      return;
    case 'IFCMATERIALCONSTITUENTSET':
      for (const c of obj.MaterialConstituents || []) {
        rows.push([fmtValue(c.Name) || t('mat.constituent'), name(c.Material) + (c.Fraction ? ` (${fmtValue(c.Fraction)})` : '')]);
      }
      return;
    case 'IFCMATERIALPROFILESETUSAGE':
      collectMaterials(obj.ForProfileSet, rows, api, depth + 1);
      return;
    case 'IFCMATERIALPROFILESET':
      for (const p of obj.MaterialProfiles || []) {
        rows.push([fmtValue(p.Name) || t('mat.profile'), name(p.Material) + (p.Profile?.ProfileName ? ` – ${fmtValue(p.Profile.ProfileName)}` : '')]);
      }
      return;
    default:
      if (obj.Name) rows.push([prettyRawName(tn), fmtValue(obj.Name)]);
  }
}
