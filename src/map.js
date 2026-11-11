// Map underlay: orthophoto / OpenStreetMap with an optional OpenRailwayMap overlay, draped as a
// ground plane under the models. Model coordinates are converted to the map's coordinate system
// with IfcMapConversion when the model has it, otherwise with settings the user enters.
import * as THREE from 'three';
import proj4 from 'proj4';

const WGS84 = 'EPSG:4326';
const TILE = 256;

/** Background maps (XYZ tiles in Web Mercator). */
export const BASEMAPS = {
  ortho: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Orthophoto: Esri, Maxar, Earthstar Geographics, GIS User Community',
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
};

/** OpenRailwayMap overlay styles. */
export const RAILWAY_STYLES = ['standard', 'maxspeed', 'signals', 'electrification', 'gauge'];
const RAILWAY_URL = 'https://tiles.openrailwaymap.org/{style}/{z}/{x}/{y}.png';
const RAILWAY_ATTRIBUTION = 'OpenRailwayMap (CC-BY-SA 2.0), © OpenStreetMap contributors';

/** Common projected coordinate systems (proj4 definitions are built in, others are fetched from epsg.io). */
export const COMMON_CRS = [
  ['EPSG:25832', 'ETRS89 / UTM zone 32N (DK, DE west, NO south)'],
  ['EPSG:25833', 'ETRS89 / UTM zone 33N (DK Bornholm, DE east, SE)'],
  ['EPSG:25831', 'ETRS89 / UTM zone 31N'],
  ['EPSG:25834', 'ETRS89 / UTM zone 34N'],
  ['EPSG:25835', 'ETRS89 / UTM zone 35N'],
  ['EPSG:3006', 'SWEREF99 TM (SE)'],
  ['EPSG:3067', 'ETRS-TM35FIN (FI)'],
  ['EPSG:31467', 'DHDN / 3-degree Gauss-Krüger zone 3 (DE)'],
  ['EPSG:31468', 'DHDN / 3-degree Gauss-Krüger zone 4 (DE)'],
  ['EPSG:2056', 'CH1903+ / LV95 (CH)'],
  ['EPSG:27700', 'OSGB 1936 / British National Grid (UK)'],
  ['EPSG:28992', 'Amersfoort / RD New (NL)'],
  ['EPSG:3857', 'WGS 84 / Pseudo-Mercator'],
];

const BUILTIN_DEFS = {
  'EPSG:3006': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:3067': '+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:31467': '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  'EPSG:31468': '+proj=tmerc +lat_0=0 +lon_0=12 +k=1 +x_0=4500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  'EPSG:2056': '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  'EPSG:27700': '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  'EPSG:28992': '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs',
};

/** Normalises "EPSG:25832", "25832", "ETRS89 / UTM zone 32N (EPSG 25832)" … to "EPSG:25832". */
export function normaliseCrs(text) {
  const m = String(text || '').match(/(\d{4,6})/);
  return m ? `EPSG:${m[1]}` : null;
}

/** Makes sure proj4 knows a coordinate system (built in, generated for UTM, or fetched from epsg.io). */
export async function ensureCrs(code) {
  if (proj4.defs(code)) return;
  const n = Number(code.split(':')[1]);
  if (n >= 25828 && n <= 25838) {
    proj4.defs(code, `+proj=utm +zone=${n - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`);
    return;
  }
  if ((n >= 32601 && n <= 32660) || (n >= 32701 && n <= 32760)) {
    const south = n > 32700;
    proj4.defs(code, `+proj=utm +zone=${n % 100}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`);
    return;
  }
  if (BUILTIN_DEFS[code]) { proj4.defs(code, BUILTIN_DEFS[code]); return; }
  const res = await fetch(`https://epsg.io/${n}.proj4`);
  const def = res.ok ? (await res.text()).trim() : '';
  if (!def.startsWith('+')) throw new Error(`Unknown coordinate system ${code}`);
  proj4.defs(code, def);
}

/**
 * Georeferencing between IFC project coordinates (metres) and map coordinates.
 * settings: {source: 'model' | 'manual', crs, e0, n0, rotation (degrees)}
 */
