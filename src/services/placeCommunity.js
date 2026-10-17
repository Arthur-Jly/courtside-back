/**
 * Validation communautaire des terrains publics (couche 3).
 *
 *   - Signalement « inexistant » : le seuil dépend de ce qu'on sait déjà du
 *     terrain. Sans aucune preuve, un seul signalement suffit à le retirer ;
 *     recoupé (IGN, OSM), il en faut deux ; confirmé par des joueurs, trois.
 *     Une vérification Courtside (curation) n'est jamais annulée.
 *   - « J'ai joué ici » ne compte que d'un joueur qui y a participé à une partie,
 *     ou qui est sur place (≤ 300 m). Trois comptes quelconques ne suffisent plus.
 *   - Après une partie, les participants reçoivent « Le terrain existait ? ».
 *   - Un terrain confirmé par la communauté sans activité depuis 18 mois perd
 *     ce statut et retombe sur ses preuves IGN / OSM (ou « À confirmer »).
 */
const { queryPromise } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const { notify } = require('../utils/notify');

const CONFIRM_RADIUS_M = 300;
const COMMUNITY_WINDOW_MONTHS = 18;

const REPORT_THRESHOLDS = {
  auto: 1,
  ign_confirmed: 2,
  osm_confirmed: 2,
  community_verified: 3,
};

/** Nombre de signalements « inexistant » qui retirent le terrain (Infinity = jamais). */
function reportThreshold(status) {
  return REPORT_THRESHOLDS[status] ?? Infinity;
}

// Statut qui découle des preuves, en SQL (même ordre que services/placeStatus).
const EVIDENCE_STATUS_SQL = `CASE
    WHEN ign_ref IS NOT NULL THEN 'ign_confirmed'
    WHEN osm_ref IS NOT NULL THEN 'osm_confirmed'
    ELSE 'auto'
  END`;

/**
 * « Le terrain existait ? » : pour chaque partie sur un terrain public terminée
 * dans les dernières 24 h, une notification à chaque participant. Une seule fois
 * par partie (place_check_sent_at). Ne lève jamais.
 */
async function askPlaceChecks(db, { notifyFn = notify } = {}) {
  let games;
  try {
    games = await queryPromise(db, `
      SELECT a.id, a.public_place_ref, p.name AS place_name
      FROM announcements a
      JOIN public_places p ON p.id = a.public_place_ref
      WHERE a.place_check_sent_at IS NULL
        AND a.status <> 'cancelled'
        AND a.slot_end <= NOW()
        AND a.slot_end > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND p.verification_status NOT IN ('manually_curated', 'reported_invalid')
      LIMIT 200
    `, []);
  } catch (err) {
    logger.error(`[CRON] Questions « terrain existant » : requête échouée (${err.message})`);
    return { asked: 0 };
  }

  let asked = 0;
  for (const g of games) {
    try {
      const players = await queryPromise(db,
        'SELECT DISTINCT user_id FROM annonce_participants WHERE annonce_id = ? AND user_id IS NOT NULL', [g.id]);
      for (const { user_id: userId } of players) {
        notifyFn(db, userId, 'place_check', { place_id: g.public_place_ref, place_name: g.place_name, announcement_id: g.id });
        asked++;
      }
      await queryPromise(db, 'UPDATE announcements SET place_check_sent_at = NOW() WHERE id = ?', [g.id]);
    } catch (err) {
      logger.error(`[CRON] Question « terrain existant » partie ${g.id} : ${err.message}`);
    }
  }
  if (asked > 0) logger.info(`[CRON] ${asked} question(s) « le terrain existait ? » envoyée(s)`);
  return { asked };
}

/**
 * Expiration : un `community_verified` sans confirmation ni partie depuis
 * 18 mois retombe sur ses preuves. Ne lève jamais.
 */
async function expireCommunityVerified(db) {
  try {
    const res = await queryPromise(db, `
      UPDATE public_places
      SET verification_status = ${EVIDENCE_STATUS_SQL}
      WHERE verification_status = 'community_verified'
        AND COALESCE(last_played_at, updated_at) < DATE_SUB(NOW(), INTERVAL ? MONTH)
    `, [COMMUNITY_WINDOW_MONTHS]);
    if (res.affectedRows > 0) logger.info(`[CRON] ${res.affectedRows} terrain(s) confirmé(s) par la communauté sans activité : statut réévalué`);
    return { expired: res.affectedRows || 0 };
  } catch (err) {
    logger.error(`[CRON] Expiration des confirmations communautaires échouée : ${err.message}`);
    return { expired: 0 };
  }
}

module.exports = {
  CONFIRM_RADIUS_M,
  COMMUNITY_WINDOW_MONTHS,
  reportThreshold,
  askPlaceChecks,
  expireCommunityVerified,
};
