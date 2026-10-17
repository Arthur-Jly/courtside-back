/**
 * Recoupement OpenStreetMap des terrains publics (seconde source après l'IGN).
 *
 * Règles durcies (oct. 2026) — l'ancien recoupement acceptait n'importe quel
 * terrain OU complexe sportif à 50 m, quel que soit le sport : un parking à côté
 * d'un complexe passait, un chantier aussi. Désormais :
 *   - uniquement `leisure=pitch` (un `sports_centre` seul ne prouve rien) ;
 *   - sport compatible avec le lieu (foot : soccer/multi ; basket : basketball/multi) ;
 *   - accès ni privé, ni réservé aux clients ;
 *   - le point du lieu dans l'emprise du terrain, ou son centre à ≤ 30 m ;
 *   - un terrain désaffecté (`disused:` / `abandoned:`) au même endroit est un
 *     signal négatif : il empêche la confirmation.
 *
 * Overpass est un service public gratuit et souvent saturé : jamais appelé
 * pendant une recherche (voir services/osmQueue), toujours avec un User-Agent
 * identifiable, en reculant sur 429/504.
 */
const { distanceM } = require('../utils/geo');
const { deriveStatus } = require('./placeStatus');

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'courtside-places/1.0 (contact: contact@courtside.fr)';
const MATCH_M = 30;
const BOUNDS_MARGIN_M = 5;
const TIMEOUT_MS = 90_000;
const MAX_RETRIES = 3;

// Sport OSM -> sports internes qu'il permet.
const OSM_SPORTS = {
  soccer: ['foot'], football: ['foot'], futsal: ['foot'],
  basketball: ['basket'],
  multi: ['foot', 'basket'],
};
const CLOSED_ACCESS = new Set(['private', 'customers', 'no']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildQuery({ south, west, north, east }) {
  const b = `${south},${west},${north},${east}`;
  return `[out:json][timeout:60];
(
  nwr["leisure"="pitch"](${b});
  nwr["disused:leisure"="pitch"](${b});
  nwr["abandoned:leisure"="pitch"](${b});
);
out tags bb;`;
}

/** Élément Overpass -> forme interne (centre, emprise, sports, accès, désaffecté). */
function normalize(el) {
  const t = el.tags || {};
  const b = el.bounds;
  const lat = el.lat ?? (b ? (b.minlat + b.maxlat) / 2 : null);
  const lng = el.lon ?? (b ? (b.minlon + b.maxlon) / 2 : null);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    ref: `${el.type}/${el.id}`,
    lat,
    lng,
    bounds: b || null,
    sports: String(t.sport || '').split(';').map(s => s.trim()).filter(Boolean),
    access: t.access || null,
    disused: t.leisure !== 'pitch' && (t['disused:leisure'] === 'pitch' || t['abandoned:leisure'] === 'pitch'),
  };
}

/** Sports internes du lieu (colonne JSON `sports`, texte ou tableau). */
function placeSports(place) {
  if (Array.isArray(place.sports)) return place.sports;
  try { return JSON.parse(place.sports || '[]'); } catch { return []; }
}

function sportCompatible(place, pitch) {
  const wanted = placeSports(place);
  return pitch.sports.some(s => (OSM_SPORTS[s] || []).some(k => wanted.includes(k)));
}

/** Distance du lieu au terrain : 0 dans l'emprise (+5 m), sinon au centre. */
function distanceTo(lat, lng, el) {
  if (el.bounds) {
    const mLat = BOUNDS_MARGIN_M / 111320;
    const mLng = BOUNDS_MARGIN_M / (111320 * Math.cos((lat * Math.PI) / 180));
    const b = el.bounds;
    if (lat >= b.minlat - mLat && lat <= b.maxlat + mLat && lng >= b.minlon - mLng && lng <= b.maxlon + mLng) return 0;
  }
  return distanceM(lat, lng, el.lat, el.lng);
}

/**
 * Verdict OSM pour un lieu : { ref, disused }.
 * `ref` = terrain actif compatible et accessible à ≤ 30 m (sinon null) ;
 * `disused` = terrain désaffecté au même endroit (et aucun actif).
 */
function matchPlace(place, elements) {
  const lat = Number(place.lat);
  const lng = Number(place.lng);
  let best = null;
  let disused = false;
  for (const el of elements) {
    const d = distanceTo(lat, lng, el);
    if (d > MATCH_M) continue;
    if (el.disused) { disused = true; continue; }
    if (!sportCompatible(place, el)) continue;
    if (el.access && CLOSED_ACCESS.has(el.access)) continue;
    if (!best || d < best.d) best = { ref: el.ref, d };
  }
  return { ref: best ? best.ref : null, disused: !best && disused };
}

/** Terrains OSM d'une boîte. Recule et réessaie sur 429/504 ; lève au-delà. */
async function fetchPitches(bbox, { fetchImpl = fetch, retries = MAX_RETRIES, wait = sleep, log = () => {} } = {}) {
  const body = `data=${encodeURIComponent(buildQuery(bbox))}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt >= retries) throw e;
      await wait(15_000 * (attempt + 1));
      continue;
    }
    if ((res.status === 429 || res.status === 504) && attempt < retries) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 15_000 * (attempt + 1);
      log(`Overpass ${res.status} — nouvelle tentative dans ${Math.round(ms / 1000)} s`);
      await wait(ms);
      continue;
    }
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = await res.json();
    return (json.elements || []).map(normalize).filter(Boolean);
  }
}

/**
 * Enregistre le verdict OSM de chaque lieu et recalcule son statut.
 * `q(sql, params)` renvoie une promesse (pool du service ou du script).
 */
async function apply(q, places, elements) {
  const counts = { confirmed: 0, disused: 0, unmatched: 0 };
  for (const p of places) {
    const m = matchPlace(p, elements);
    const status = deriveStatus({ ...p, osm_ref: m.ref, osm_checked_at: new Date() });
    await q(
      'UPDATE public_places SET osm_ref = ?, osm_disused = ?, osm_checked_at = NOW(), verification_status = ? WHERE id = ?',
      [m.ref, m.disused ? 1 : 0, status, p.id],
    );
    if (m.ref) counts.confirmed++;
    else if (m.disused) counts.disused++;
    else counts.unmatched++;
  }
  return counts;
}

module.exports = {
  OVERPASS_URL,
  USER_AGENT,
  MATCH_M,
  buildQuery,
  normalize,
  matchPlace,
  fetchPitches,
  apply,
};
