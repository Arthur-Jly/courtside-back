/**
 * Remplissage à la demande du référentiel de terrains publics.
 *
 * `public_places` est une copie locale de Data ES (ministère des Sports), pas un
 * miroir de tout le pays : les parties, les confirmations « j'ai joué ici » et
 * les signalements s'y accrochent par clé étrangère, et une recherche par
 * distance en SQL répond en quelques ms là où l'API en prend 300 à 500.
 *
 * Pour qu'une recherche sur n'importe quelle commune de France fonctionne sans
 * import préalable, `ensure()` interroge Data ES la première fois qu'une zone
 * est demandée, applique les mêmes filtres que l'import massif (services/dataEs),
 * enregistre les terrains retenus puis mémorise la zone (`place_coverage`).
 *
 * Garde-fous, car l'endpoint de recherche est public :
 *   - une seule requête par zone (~11 km) et par période de 30 jours ;
 *   - les demandes simultanées sur une même zone partagent un seul appel ;
 *   - budget d'appels sortants par heure ;
 *   - hors de France, on n'appelle pas l'API ;
 *   - toute erreur est avalée : la recherche répond avec ce qu'il y a en base.
 */
const { queryPromise, queryOne } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const dataEs = require('./dataEs');

const CELLS_PER_DEGREE = 10;          // cellule = 0,1° ≈ 11 km
const FETCH_RADIUS_KM = 25;           // > rayon de recherche (15) + demi-cellule
const MIN_LOCAL_PLACES = 10;          // au-delà, la zone est déjà bien fournie
const REFRESH_DAYS = 30;
const MAX_PAGES = 15;                 // 1 500 équipements : Paris en compte ~1 400
const PARALLEL_PAGES = 5;
const HOURLY_BUDGET = 60;

// France métropolitaine + Corse. Les DOM ne sont pas couverts pour l'instant.
const FRANCE = { latMin: 41.2, latMax: 51.3, lngMin: -5.6, lngMax: 9.9 };

const inFrance = (lat, lng) =>
  lat >= FRANCE.latMin && lat <= FRANCE.latMax && lng >= FRANCE.lngMin && lng <= FRANCE.lngMax;

function createPlaceCoverage(db, { fetchPage = dataEs.fetchPage, now = Date.now } = {}) {
  const q = (sql, params) => queryPromise(db, sql, params);
  const inFlight = new Map();
  let windowStart = now();
  let used = 0;

  const takeBudget = () => {
    if (now() - windowStart > 3600 * 1000) { windowStart = now(); used = 0; }
    if (used >= HOURLY_BUDGET) return false;
    used++;
    return true;
  };

  async function fetchAll(where) {
    const first = await fetchPage(where, 0);
    const results = [...(first.results || [])];
    const total = Number(first.total_count) || results.length;
    const pages = Math.min(Math.ceil(total / dataEs.PAGE_SIZE), MAX_PAGES);
    if (total > MAX_PAGES * dataEs.PAGE_SIZE) {
      logger.warn(`placeCoverage: ${total} équipements, seuls ${MAX_PAGES * dataEs.PAGE_SIZE} sont lus`);
    }
    const offsets = [];
    for (let p = 1; p < pages; p++) offsets.push(p * dataEs.PAGE_SIZE);
    for (let i = 0; i < offsets.length; i += PARALLEL_PAGES) {
      const batch = await Promise.all(offsets.slice(i, i + PARALLEL_PAGES).map(o => fetchPage(where, o)));
      for (const page of batch) results.push(...(page.results || []));
    }
    return results;
  }

  async function load(lat, lng, cellLat, cellLng) {
    const results = await fetchAll(dataEs.buildGeoWhere(lat, lng, FETCH_RADIUS_KM));
    const minDate = dataEs.minUpdateDate();
    const rows = [];
    const seen = new Set();
    for (const r of results) {
      if (dataEs.rejectReason(r, minDate) || seen.has(r.equip_numero)) continue;
      seen.add(r.equip_numero);
      rows.push(dataEs.toRow(r));
    }
    const counts = await dataEs.upsertPlaces(q, rows);
    // Enregistré seulement après un succès complet : un échec en cours de route
    // laisse la zone « non couverte » et sera retenté à la recherche suivante.
    await q(
      `INSERT INTO place_coverage (cell_lat, cell_lng, places_found, fetched_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE places_found = VALUES(places_found), fetched_at = NOW()`,
      [cellLat, cellLng, rows.length]
    );
    logger.info(`placeCoverage: zone ${cellLat}/${cellLng} — ${results.length} lus, ${rows.length} retenus, ${counts.inserted} insérés, ${counts.updated} mis à jour`);
  }

  /**
   * S'assure que la zone autour de (lat, lng) a été chargée depuis Data ES.
   * Ne lève jamais. Renvoie ce qui s'est passé :
   * 'fetched' | 'covered' | 'enough' | 'budget' | 'outside' | 'invalid' | 'failed'.
   */
  function ensure(lat, lng, radiusKm = 15) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return Promise.resolve('invalid');
    if (!inFrance(la, ln)) return Promise.resolve('outside');

    const cellLat = Math.floor(la * CELLS_PER_DEGREE);
    const cellLng = Math.floor(ln * CELLS_PER_DEGREE);
    const key = `${cellLat}:${cellLng}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const run = (async () => {
      const covered = await queryOne(db,
        `SELECT 1 AS ok FROM place_coverage
         WHERE cell_lat = ? AND cell_lng = ? AND fetched_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [cellLat, cellLng, REFRESH_DAYS]);
      if (covered) return 'covered';

      // Zone déjà bien fournie (import par département, terrains ajoutés) :
      // inutile de solliciter l'API.
      const latDelta = radiusKm / 111;
      const lngDelta = radiusKm / (111 * Math.max(Math.cos((la * Math.PI) / 180), 0.01));
      const local = await queryOne(db,
        'SELECT COUNT(*) AS n FROM public_places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?',
        [la - latDelta, la + latDelta, ln - lngDelta, ln + lngDelta]);
      if (Number(local?.n) >= MIN_LOCAL_PLACES) return 'enough';

      if (!takeBudget()) return 'budget';
      await load(la, ln, cellLat, cellLng);
      return 'fetched';
    })()
      .catch((err) => {
        logger.warn(`placeCoverage: chargement impossible (${err.message})`);
        return 'failed';
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, run);
    return run;
  }

  return { ensure };
}

module.exports = {
  createPlaceCoverage,
  FETCH_RADIUS_KM,
  MIN_LOCAL_PLACES,
  REFRESH_DAYS,
  HOURLY_BUDGET,
};
