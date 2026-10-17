/**
 * Vérification des terrains publics par la BD TOPO de l'IGN.
 *
 * Appelée par la recherche géographique, juste après le chargement de la zone
 * (services/placeCoverage) : les terrains de la zone jamais vérifiés (ou pas
 * depuis 6 mois) sont recoupés en UN appel au WFS de l'IGN, puis le résultat est
 * stocké sur chaque ligne. Une zone déjà vérifiée ne coûte qu'une requête SQL.
 *
 * Garde-fous, l'endpoint de recherche étant public :
 *   - rien à vérifier → aucun appel ;
 *   - délai max 3 s (bdTopo) et toute erreur avalée : la recherche répond avec
 *     ce qui est en base, les terrains restent à vérifier pour la fois suivante ;
 *   - recherches simultanées sur la même zone : un seul appel ;
 *   - budget d'appels sortants par heure.
 */
const { queryPromise } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const { bboxAround, bboxOf } = require('../utils/geo');
const bdTopo = require('./bdTopo');
const { deriveStatus } = require('./placeStatus');

const RECHECK_DAYS = 180;          // la BD TOPO est rééditée tous les trimestres
const HOURLY_BUDGET = 120;
const TILE_DEG = 0.1;              // script de masse : une requête par cellule ~11 km
const MARGIN_DEG = 0.001;          // ~100 m autour des lieux : un terrain IGN à cheval

const PLACE_COLUMNS = `id, equip_type, lat, lng, source, verification_status,
  ign_ref, osm_ref, osm_checked_at, original_lat, original_lng`;

function createPlaceVerification(db, { fetchIgn = bdTopo.fetchFeatures, now = Date.now } = {}) {
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

  /** Terrains de la boîte à (re)vérifier. */
  function pending({ south, west, north, east }) {
    return q(`
      SELECT ${PLACE_COLUMNS} FROM public_places
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
        AND verification_status <> 'reported_invalid'
        AND source_missing_at IS NULL
        AND (ign_checked_at IS NULL OR ign_checked_at < DATE_SUB(NOW(), INTERVAL ? DAY))
    `, [south, north, west, east, RECHECK_DAYS]);
  }

  /**
   * Recoupe chaque lieu avec les terrains IGN et enregistre le résultat.
   * Un lieu ajouté par un joueur n'est jamais déplacé : c'est lui qui a posé le point.
   */
  async function apply(places, features) {
    const counts = { confirmed: 0, recentered: 0, unmatched: 0 };
    for (const p of places) {
      const m = bdTopo.matchPlace(p, features);
      const status = deriveStatus({ ...p, ign_ref: m ? m.feature.ref : null });
      const recenter = !!(m && m.recenter && p.source !== 'user');

      const sets = ['ign_ref = ?', 'ign_nature = ?', 'ign_confirmed_at = ?', 'ign_checked_at = NOW()', 'verification_status = ?'];
      const params = [m ? m.feature.ref : null, m ? m.feature.nature : null, m ? m.feature.confirmedAt : null, status];
      if (recenter) {
        // Les coordonnées d'origine sont gardées une fois pour toutes.
        sets.push('lat = ?', 'lng = ?', 'original_lat = ?', 'original_lng = ?');
        params.push(
          m.feature.centroid.lat, m.feature.centroid.lng,
          p.original_lat != null ? p.original_lat : p.lat,
          p.original_lng != null ? p.original_lng : p.lng,
        );
      }
      params.push(p.id);
      await q(`UPDATE public_places SET ${sets.join(', ')} WHERE id = ?`, params);

      if (m) counts.confirmed++; else counts.unmatched++;
      if (recenter) counts.recentered++;
    }
    return counts;
  }

  /**
   * Vérifie les terrains autour de (lat, lng). Ne lève jamais. Renvoie :
   * 'verified' | 'checked' (rien à faire) | 'budget' | 'invalid' | 'failed'.
   */
  function verifyArea(lat, lng, radiusKm = 15) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return Promise.resolve('invalid');
    const box = bboxAround(la, ln, Number(radiusKm) || 15);
    const key = [box.south, box.west, box.north, box.east].map(v => v.toFixed(2)).join(':');
    if (inFlight.has(key)) return inFlight.get(key);

    const run = (async () => {
      const places = await pending(box);
      if (places.length === 0) return 'checked';
      if (!takeBudget()) return 'budget';
      const features = await fetchIgn(bboxOf(places.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })), MARGIN_DEG));
      const counts = await apply(places, features);
      logger.info(`placeVerification: ${places.length} terrains, ${counts.confirmed} confirmés IGN, ${counts.recentered} recalés, ${counts.unmatched} sans terrain IGN`);
      return 'verified';
    })()
      .catch((err) => {
        logger.warn(`placeVerification: BD TOPO indisponible (${err.message})`);
        return 'failed';
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, run);
    return run;
  }

  /**
   * Vérification en masse (scripts) : une requête IGN par cellule de 0,1°,
   * avec une pause entre deux. Sans budget horaire — c'est un traitement lancé
   * à la main. Lève sur la première erreur réseau.
   */
  async function verifyPlaces(places, { pauseMs = 300, onTile } = {}) {
    const tiles = new Map();
    for (const p of places) {
      const k = `${Math.floor(Number(p.lat) / TILE_DEG)}:${Math.floor(Number(p.lng) / TILE_DEG)}`;
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(p);
    }
    const total = { confirmed: 0, recentered: 0, unmatched: 0 };
    let i = 0;
    for (const group of tiles.values()) {
      const features = await fetchIgn(bboxOf(group.map(p => ({ lat: Number(p.lat), lng: Number(p.lng) })), MARGIN_DEG), { timeoutMs: 20000 });
      const counts = await apply(group, features);
      for (const k of Object.keys(total)) total[k] += counts[k];
      if (onTile) onTile(++i, tiles.size, counts);
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }
    return total;
  }

  return { verifyArea, verifyPlaces, apply };
}

module.exports = {
  createPlaceVerification,
  PLACE_COLUMNS,
  RECHECK_DAYS,
  HOURLY_BUDGET,
};
