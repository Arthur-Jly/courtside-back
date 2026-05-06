/**
 * Contrôleur pour la gestion des créneaux last minute
 */

class LastMinuteController {
  constructor(db) {
    this.db = db;
  }

  /**
   * Récupère les créneaux last minute avec filtres optionnels
   * @param {Object} filters - Filtres de recherche
   * @param {string} filters.sport - Sport à filtrer (optionnel)
   * @param {string} filters.location - Recherche textuelle dans title, location, address et description (optionnel)
   * @returns {Promise<Array>} Liste des créneaux filtrés
   */
  async getLastMinuteSlots(filters = {}) {
    const { sport, location } = filters;
    let sql = 'SELECT * FROM last_minute_slots';
    const params = [];
    const conditions = [];

    // Validation et filtrage par sport
    if (sport && sport !== 'all') {
      conditions.push('LOWER(sport) = ?');
      params.push(sport.toLowerCase());
    }

    // Validation et filtrage par lieu/titre/description
    if (location && location.trim() !== '') {
      conditions.push('(LOWER(title) LIKE ? OR LOWER(location) LIKE ? OR LOWER(address) LIKE ? OR LOWER(description) LIKE ?)');
      const searchPattern = `%${location.toLowerCase()}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Construction de la requête finale
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    // Ajout d'un tri par défaut (plus récents en premier)
    sql += ' ORDER BY created_at DESC';

    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, slots) => {
        if (err) {
          reject(err);
        } else {
          resolve(slots);
        }
      });
    });
  }

  /**
   * Récupère un créneau par son ID
   * @param {number} id - ID du créneau
   * @returns {Promise<Object>} Créneau trouvé
   */
  async getSlotById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        'SELECT * FROM last_minute_slots WHERE id = ?',
        [id],
        (err, slots) => {
          if (err) {
            reject(err);
          } else if (slots.length === 0) {
            reject(new Error('Créneau introuvable'));
          } else {
            resolve(slots[0]);
          }
        }
      );
    });
  }
}

module.exports = LastMinuteController;
