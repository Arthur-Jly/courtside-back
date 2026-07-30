const { logger } = require('./logger');

/**
 * Journalisation d'un événement produit (table `analytics_events`).
 *
 * Fire-and-forget, ne jette jamais : une mesure ratée ne doit pas casser le
 * parcours qu'elle mesure. En contrepartie, l'échec est journalisé — un trou
 * silencieux dans les données fausserait le go/no-go de la phase 1.
 *
 * `city` et `sport` sont recopiés à l'écriture : ce sont les deux axes de la
 * densité, et ils doivent survivre à la suppression de l'annonce.
 */
const TYPES = [
  'game_published',
  'game_joined',
  'game_left',
  'game_filled',
  'game_cancelled',
  'game_expired',
  'place_confirmed',
  'place_reported',
];

function track(db, type, { userId, announcementId, placeId, city, sport, payload } = {}) {
  if (!TYPES.includes(type)) {
    logger.error(`track: type inconnu « ${type} »`);
    return;
  }
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const str = (v, max) => (v == null ? null : String(v).slice(0, max));

  db.query(
    `INSERT INTO analytics_events (type, user_id, announcement_id, place_id, city, sport, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      type,
      num(userId),
      num(announcementId),
      num(placeId),
      str(city, 120),
      str(sport, 30),
      payload ? JSON.stringify(payload).slice(0, 2000) : null,
    ],
    (err) => {
      if (err) logger.error(`track(${type}) failed: ${err.message}`);
    },
  );
}

module.exports = { track, TRACK_TYPES: TYPES };
