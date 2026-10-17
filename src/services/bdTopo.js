/**
 * BD TOPO de l'IGN — couche de recoupement « terrains de sport ».
 *
 * Source indépendante de Data ES : les terrains y sont relevés sur photos
 * aériennes, avec un état (« En service ») et une date de confirmation. Mesuré
 * en oct. 2026 sur 80 terrains : 90 % des terrains confirmés par OSM y figurent
 * à moins de 30 m ; 60 % des terrains sans preuve n'ont rien à moins de 60 m.
 *
 * Service public (Géoplateforme, licence Etalab) : un seul appel par zone, avec
 * un délai court — la recherche ne doit jamais attendre l'IGN plus de 3 s.
 */
const { distanceM, ringCentroid, pointInRing } = require('../utils/geo');

const WFS_URL = 'https://data.geopf.fr/wfs/ows';
const LAYER = 'BDTOPO_V3:terrain_de_sport';
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const TIMEOUT_MS = 3000;

// Un point Data ES à moins de 30 m d'un terrain IGN (ou dedans) : c'est lui.
const MATCH_M = 30;
// Entre 30 et 60 m : c'est lui, mais le point Data ES est mal placé (souvent à
// l'adresse) — on le recale sur le terrain.
const RECENTER_M = 60;

// Natures BD TOPO où l'on peut jouer au foot ou au basket. Exclues : tennis,
// natation, pistes d'athlétisme, carrières équestres.
const USABLE_NATURES = new Set(['Grand terrain de sport', 'Petit terrain multi-sports']);
const EXCLUDED_DETAILS = /rugby|volley/i;
const BASKET_TYPES = new Set(['Terrain de basket-ball', 'Terrain de basket-ball 3x3']);

/** Le terrain IGN peut-il être l'équipement Data ES de ce type ? */
function compatible(equipType, nature, detail) {
  if (!USABLE_NATURES.has(nature)) return false;
  if (detail && EXCLUDED_DETAILS.test(detail)) return false;
  // Un panier de basket n'est pas sur un grand terrain de foot.
  if (BASKET_TYPES.has(equipType)) return nature === 'Petit terrain multi-sports';
  return true;
}

function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(poly => poly[0]);
  return [];
}

/** Feature GeoJSON du WFS -> forme interne. Null si sans géométrie exploitable. */
function normalize(feature) {
  const p = feature.properties || {};
  const rings = outerRings(feature.geometry).filter(r => Array.isArray(r) && r.length >= 3);
  if (!p.cleabs || rings.length === 0) return null;
  const main = rings.reduce((a, b) => (b.length > a.length ? b : a));
  return {
    ref: p.cleabs,
    nature: p.nature || null,
    detail: p.nature_detaillee || null,
    inService: p.etat_de_l_objet === 'En service',
    confirmedAt: p.date_de_confirmation ? String(p.date_de_confirmation).slice(0, 10) : null,
    rings,
    centroid: ringCentroid(main),
  };
}

function buildUrl({ south, west, north, east }, startIndex) {
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: LAYER,
    OUTPUTFORMAT: 'application/json',
    SRSNAME: 'CRS:84',
    // CRS:84 = ordre longitude, latitude (EPSG:4326 inverserait les axes).
    BBOX: `${west},${south},${east},${north},CRS:84`,
    COUNT: String(PAGE_SIZE),
    STARTINDEX: String(startIndex),
    SORTBY: 'cleabs',
  });
  return `${WFS_URL}?${params}`;
}

/**
 * Terrains de sport BD TOPO dans une boîte { south, west, north, east }.
 * Lève en cas d'erreur réseau, HTTP ou de délai dépassé : à l'appelant d'avaler.
 */
async function fetchFeatures(bbox, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const features = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(buildUrl(bbox, page * PAGE_SIZE), { signal });
    if (!res.ok) throw new Error(`BD TOPO ${res.status}`);
    const json = await res.json();
    const batch = json.features || [];
    for (const f of batch) {
      const n = normalize(f);
      if (n) features.push(n);
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return features;
}

/**
 * Terrain IGN correspondant à un lieu { lat, lng, equip_type }, ou null.
 * Renvoie { feature, distance, inside, recenter } : `recenter` quand le point
 * est hors du terrain et à plus de 30 m — on le déplace alors sur le terrain.
 */
function matchPlace(place, features) {
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  let best = null;
  for (const f of features) {
    if (!f.inService || !compatible(place.equip_type, f.nature, f.detail)) continue;
    const inside = f.rings.some(r => pointInRing(lat, lng, r));
    const distance = inside ? 0 : distanceM(lat, lng, f.centroid.lat, f.centroid.lng);
    if (!best || distance < best.distance) best = { feature: f, distance, inside };
  }
  if (!best || best.distance > RECENTER_M) return null;
  return { ...best, recenter: !best.inside && best.distance > MATCH_M };
}

module.exports = {
  WFS_URL,
  LAYER,
  MATCH_M,
  RECENTER_M,
  compatible,
  normalize,
  buildUrl,
  fetchFeatures,
  matchPlace,
};
