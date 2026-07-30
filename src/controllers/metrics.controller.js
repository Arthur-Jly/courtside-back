/**
 * Métriques produit de la phase 1.
 *
 * Le go/no-go se tranche sur trois chiffres, **mesurés par ville et par sport** :
 *   - ≥ 10 parties publiées par semaine et par ville
 *   - ≥ 50 % de parties remplies (minimum de joueurs atteint), par sport
 *   - ≥ 30 % de joueurs qui reviennent la semaine suivante
 *
 * Le foot et le basket sont suivis séparément : si l'un marche et pas l'autre,
 * une moyenne le masquerait. Même chose pour les villes.
 *
 * Source : `analytics_events` (écrite par utils/track.js).
 */
const { queryPromise } = require('../utils/dbHelpers');

const DEFAULT_DAYS = 42;   // 6 semaines : la durée du test de la phase 1

// Lundi de la semaine d'un événement (ISO). Sert de clé de série hebdomadaire ;
// contrairement à YEARWEEK, l'arithmétique « +1 semaine » reste juste en fin d'année.
const WEEK_START = 'DATE(created_at - INTERVAL WEEKDAY(created_at) DAY)';

function toDateTime(value, fallback) {
  const d = value ? new Date(value) : fallback;
  if (Number.isNaN(d.getTime())) return fallback.toISOString().slice(0, 19).replace('T', ' ');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

class MetricsController {
  constructor(db) {
    this.db = db;
  }

  async getPhase1Metrics({ from, to, city, days } = {}) {
    const span = Number(days) > 0 ? Number(days) : DEFAULT_DAYS;
    const toStr = toDateTime(to, new Date());
    const fromStr = toDateTime(from, new Date(Date.now() - span * 24 * 3600 * 1000));

    const cityClause = city ? ' AND LOWER(city) = LOWER(?)' : '';
    const cityParam = city ? [String(city).trim()] : [];

    const [totals, weekly, retention, places] = await Promise.all([
      this._byCitySport(fromStr, toStr, cityClause, cityParam),
      this._weekly(fromStr, toStr, cityClause, cityParam),
      this._retention(fromStr, toStr, cityClause, cityParam),
      this._placeQuality(city),
    ]);

    return { range: { from: fromStr, to: toStr }, by_city_sport: totals, weekly, retention, places };
  }

  /** Le tableau de bord principal : une ligne par ville × sport. */
  async _byCitySport(from, to, cityClause, cityParam) {
    const rows = await queryPromise(this.db, `
      SELECT COALESCE(city, '(inconnue)') AS city,
             COALESCE(sport, '(inconnu)') AS sport,
             SUM(type = 'game_published') AS published,
             SUM(type = 'game_filled')    AS filled,
             SUM(type = 'game_joined')    AS joins,
             SUM(type = 'game_left')      AS leaves,
             SUM(type = 'game_expired')   AS cancelled_no_players,
             SUM(type = 'game_cancelled') AS cancelled_by_organizer,
             ROUND(AVG(CASE WHEN type = 'game_filled'
                            THEN CAST(JSON_EXTRACT(payload, '$.hours_to_fill') AS DECIMAL(10,2)) END), 1) AS avg_hours_to_fill
      FROM analytics_events
      WHERE created_at BETWEEN ? AND ?${cityClause}
      GROUP BY city, sport
      ORDER BY published DESC
    `, [from, to, ...cityParam]);

    return rows.map(r => {
      const published = Number(r.published) || 0;
      const filled = Number(r.filled) || 0;
      const expired = Number(r.cancelled_no_players) || 0;
      return {
        city: r.city,
        sport: r.sport,
        published,
        filled,
        fill_rate_pct: pct(filled, published),
        joins: Number(r.joins) || 0,
        leaves: Number(r.leaves) || 0,
        cancelled_no_players: expired,
        cancelled_by_organizer: Number(r.cancelled_by_organizer) || 0,
        cancelled_rate_pct: pct(expired, published),
        avg_hours_to_fill: r.avg_hours_to_fill != null ? Number(r.avg_hours_to_fill) : null,
        // Seuils fixés à l'avance (PRODUCT_PLAN §3) : sans eux, on trouve
        // toujours une bonne raison de continuer.
        alerts: [
          ...(published > 0 && pct(filled, published) < 50 ? ['remplissage < 50 %'] : []),
          ...(published > 0 && pct(expired, published) > 30 ? ['annulations > 30 %'] : []),
        ],
      };
    });
  }

  /** Parties publiées par semaine (le seuil est de 10 par ville et par semaine). */
  async _weekly(from, to, cityClause, cityParam) {
    const rows = await queryPromise(this.db, `
      SELECT ${WEEK_START} AS week_start,
             COALESCE(city, '(inconnue)') AS city,
             COALESCE(sport, '(inconnu)') AS sport,
             COUNT(*) AS published
      FROM analytics_events
      WHERE type = 'game_published' AND created_at BETWEEN ? AND ?${cityClause}
      GROUP BY week_start, city, sport
      ORDER BY week_start ASC
    `, [from, to, ...cityParam]);

    return rows.map(r => ({
      week_start: r.week_start instanceof Date ? r.week_start.toISOString().slice(0, 10) : String(r.week_start),
      city: r.city,
      sport: r.sport,
      published: Number(r.published) || 0,
      below_target: (Number(r.published) || 0) < 10,
    }));
  }

  /**
   * Rétention S+1 : part des joueurs actifs une semaine qui rejoignent encore
   * une partie la semaine suivante. C'est la mesure « est-ce que ça devient une
   * habitude » — la seule qui distingue un lancement d'un usage.
   */
  async _retention(from, to, cityClause, cityParam) {
    const rows = await queryPromise(this.db, `
      SELECT w.week_start, w.city,
             COUNT(DISTINCT w.user_id) AS players,
             COUNT(DISTINCT n.user_id) AS returning_players
      FROM (
        SELECT DISTINCT ${WEEK_START} AS week_start, user_id, COALESCE(city, '(inconnue)') AS city
        FROM analytics_events
        WHERE type = 'game_joined' AND user_id IS NOT NULL
          AND created_at BETWEEN ? AND ?${cityClause}
      ) w
      LEFT JOIN (
        SELECT DISTINCT ${WEEK_START} AS week_start, user_id
        FROM analytics_events
        WHERE type = 'game_joined' AND user_id IS NOT NULL
      ) n ON n.user_id = w.user_id AND n.week_start = w.week_start + INTERVAL 7 DAY
      GROUP BY w.week_start, w.city
      ORDER BY w.week_start ASC
    `, [from, to, ...cityParam]);

    return rows.map(r => {
      const players = Number(r.players) || 0;
      const back = Number(r.returning_players) || 0;
      return {
        week_start: r.week_start instanceof Date ? r.week_start.toISOString().slice(0, 10) : String(r.week_start),
        city: r.city,
        players,
        returning_players: back,
        retention_pct: pct(back, players),
        below_target: players > 0 && pct(back, players) < 30,
      };
    });
  }

  /**
   * Qualité du référentiel par ville. Une majorité de lieux `auto` sur une ville
   * pilote signifie que la curation manuelle n'a pas été faite.
   */
  async _placeQuality(city) {
    const rows = await queryPromise(this.db, `
      SELECT city, verification_status, COUNT(*) AS count
      FROM public_places
      ${city ? 'WHERE LOWER(city) = LOWER(?)' : ''}
      GROUP BY city, verification_status
      ORDER BY count DESC
      LIMIT 200
    `, city ? [String(city).trim()] : []);

    const byCity = new Map();
    for (const r of rows) {
      const entry = byCity.get(r.city) || { city: r.city, total: 0, by_status: {} };
      entry.by_status[r.verification_status] = Number(r.count) || 0;
      entry.total += Number(r.count) || 0;
      byCity.set(r.city, entry);
    }
    return [...byCity.values()].map(e => ({
      ...e,
      verified_pct: pct(
        (e.by_status.manually_curated || 0) + (e.by_status.community_verified || 0),
        e.total,
      ),
    }));
  }
}

module.exports = MetricsController;