export function makeGeoref(settings, refModel) {
  if (settings.source === 'model' && refModel?.georef?.map) {
    const crs = normaliseCrs(refModel.georef.map.crs) || normaliseCrs(settings.crs);
    if (!crs) throw new Error('NO_CRS');
    return {
      crs,
      toMap: (x, y) => { const r = refModel.toMap({ x, y, z: 0 }); return [r.e, r.n]; },
      fromMap: (e, n) => { const r = refModel.fromMap(e, n); return [r.x, r.y]; },
    };
  }
  const crs = normaliseCrs(settings.crs);
  if (!crs) throw new Error('NO_CRS');
  const e0 = Number(settings.e0) || 0, n0 = Number(settings.n0) || 0;
  const th = ((Number(settings.rotation) || 0) * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  return {
    crs,
    toMap: (x, y) => [e0 + c * x - s * y, n0 + s * x + c * y],
    fromMap: (e, n) => { const de = e - e0, dn = n - n0; return [c * de + s * dn, -s * de + c * dn]; },
  };
}

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export class MapLayer {
  constructor(viewer) {
    this.viewer = viewer;
    this.mesh = null;
    this.attribution = '';
  }

  get visible() { return !!this.mesh; }

  /**
   * Builds the map plane.
   * opts: {georef settings…, basemap: 'ortho'|'osm'|'none', railway: style|'' , radius, opacity}
   * Returns {tiles, failed, zoom, attribution}.
   */
  async show(opts, onProgress = () => {}) {
    const viewer = this.viewer;
    const ref = viewer.models[0];
    const geo = makeGeoref(opts, ref);
    await ensureCrs(geo.crs);
    const toLonLat = (e, n) => proj4(geo.crs, WGS84, [e, n]);
    const fromLonLat = (lon, lat) => proj4(WGS84, geo.crs, [lon, lat]);

    // Model extent in IFC coordinates
    const box = viewer.sceneBox();
    if (box.isEmpty()) throw new Error('NO_MODEL');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = viewer.toIfc(new THREE.Vector3(x, y, z));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const radius = Number(opts.radius) > 0 ? Number(opts.radius) : Math.max(150, Math.hypot(maxX - minX, maxY - minY) * 0.9);
    const [ce, cn] = geo.toMap(cx, cy);
    const [lon, lat] = toLonLat(ce, cn);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85) throw new Error('BAD_COORDS');

    // Zoom so the area is about 1500 px wide, at most 8×8 tiles
    const base = BASEMAPS[opts.basemap];
    const maxZoom = base ? base.maxZoom : 19;
    const mpp = (2 * radius) / 1500;
    let z = Math.min(maxZoom, Math.max(3, Math.round(Math.log2((156543.034 * Math.cos((lat * Math.PI) / 180)) / mpp))));
    let range;
    const corners = [[ce - radius, cn - radius], [ce + radius, cn - radius], [ce - radius, cn + radius], [ce + radius, cn + radius]].map(([e, n]) => toLonLat(e, n));
    for (;;) {
      const xs = corners.map(([lo]) => lon2x(lo, z)), ys = corners.map(([, la]) => lat2y(la, z));
      range = { x0: Math.floor(Math.min(...xs)), x1: Math.floor(Math.max(...xs)), y0: Math.floor(Math.min(...ys)), y1: Math.floor(Math.max(...ys)) };
      if ((range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) <= 64 || z <= 3) break;
      z--;
    }
    const nx = range.x1 - range.x0 + 1, ny = range.y1 - range.y0 + 1;

    // Download and stitch the tiles
    const canvas = document.createElement('canvas');
    canvas.width = nx * TILE;
    canvas.height = ny * TILE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d9dde2';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const layers = [];
    if (base) layers.push(base.url);
    if (opts.railway) layers.push(RAILWAY_URL.replace('{style}', opts.railway));
    if (!layers.length) throw new Error('NO_LAYER');
    let done = 0, failed = 0;
    const total = nx * ny * layers.length;
    for (const tmpl of layers) {
      const jobs = [];
      for (let ty = range.y0; ty <= range.y1; ty++) {
        for (let tx = range.x0; tx <= range.x1; tx++) {
          const url = tmpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
          jobs.push(loadImage(url).then((img) => {
            done++;
            onProgress(done / total);
            if (!img) { failed++; return; }
            ctx.drawImage(img, (tx - range.x0) * TILE, (ty - range.y0) * TILE, TILE, TILE);
          }));
        }
      }
      await Promise.all(jobs); // layers are drawn in order, overlay on top
    }
    if (failed === total) throw new Error('TILES_FAILED');

    // Drape the stitched image on a grid whose corners are reprojected into model coordinates
    const G = 24;
    const pos = new Float32Array((G + 1) * (G + 1) * 3);
    const uv = new Float32Array((G + 1) * (G + 1) * 2);
    const zPlane = minZ - 0.05;
    let k = 0;
    for (let j = 0; j <= G; j++) {
      for (let i = 0; i <= G; i++) {
        const u = i / G, v = j / G;
        const tlon = x2lon(range.x0 + u * nx, z);
        const tlat = y2lat(range.y0 + v * ny, z);
        const [e, n] = fromLonLat(tlon, tlat);
        const [ix, iy] = geo.fromMap(e, n);
        const p = viewer.fromIfc(ix, iy, zPlane);
        pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
        uv[k * 2] = u; uv[k * 2 + 1] = 1 - v;
        k++;
      }
    }
    const idx = [];
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const a = j * (G + 1) + i, b = a + 1, c = a + G + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(idx);
    geom.computeBoundingSphere();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = viewer.renderer.capabilities.getMaxAnisotropy();
    const op = Math.min(1, Math.max(0.1, Number(opts.opacity) || 1));
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: op < 1, opacity: op, depthWrite: op >= 1 });

    this.remove();
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.renderOrder = -1;
    this.mesh.raycast = () => {}; // the map can't be picked or measured on
    viewer.scene.add(this.mesh);
    this.attribution = [base?.attribution, opts.railway ? RAILWAY_ATTRIBUTION : null].filter(Boolean).join(' · ');
    return { tiles: total, failed, zoom: z, crs: geo.crs, lon, lat, attribution: this.attribution };
  }

  setOpacity(op) {
    if (!this.mesh) return;
    const m = this.mesh.material;
    m.opacity = op;
    m.transparent = op < 1;
    m.depthWrite = op >= 1;
    m.needsUpdate = true;
  }

  remove() {
    if (!this.mesh) return;
    this.viewer.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.map?.dispose();
    this.mesh.material.dispose();
    this.mesh = null;
    this.attribution = '';
  }
}
