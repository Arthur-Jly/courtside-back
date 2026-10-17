/**
 * File d'attente du recoupement OSM, en arrière-plan.
 *
 * Overpass est lent (plusieurs secondes) et souvent saturé : la recherche n'en
 * attend jamais la réponse. Elle dépose sa zone ici et répond tout de suite ;
 * les terrains recoupés apparaissent à la recherche suivante.
 *
 * Une zone à la fois, pause entre deux, budget horaire, zones dédoublonnées
 * (cellules de 0,1°). Une zone en échec est abandonnée : la prochaine recherche
 * dessus la redéposera. In-process et en mémoire, comme sseHub : à remplacer
 * par une vraie file si l'API passe sur plusieurs instances.
 */
const { queryPromise } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const { bboxAround, bboxOf } = require('../utils/geo');
const osmCheck = require('./osmCheck');

const RECHECK_DAYS = 180;
const HOURLY_BUDGET = 30;
const PAUSE_MS = 10_000;
const MAX_QUEUE = 200;
const MARGIN_DEG = 0.001;

const OSM_COLUMNS = `id, sports, lat, lng, verification_status, ign_ref, osm_ref, osm_checked_at`;

function createOsmQueue(db, {
  fetchOsm = osmCheck.fetchPitches,
  pauseMs = PAUSE_MS,
  now = Date.now,
} = {}) {
  const q = (sql, params) => queryPromise(db, sql, params);
  const queue = [];
  const keys = new Set();
  let running = null;
  let windowStart = now();
  let used = 0;

  const takeBudget = () => {
    if (now() - windowStart > 3600 * 1000) { windowStart = now(); used = 0; }
    if (used >= HOURLY_BUDGET) return false;
    used++;
    return true;
  };

  async function processArea(box) {
    const places = await q(`
      SELECT ${OSM_COLUMNS} FROM public_places
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND verification_status <> 'reported_invalid'
        AND source_missing_at IS NULL
        AND (osm_checked_at IS NULL OR osm_checked_at < DATE_SUB(NOW(), INTERVAL ? DAY))
    `, [box.south, box.north, box.west, box.east, RECHECK_DAYS]);
    if (places.length === 0) return false;
    if (!takeBudget()) {
      logger.debug('osmQueue: budget horaire atteint, zone reportée');
      return false;
    }
    const elements = await fetchOsm(
      bboxOf(places.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })), MARGIN_DEG),
      { log: (m) => logger.debug(`osmQueue: ${m}`) },
    );
    const counts = await osmCheck.apply(q, places, elements);
    logger.info(`osmQueue: ${places.length} terrains, ${counts.confirmed} confirmés OSM, ${counts.disused} désaffectés, ${counts.unmatched} sans terrain OSM`);
    return true;
  }

  function drain() {
    if (running) return running;
    running = (async () => {
      while (queue.length) {
        const { key, box } = queue.shift();
        let called = false;
        try {
          called = await processArea(box);
        } catch (err) {
          logger.warn(`osmQueue: zone abandonnée (${err.message})`);
          called = true;
        } finally {
          keys.delete(key);
        }
        if (called && queue.length && pauseMs) await new Promise(r => setTimeout(r, pauseMs).unref?.());
      }
    })().finally(() => { running = null; });
    return running;
  }

  /** Dépose la zone autour de (lat, lng). Ne bloque jamais, ne lève jamais. */
  function enqueueArea(lat, lng, radiusKm = 15) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
    const key = `${Math.floor(la * 10)}:${Math.floor(ln * 10)}:${Math.round(Number(radiusKm) || 15)}`;
    if (keys.has(key) || queue.length >= MAX_QUEUE) return false;
    keys.add(key);
    queue.push({ key, box: bboxAround(la, ln, Number(radiusKm) || 15) });
    drain().catch(() => {});
    return true;
  }

  return { enqueueArea, drain, size: () => queue.length };
}

module.exports = { createOsmQueue, OSM_COLUMNS, HOURLY_BUDGET, RECHECK_DAYS };
