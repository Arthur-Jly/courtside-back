/**
 * Créneaux "last minute" : les vrais créneaux libres d'aujourd'hui et de
 * demain dans les clubs confirmés (la table de démo last_minute_slots a été
 * supprimée en migration 017). La forme de réponse reste celle que le front
 * consomme : { id, title, sport, time, location, address, terrainId, date }.
 */

const LIST_SQL = `
  SELECT s.id, s.date, s.start_time, s.end_time,
         t.id AS terrain_id, t.sport_type, t.name AS terrain_name, t.price_per_hour,
         c.name AS club_name, c.address, c.city
  FROM slots s
  JOIN terrains t ON t.id = s.terrain_id
  JOIN clubs c ON c.id = t.club_id AND c.status = 'confirme'
  WHERE s.status = 'free'
    AND ((s.date = CURDATE() AND s.start_time >= CURTIME())
         OR s.date = DATE_ADD(CURDATE(), INTERVAL 1 DAY))
`;

function fmtHour(t) {
  const [h, m] = String(t).split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
}

// JAMAIS toISOString ici : une DATE MySQL arrive en minuit LOCAL, la convertir
// en UTC recule d'un jour (TZ Europe/Paris) et "Aujourd'hui" devient "Demain".
function localYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toApiShape(row) {
  const today = localYmd(new Date());
  const dateStr = row.date instanceof Date ? localYmd(row.date) : String(row.date).slice(0, 10);
  const day = dateStr === today ? "Aujourd'hui" : 'Demain';
  const sport = String(row.sport_type || '').toLowerCase();
  return {
    id: row.id,
    terrainId: row.terrain_id,
    sport,
    title: `${sport.charAt(0).toUpperCase()}${sport.slice(1)} — ${row.club_name}`,
    time: `${day} ${fmtHour(row.start_time)} — ${fmtHour(row.end_time)}`,
    location: [row.club_name, row.city].filter(Boolean).join(', '),
    address: row.address || null,
    price: row.price_per_hour != null ? Number(row.price_per_hour) : null,
    date: dateStr,
    startsAt: `${dateStr}T${row.start_time}`,
  };
}

class LastMinuteController {
  constructor(db) {
    this.db = db;
  }

  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  /**
   * @param {Object} filters
   * @param {string} filters.sport - sport exact (optionnel)
   * @param {string} filters.location - recherche texte club/adresse/ville (optionnel)
   */
  async getLastMinuteSlots(filters = {}) {
    const { sport, location } = filters;
    let sql = LIST_SQL;
    const params = [];

    if (sport && sport !== 'all') {
      sql += ' AND LOWER(t.sport_type) = ?';
      params.push(String(sport).toLowerCase());
    }
    if (location && location.trim() !== '') {
      sql += ' AND (LOWER(c.name) LIKE ? OR LOWER(c.address) LIKE ? OR LOWER(c.city) LIKE ?)';
      const pattern = `%${location.toLowerCase()}%`;
      params.push(pattern, pattern, pattern);
    }
    sql += ' ORDER BY s.date, s.start_time LIMIT 30';

    const rows = await this.query(sql, params);
    return rows.map(toApiShape);
  }

  async getSlotById(id) {
    const rows = await this.query(`${LIST_SQL} AND s.id = ?`, [id]);
    if (rows.length === 0) throw new Error('Créneau introuvable');
    return toApiShape(rows[0]);
  }
}

module.exports = LastMinuteController;
