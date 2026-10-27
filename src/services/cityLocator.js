/**
 * Centre et rayon d'une commune, pour la recherche de terrains par ville seule.
 *
 * `GET /public-places?city=` ne porte pas de coordonnées : sans elles, ni le
 * chargement Data ES (placeCoverage) ni le recoupement IGN (placeVerification)
 * ne tournaient, et une ville jamais vue répondait vide. On résout la ville via
 * l'API Découpage administratif (geo.api.gouv.fr — publique, sans clé), puis la
 * recherche charge et vérifie la zone comme une recherche géographique.
 *
 * Garde-fous, l'endpoint étant public :
 *   - le nom renvoyé doit être celui demandé (accents et casse ignorés) : la
 *     recherche floue de l'API ne doit pas charger la zone d'une autre commune ;
 *   - cache mémoire (y compris les échecs « pas de commune ») et un seul appel
 *     par ville en cours ;
 *   - délai max 2 s, toute erreur avalée : la recherche répond avec la base.
 */
const { logger } = require('../utils/logger');

const API_URL = 'https://geo.api.gouv.fr/communes';
const TIMEOUT_MS = 2000;
const CACHE_MAX = 2000;
const MIN_RADIUS_KM = 3;
const MAX_RADIUS_KM = 15;

/** « Saint-Étienne » et « saint etienne » désignent la même ville. */
function normalizeCity(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Rayon couvrant la commune : celui d'un disque de même surface (hectares),
 * avec 50 % de marge pour les communes allongées, borné à 3–15 km.
 */
function radiusFromSurface(hectares) {
  const km2 = Number(hectares) / 100;
  if (!Number.isFinite(km2) || km2 <= 0) return MIN_RADIUS_KM;
  const r = Math.sqrt(km2 / Math.PI) * 1.5;
  return Math.round(Math.min(Math.max(r, MIN_RADIUS_KM), MAX_RADIUS_KM) * 10) / 10;
}

async function fetchCommunes(name, { timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${API_URL}?nom=${encodeURIComponent(name)}&fields=nom,centre,surface&boost=population&limit=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`geo.api.gouv.fr HTTP ${res.status}`);
  return res.json();
}

function createCityLocator({ fetchCommune = fetchCommunes } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const remember = (key, value) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  };

  /**
   * `{ lat, lng, radiusKm, name }` du centre de la commune, ou null. Ne rejette
   * jamais. `name` est le nom officiel (« Saint-Étienne » pour « saint etienne ») :
   * c'est lui que le filtre SQL sur `public_places.city` doit comparer.
   */
  function locate(city) {
    const key = normalizeCity(city);
    if (!key) return Promise.resolve(null);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inFlight.has(key)) return inFlight.get(key);

    const run = (async () => {
      const communes = await fetchCommune(String(city).trim());
      // `boost=population` classe la plus peuplée en tête parmi les homonymes.
      const hit = (Array.isArray(communes) ? communes : [])
        .find(c => normalizeCity(c.nom) === key && Array.isArray(c.centre?.coordinates));
      const found = hit
        ? { lat: hit.centre.coordinates[1], lng: hit.centre.coordinates[0], radiusKm: radiusFromSurface(hit.surface), name: hit.nom }
        : null;
      remember(key, found);
      return found;
    })()
      .catch((err) => {
        // Pas mis en cache : une panne passagère ne doit pas condamner la ville.
        logger.warn(`cityLocator: ${err.message}`);
        return null;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, run);
    return run;
  }

  return { locate };
}

module.exports = { createCityLocator, normalizeCity, radiusFromSurface };
