// Et indlæst IFC-model: geometri, synlighed, farver, markering og metadata.
import * as THREE from 'three';
import * as WebIFC from 'web-ifc';
import { fmtValue, prettyTypeName, prettyRawName, decodeIfcString } from './ifc.js';

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
  constructor({ name, api, modelID, buckets, schema, fileSize, coordMatrix, spaceIds }) {
    this.uid = nextUid++;
    this.name = name;
    this.api = api;
    this.modelID = modelID;
    this.schema = schema;
    this.fileSize = fileSize;
    this.coordMatrix = coordMatrix;
    this.spaceIds = spaceIds || new Set();

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

    // Rum er skjult som standard.
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

    // Klasser for alle elementer med geometri
    this.typeOf = new Map();
    this.classes = new Map(); // klassenavn -> [ids]
    for (const id of this.elementIds) {
      const t = prettyTypeName(api, api.GetLineType(this.modelID, id));
      this.typeOf.set(id, t);
      if (!this.classes.has(t)) this.classes.set(t, []);
      this.classes.get(t).push(id);
    }
    this.units = this.#readUnits();
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
      out.Filnavn = s(args[0]);
      out.Tidsstempel = s(args[1]);
      out.Forfatter = s(args[2]);
      out.Organisation = s(args[3]);
      out.Præprocessor = s(args[4]);
      out['Oprindeligt system'] = s(args[5]);
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

  // ------------------------------------------------------------------ metadata
  /** Samler alle metadata for et element i sektioner til egenskabspanelet. */
  async getElementData(id) {
    const api = this.api;
    const mid = this.modelID;
    const sections = [];

    const line = api.GetLine(mid, id, false);
    const cls = this.typeName(id);

    // Attributter
    const attrs = [['Klasse', cls], ['Express ID', `#${id}`]];
    for (const [k, v] of Object.entries(line || {})) {
      if (k === 'expressID' || k === 'type') continue;
      attrs.push([k, this.#fmtAttr(v)]);
    }
    sections.push({ title: 'Attributter', rows: attrs, open: true });

    // Placering i den rumlige struktur
    const chain = [];
    let p = this.parent.get(id);
    while (p !== undefined) {
      chain.unshift([this.typeName(p), this.label(p), p]);
      p = this.parent.get(p);
    }
    if (chain.length) sections.push({ title: 'Placering', rows: chain.map(([t, l, pid]) => [t, l, pid]), open: true, links: true });

    // Egenskabssæt og mængder på instansen
    try {
      const psets = await api.properties.getPropertySets(mid, id, true, false);
      for (const ps of psets) sections.push(this.#psetSection(ps, ''));
    } catch (e) { console.warn(e); }

    // Type og typeegenskaber
    try {
      const types = await api.properties.getTypeProperties(mid, id, true);
      for (const t of types) {
        const rows = [['Klasse', prettyTypeName(api, t.type)], ['Express ID', `#${t.expressID}`]];
        for (const k of ['Name', 'Description', 'GlobalId', 'Tag', 'ElementType', 'PredefinedType', 'ApplicableOccurrence']) {
          if (t[k]) rows.push([k, fmtValue(t[k])]);
        }
        sections.push({ title: `Type: ${fmtValue(t.Name) || prettyTypeName(api, t.type)}`, rows, open: true });
        for (const ps of t.HasPropertySets || []) {
          if (ps && typeof ps === 'object' && 'expressID' in ps) sections.push(this.#psetSection(ps, ' (type)'));
        }
      }
    } catch (e) { console.warn(e); }

    // Materialer
    try {
      const mats = await api.properties.getMaterialsProperties(mid, id, true, true);
      const rows = [];
      for (const m of mats) collectMaterials(m, rows, api, 0);
      if (rows.length) sections.push({ title: 'Materialer', rows, open: true });
    } catch (e) { console.warn(e); }

    // Klassifikationer (fx BIM7AA, Uniclass) via IfcRelAssociatesClassification
    try {
      const rows = this.#classifications(id);
      if (rows.length) sections.push({ title: 'Klassifikation', rows, open: true });
    } catch (e) { console.warn(e); }

    sections.push({
      title: 'Model',
      rows: [['Fil', this.name], ['Skema', this.schema], ...Object.entries(this.header).filter(([, v]) => v)],
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

  #psetSection(ps, suffix) {
    const rows = [];
    const isQto = Array.isArray(ps.Quantities);
    const list = ps.HasProperties || ps.Quantities || [];
    for (const prop of list) this.#propRows(prop, rows, '');
    if (!list.length) {
      // IfcPreDefinedPropertySet m.fl.: attributterne er selve egenskaberne
      for (const [k, v] of Object.entries(ps)) {
        if (['expressID', 'type', 'GlobalId', 'OwnerHistory', 'Name', 'Description'].includes(k)) continue;
        const s = fmtValue(v);
        if (s) rows.push([k, s]);
      }
    }
    return {
      title: `${fmtValue(ps.Name) || prettyTypeName(this.api, ps.type)}${suffix}`,
      rows,
      open: true,
      kind: isQto ? 'qto' : 'pset',
    };
  }

  #propRows(prop, rows, prefix) {
    if (!prop || typeof prop !== 'object') return;
    const name = prefix + (fmtValue(prop.Name) || `#${prop.expressID}`);
    if (Array.isArray(prop.HasProperties)) {
      for (const sub of prop.HasProperties) this.#propRows(sub, rows, `${name} › `);
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
      for (const [k, t] of QTO_UNITS) {
        if (k in prop) { value = fmtValue(prop[k]); unitType = t; break; }
      }
    }
    let unit = '';
    if (prop.Unit && typeof prop.Unit === 'object') {
      if (prop.Unit.Name?.value) unit = siSymbol(prop.Unit.Prefix?.value, prop.Unit.Name.value);
    } else if (unitType && this.units[unitType]) unit = this.units[unitType];
    else if (!unitType && prop.NominalValue?.name) {
      const t = MEASURE_UNITS[prop.NominalValue.name];
      if (t && this.units[t]) unit = this.units[t];
    }
    rows.push([name, value + (unit && value !== '' ? ` ${unit}` : '')]);
  }

  #classifications(id) {
    const api = this.api;
    const rows = [];
    const rels = api.GetLineIDsWithType(this.modelID, WebIFC.IFCRELASSOCIATESCLASSIFICATION);
    if (!this._clsIndex) {
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
      rows.push([system || 'Klassifikation', [code, fmtValue(c.Name)].filter(Boolean).join(' – ')]);
    }
    return rows;
  }

  /** Samler alle egenskaber for alle elementer (til CSV-eksport). */
  async exportRows(onProgress = () => {}) {
    const ids = [...this.elementIds];
    const rows = [];
    const cols = new Set(['Model', 'ExpressID', 'GlobalId', 'Klasse', 'Navn', 'Etage']);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const line = this.api.GetLine(this.modelID, id, false);
      const row = {
        Model: this.name,
        ExpressID: id,
        GlobalId: fmtValue(line?.GlobalId),
        Klasse: this.typeName(id),
        Navn: fmtValue(line?.Name),
        Etage: this.#storeyOf(id),
      };
      try {
        const psets = await this.api.properties.getPropertySets(this.modelID, id, true, true);
        for (const ps of psets) {
          const sec = this.#psetSection(ps, '');
          for (const [k, v] of sec.rows) {
            const col = `${sec.title}.${k}`;
            cols.add(col);
            row[col] = v;
          }
        }
      } catch { /* ignorer */ }
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
    try { this.api.CloseModel(this.modelID); } catch { /* allerede lukket */ }
  }
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

function siSymbol(prefix, name) {
  const p = prefix ? SI_PREFIX[prefix] ?? '' : '';
  const n = SI_NAME[name] ?? name.toLowerCase();
  if (p && (n === 'm²' || n === 'm³')) return `${p}${n}`; // fx mm² (præfiks på grundenheden)
  return p + n;
}

export function isSpatialType(t) {
  const n = String(t).toUpperCase();
  return ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCROAD', 'IFCRAILWAY', 'IFCMARINEFACILITY'].includes(n);
}

function collectMaterials(obj, rows, api, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  const t = api.GetNameFromTypeCode(obj.type);
  const name = (o) => decodeIfcString(o?.Name?.value ?? '');
  switch (t) {
    case 'IFCMATERIAL':
      rows.push(['Materiale', name(obj)]);
      return;
    case 'IFCMATERIALLAYERSETUSAGE':
      collectMaterials(obj.ForLayerSet, rows, api, depth + 1);
      return;
    case 'IFCMATERIALLAYERSET': {
      if (obj.LayerSetName) rows.push(['Lagopbygning', fmtValue(obj.LayerSetName)]);
      (obj.MaterialLayers || []).forEach((l, i) => {
        const th = fmtValue(l.LayerThickness);
        rows.push([`Lag ${i + 1}`, `${name(l.Material) || fmtValue(l.Name) || '?'}${th ? ` (${th})` : ''}`]);
      });
      return;
    }
    case 'IFCMATERIALLIST':
      for (const m of obj.Materials || []) collectMaterials(m, rows, api, depth + 1);
      return;
    case 'IFCMATERIALCONSTITUENTSET':
      for (const c of obj.MaterialConstituents || []) {
        rows.push([fmtValue(c.Name) || 'Bestanddel', name(c.Material) + (c.Fraction ? ` (${fmtValue(c.Fraction)})` : '')]);
      }
      return;
    case 'IFCMATERIALPROFILESETUSAGE':
      collectMaterials(obj.ForProfileSet, rows, api, depth + 1);
      return;
    case 'IFCMATERIALPROFILESET':
      for (const p of obj.MaterialProfiles || []) {
        rows.push([fmtValue(p.Name) || 'Profil', name(p.Material) + (p.Profile?.ProfileName ? ` – ${fmtValue(p.Profile.ProfileName)}` : '')]);
      }
      return;
    default:
      if (obj.Name) rows.push([prettyRawName(t), fmtValue(obj.Name)]);
  }
}
