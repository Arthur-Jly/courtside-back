/**
 * Contrôleur pour la gestion des clubs et terrains
 */

const datagouvApi = require('../services/datagouvApi');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const { NotFoundError, ConflictError } = require('../middleware/errorHandler');

class ClubsController {
  constructor(db) {
    this.db = db;
  }

  /**
   * Récupère les clubs avec filtres optionnels
   * Fusionne les clubs de la BDD avec les équipements sportifs de data.gouv.fr
   * @param {Object} filters - Filtres de recherche
   * @param {number} filters.lat - Latitude (optionnel)
   * @param {number} filters.lon - Longitude (optionnel)
   * @param {string} filters.sport - Sport à filtrer (optionnel)
   * @param {number} filters.radius - Rayon de recherche en km (optionnel)
   * @param {number} filters.limit - Limite de résultats (défaut: 50)
   * @param {boolean} filters.includeDatagouv - Inclure les équipements data.gouv.fr (défaut: true)
   * @returns {Promise<Array>} Liste des clubs filtrés (BDD + data.gouv)
   */
  async getClubs(filters = {}) {
    const { lat, lon, sport, radius, limit = 50, includeDatagouv = true, city } = filters;

    // 1. Récupérer les clubs de la base de données
    const dbClubs = await this._getDbClubs({ lat, lon, sport, radius, limit, city });
    
    // 2. Si coordonnées GPS fournies et includeDatagouv=true, récupérer aussi les équipements data.gouv
    let datagouvClubs = [];
    if (includeDatagouv && lat && lon) {
      try {
        const equipements = await datagouvApi.searchEquipements({
          lat,
          lon,
          sport,
          radius: radius || 50,
          limit: Math.max(20, limit - dbClubs.length),
        });
        datagouvClubs = equipements.map(eq =>
          datagouvApi.transformEquipementToClub(eq, lat, lon)
        );
      } catch {
        // non-blocking: continue with DB clubs only
      }
    }
    
    // 3. Fusionner et trier par distance
    let allClubs = [...dbClubs, ...datagouvClubs];

    if (city) {
      const cityLower = String(city).toLowerCase();
      allClubs = allClubs.filter(c => String(c.city || '').toLowerCase().includes(cityLower));
    }
    
    // Trier par distance si disponible, sinon garder l'ordre
    if (lat && lon) {
      allClubs.sort((a, b) => {
        const distA = a.distance_km ?? Infinity;
        const distB = b.distance_km ?? Infinity;
        return distA - distB;
      });
    }
    
    return allClubs.slice(0, parseInt(limit, 10));
  }

  /**
   * Récupère les clubs de la base de données uniquement
   * @private
   */
  async _getDbClubs(filters = {}) {
    const { lat, lon, sport, radius, limit = 50, city } = filters;

    // Requête avec calcul de distance
    if (lat && lon) {
      let sql = `
        SELECT c.id, c.name, c.address, c.city, c.lat, c.lon, c.rating,
          GROUP_CONCAT(DISTINCT cs.sport_name) AS sports,
          GROUP_CONCAT(DISTINCT ci.image_url) AS images,
          MIN(t.price_per_hour) AS min_price,
          MAX(t.price_per_hour) AS max_price,
          ( 6371 * acos(
              cos(radians(?)) * cos(radians(c.lat)) * cos(radians(c.lon) - radians(?))
              + sin(radians(?)) * sin(radians(c.lat))
          ) ) AS distance_km
        FROM clubs c
        LEFT JOIN club_sports cs ON c.id = cs.club_id
        LEFT JOIN club_images ci ON c.id = ci.club_id
        LEFT JOIN terrains t ON c.id = t.club_id${sport && sport.toLowerCase() !== 'all' ? ' AND t.sport_type LIKE ?' : ''}
        WHERE c.status = 'confirme'
      `;

      const conditions = [];
      const params = [parseFloat(lat), parseFloat(lon), parseFloat(lat)];
      
      // Ajouter le param sport pour la jointure terrains si nécessaire
      if (sport && sport.toLowerCase() !== 'all') {
        params.push(`%${sport}%`);
      }

      // Filtrage par sport
      if (sport && sport.toLowerCase() !== 'all') {
        conditions.push('cs.sport_name LIKE ?');
        params.push(`%${sport}%`);
      }

      if (city) {
        conditions.push('c.city LIKE ?');
        params.push(`%${city}%`);
      }

      if (conditions.length > 0) {
        sql += ` AND ${conditions.join(' AND ')}`;
      }

      sql += ` GROUP BY c.id HAVING distance_km IS NOT NULL`;

      // Filtrage par rayon
      if (radius) {
        sql += ` AND distance_km <= ?`;
        params.push(parseFloat(radius));
      }

      sql += ` ORDER BY distance_km LIMIT ?`;
      params.push(parseInt(limit, 10));

      const clubs = await queryPromise(this.db, sql, params);
      // Transforme les chaînes en tableaux
      return clubs.map(club => ({
        ...club,
        sports: club.sports ? club.sports.split(',') : [],
        images: club.images ? club.images.split(',') : [],
        lng: club.lon, // Alias pour compatibilité front
        min_price: club.min_price || null,
        max_price: club.max_price || null,
      }));
    }

    // Requête sans distance
    let sql = `
      SELECT c.id, c.name, c.address, c.city, c.lat, c.lon, c.rating,
        GROUP_CONCAT(DISTINCT cs.sport_name) AS sports,
        GROUP_CONCAT(DISTINCT ci.image_url) AS images,
        MIN(t.price_per_hour) AS min_price,
        MAX(t.price_per_hour) AS max_price
      FROM clubs c
      LEFT JOIN club_sports cs ON c.id = cs.club_id
      LEFT JOIN club_images ci ON c.id = ci.club_id
      LEFT JOIN terrains t ON c.id = t.club_id${sport && sport.toLowerCase() !== 'all' ? ' AND t.sport_type LIKE ?' : ''}
      WHERE c.status = 'confirme'
    `;

    const conditions = [];
    const params = [];
    
    // Ajouter le param sport pour la jointure terrains si nécessaire
    if (sport && sport.toLowerCase() !== 'all') {
      params.push(`%${sport}%`);
    }

    // Filtrage par sport
    if (sport && sport.toLowerCase() !== 'all') {
      conditions.push('cs.sport_name LIKE ?');
      params.push(`%${sport}%`);
    }

    if (city) {
      conditions.push('c.city LIKE ?');
      params.push(`%${city}%`);
    }

    if (conditions.length > 0) {
      sql += ` AND ${conditions.join(' AND ')}`;
    }

    sql += ` GROUP BY c.id LIMIT ?`;
    params.push(parseInt(limit, 10));

    const clubs = await queryPromise(this.db, sql, params);
    return clubs.map(club => ({
      ...club,
      sports: club.sports ? club.sports.split(',') : [],
      images: club.images ? club.images.split(',') : [],
      lng: club.lon,
      min_price: club.min_price || null,
      max_price: club.max_price || null,
    }));
  }

  /**
   * Récupère les clubs avec streaming progressif
   * Envoie les clubs BDD immédiatement, puis les clubs data.gouv progressivement par lots
   * @param {Object} filters - Filtres de recherche
   * @param {Function} onData - Callback appelée pour chaque lot de clubs
   * @returns {Promise<void>}
   */
  async getClubsStream(filters = {}, onData) {
    const { lat, lon, sport, radius, limit = 50, includeDatagouv = true } = filters;

    // 1. Récupérer et envoyer immédiatement les clubs de la base de données
    const dbClubs = await this._getDbClubs({ lat, lon, sport, radius, limit });
    
    logger.debug(`ClubsController stream sending ${dbClubs.length} DB clubs`);
    onData({ clubs: dbClubs, source: 'database', done: false });

    // 2. Si coordonnées GPS fournies et includeDatagouv=true, récupérer les équipements data.gouv
    if (includeDatagouv && lat && lon) {
      try {
        logger.debug('ClubsController datagouv search', { lat, lon, sport, radius });
        
        // Récupérer tous les équipements (l'API data.gouv gère déjà la pagination en interne)
        const equipements = await datagouvApi.searchEquipements({
          lat,
          lon,
          sport,
          radius: radius || 50,
          limit: Math.max(20, limit - dbClubs.length), // Compléter jusqu'à la limite
        });

        if (equipements.length > 0) {
          // Transformer et envoyer les équipements par lots de 10
          const batchSize = 10;
          for (let i = 0; i < equipements.length; i += batchSize) {
            const batch = equipements.slice(i, i + batchSize);
            const datagouvClubs = batch.map(eq => 
              datagouvApi.transformEquipementToClub(eq, lat, lon)
            );
            
            const isLastBatch = i + batchSize >= equipements.length;
            logger.debug(`ClubsController batch ${Math.floor(i / batchSize) + 1} of ${datagouvClubs.length} datagouv equipments`);
            
            onData({ 
              clubs: datagouvClubs, 
              source: 'data.gouv.fr', 
              done: isLastBatch
            });

            // Petite pause entre les lots pour un effet de streaming
            if (!isLastBatch) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
        } else {
          logger.debug('ClubsController no datagouv equipment found');
          onData({ clubs: [], source: 'data.gouv.fr', done: true });
        }
      } catch (error) {
        logger.warn(`ClubsController datagouv error (non-blocking): ${error.message}`);
        // Envoyer un événement de fin même en cas d'erreur
        onData({ clubs: [], source: 'data.gouv.fr', done: true, error: error.message });
      }
    } else {
      // Signal de fin si pas de data.gouv
      onData({ clubs: [], source: 'done', done: true });
    }
  }

  /**
   * Récupère un club par son ID
   * @param {number} id - ID du club
   * @returns {Promise<Object>} Club trouvé
   */
  async getClubById(id) {
    const sql = `
      SELECT c.id, c.name, c.address, c.city, c.lat, c.lon, c.rating,
        GROUP_CONCAT(DISTINCT cs.sport_name) AS sports,
        GROUP_CONCAT(DISTINCT ci.image_url) AS images
      FROM clubs c
      LEFT JOIN club_sports cs ON c.id = cs.club_id
      LEFT JOIN club_images ci ON c.id = ci.club_id
      WHERE c.id = ? AND c.status = 'confirme'
      GROUP BY c.id
    `;

    const club = await queryOne(this.db, sql, [id]);
    if (!club) throw new NotFoundError('Club introuvable');

    return {
      ...club,
      sports: club.sports ? club.sports.split(',') : [],
      images: club.images ? club.images.split(',') : [],
      lng: club.lon,
    };
  }

  /**
   * Récupère les terrains d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Array>} Liste des terrains avec leurs images
   */
  async getTerrainsByClubId(clubId) {
    const sql = `
      SELECT t.id, t.club_id, t.name, t.sport_type, t.price_per_hour, t.slot_duration, t.created_at,
        GROUP_CONCAT(ti.image_url ORDER BY ti.display_order ASC, ti.created_at ASC) AS images
      FROM \`terrains\` t
      LEFT JOIN terrain_images ti ON t.id = ti.terrain_id
      WHERE t.club_id = ?
      GROUP BY t.id
    `;

    const terrains = await queryPromise(this.db, sql, [clubId]);

    // Pour chaque terrain, récupérer les recurring_availabilities
    return Promise.all(terrains.map(async (terrain) => {
      const availabilities = await queryPromise(this.db,
        'SELECT day_of_week, start_time, end_time, is_closed FROM recurring_availabilities WHERE terrain_id = ? ORDER BY day_of_week',
        [terrain.id]);

      return {
        ...terrain,
        images: terrain.images ? terrain.images.split(',') : [],
        recurring_availabilities: availabilities || [],
      };
    }));
  }

  /**
   * Récupère la liste simplifiée des partenaires (pour compatibilité)
   * @returns {Promise<Array>} Liste des partenaires
   */
  async getPartners() {
    const sql = "SELECT id, name, address, city, lat, lon FROM clubs WHERE status = 'confirme'";

    const partners = await queryPromise(this.db, sql);
    return partners.map(p => ({ ...p, lng: p.lon }));
  }

  /**
   * Crée un nouveau terrain
   * @param {Object} terrainData - Données du terrain
   * @returns {Promise<Object>} Terrain créé
   */
  async createTerrain(terrainData) {
    const { club_id, name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = terrainData;

    const sql = `
      INSERT INTO \`terrains\` (club_id, name, sport_type, price_per_hour, slot_duration)
      VALUES (?, ?, ?, ?, ?)
    `;

    const terrainId = await insert(this.db, sql, [club_id, name, sport_type, price_per_hour, slot_duration]);

    if (recurring_availabilities && Array.isArray(recurring_availabilities) && recurring_availabilities.length > 0) {
      try {
        const values = recurring_availabilities.map(avail => [
          terrainId,
          avail.day_of_week,
          avail.start_time,
          avail.end_time,
          avail.is_closed || false,
        ]);

        await queryPromise(this.db,
          'INSERT INTO recurring_availabilities (terrain_id, day_of_week, start_time, end_time, is_closed) VALUES ?',
          [values]);
      } catch (availErr) {
        logger.error(`createTerrain recurring_availabilities: ${availErr.message}`);
      }
    }

    return { id: terrainId, club_id, name, sport_type, price_per_hour, slot_duration };
  }

  /**
   * Met à jour un terrain
   * @param {number} terrainId - ID du terrain
   * @param {Object} terrainData - Données du terrain
   * @returns {Promise<void>}
   */
  async updateTerrain(terrainId, terrainData) {
    const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = terrainData;

    const sql = `
      UPDATE \`terrains\`
      SET name = ?, sport_type = ?, price_per_hour = ?, slot_duration = ?
      WHERE id = ?
    `;

    await queryPromise(this.db, sql, [name, sport_type, price_per_hour, slot_duration, terrainId]);

    if (recurring_availabilities && Array.isArray(recurring_availabilities)) {
      try {
        await queryPromise(this.db,
          'DELETE FROM recurring_availabilities WHERE terrain_id = ?', [terrainId]);

        if (recurring_availabilities.length > 0) {
          const values = recurring_availabilities.map(avail => [
            terrainId,
            avail.day_of_week,
            avail.start_time,
            avail.end_time,
            avail.is_closed || false,
          ]);

          await queryPromise(this.db,
            'INSERT INTO recurring_availabilities (terrain_id, day_of_week, start_time, end_time, is_closed) VALUES ?',
            [values]);
        }
      } catch (availErr) {
        logger.error(`updateTerrain recurring_availabilities: ${availErr.message}`);
      }
    }
  }

  /**
   * Supprime un terrain
   * @param {number} terrainId - ID du terrain
   * @returns {Promise<void>}
   */
  async deleteTerrain(terrainId) {
    await queryPromise(this.db, 'DELETE FROM `terrains` WHERE id = ?', [terrainId]);
  }

  /**
   * Récupère les images d'un terrain
   * @param {number} terrainId - ID du terrain
   * @returns {Promise<Array>} Liste des images
   */
  async getTerrainImages(terrainId) {
    const sql = `
      SELECT id, terrain_id, image_url, display_order, created_at 
      FROM terrain_images 
      WHERE terrain_id = ? 
      ORDER BY display_order ASC, created_at ASC
    `;
    
    const images = await queryPromise(this.db, sql, [terrainId]);
    return images || [];
  }

  /**
   * Ajoute une image à un terrain
   * @param {number} terrainId - ID du terrain
   * @param {string} imageUrl - URL de l'image
   * @param {number} displayOrder - Ordre d'affichage (optionnel)
   * @returns {Promise<Object>} Image ajoutée
   */
  async addTerrainImage(terrainId, imageUrl, displayOrder = 0) {
    const sql = 'INSERT INTO terrain_images (terrain_id, image_url, display_order) VALUES (?, ?, ?)';

    const id = await insert(this.db, sql, [terrainId, imageUrl, displayOrder]);
    return { id, terrain_id: terrainId, image_url: imageUrl, display_order: displayOrder };
  }

  /**
   * Supprime une image d'un terrain
   * @param {number} imageId - ID de l'image
   * @returns {Promise<void>}
   */
  async deleteTerrainImage(imageId) {
    await queryPromise(this.db, 'DELETE FROM terrain_images WHERE id = ?', [imageId]);
  }

  /**
   * Récupère toutes les informations détaillées d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Object>} Informations complètes du club
   */
  async getClubFullDetails(clubId) {
    // Récupérer les infos de base du club
    const clubSql = "SELECT * FROM clubs WHERE id = ? AND status = 'confirme'";
    
    const club = await queryOne(this.db, clubSql, [clubId]);
    if (!club) throw new NotFoundError('Club introuvable');

    const sports = await this.getClubSports(clubId);

    const imageRows = await queryPromise(this.db,
      'SELECT image_url FROM club_images WHERE club_id = ?', [clubId]);

    const openingHours = await queryPromise(this.db,
      'SELECT * FROM club_opening_hours WHERE club_id = ? ORDER BY day_of_week', [clubId]);

    // Réseaux sociaux : la table a connu deux structures. Sans colonne `type`
    // (ou sans table du tout), on renvoie une liste vide plutôt que d'échouer.
    let socials = [];
    try {
      const columns = await queryPromise(this.db, 'DESCRIBE club_socials');
      if (columns.some((col) => col.Field === 'type')) {
        socials = await queryPromise(this.db,
          'SELECT type, url FROM club_socials WHERE club_id = ?', [clubId]);
      }
    } catch {
      socials = [];
    }

    const paymentRows = await queryPromise(this.db,
      'SELECT method FROM club_payment_methods WHERE club_id = ?', [clubId]);

    return {
      ...club,
      sports: sports.map(s => s.sport_name),
      images: imageRows.map(r => r.image_url),
      openingHours,
      socials,
      paymentMethods: paymentRows.map(r => r.method),
    };
  }

  /**
   * Met à jour les informations de base d'un club
   * @param {number} clubId - ID du club
   * @param {Object} data - Données à mettre à jour
   * @returns {Promise<void>}
   */
  async updateClubInfo(clubId, data) {
    // Liste blanche, et seuls les champs fournis sont écrits : un champ absent
    // (undefined) faisait échouer toute la requête côté mysql2.
    const allowed = ['name', 'description', 'address', 'city', 'postal_code', 'phone', 'email', 'website'];
    const assignments = [];
    const params = [];
    for (const key of allowed) {
      if (data[key] !== undefined) {
        assignments.push(`${key} = ?`);
        params.push(data[key]);
      }
    }
    if (assignments.length === 0) return;

    await queryPromise(this.db, `UPDATE clubs SET ${assignments.join(', ')} WHERE id = ?`, [...params, clubId]);
  }

  /**
   * Ajoute ou met à jour les horaires d'un club
   * @param {number} clubId - ID du club
   * @param {Array} hours - Tableau d'horaires [{day_of_week, open_time, close_time, is_closed}]
   * @returns {Promise<void>}
   */
  async updateClubOpeningHours(clubId, hours) {
    // Supprimer les horaires existants
    await queryPromise(this.db, 'DELETE FROM club_opening_hours WHERE club_id = ?', [clubId]);
    if (hours.length === 0) return;

    const values = hours.map(h => [clubId, h.day_of_week, h.open_time, h.close_time, h.is_closed || false]);
    await queryPromise(this.db,
      'INSERT INTO club_opening_hours (club_id, day_of_week, open_time, close_time, is_closed) VALUES ?',
      [values]);
  }

  /**
   * Ajoute ou met à jour les réseaux sociaux d'un club
   * @param {number} clubId - ID du club
   * @param {Array} socials - Tableau de réseaux sociaux [{type, url}]
   * @returns {Promise<void>}
   */
  async updateClubSocials(clubId, socials) {
    // Supprimer les réseaux existants
    await queryPromise(this.db, 'DELETE FROM club_socials WHERE club_id = ?', [clubId]);
    if (socials.length === 0) return;

    const values = socials.map(s => [clubId, s.type, s.url]);
    await queryPromise(this.db, 'INSERT INTO club_socials (club_id, type, url) VALUES ?', [values]);
  }

  /**
   * Ajoute ou met à jour les moyens de paiement d'un club
   * @param {number} clubId - ID du club
   * @param {Array} methods - Tableau de moyens de paiement ['CB', 'Stripe', etc.]
   * @returns {Promise<void>}
   */
  async updateClubPaymentMethods(clubId, methods) {
    // Supprimer les méthodes existantes
    await queryPromise(this.db, 'DELETE FROM club_payment_methods WHERE club_id = ?', [clubId]);
    if (methods.length === 0) return;

    const values = methods.map(m => [clubId, m]);
    await queryPromise(this.db, 'INSERT INTO club_payment_methods (club_id, method) VALUES ?', [values]);
  }

  /**
   * Récupère les sports d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Array>} Liste des sports
   */
  async getClubSports(clubId) {
    return queryPromise(this.db, 'SELECT id, club_id, sport_name FROM club_sports WHERE club_id = ?', [clubId]);
  }

  /**
   * Ajoute un sport à un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<Object>} Sport créé
   */
  async addClubSport(clubId, sportName) {
    const id = await insert(this.db, 'INSERT INTO club_sports (club_id, sport_name) VALUES (?, ?)', [clubId, sportName]);
    return { id, club_id: clubId, sport_name: sportName };
  }

  /**
   * Supprime un sport d'un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<void>}
   */
  async removeClubSport(clubId, sportName) {
    // Vérifier d'abord si des terrains utilisent ce sport
    const row = await queryOne(this.db,
      'SELECT COUNT(*) as count FROM terrains WHERE club_id = ? AND sport_type = ?', [clubId, sportName]);
    const count = row.count;
    if (count > 0) {
      throw new ConflictError(`Impossible de supprimer ce sport car ${count} terrain(s) l'utilise(nt) encore`);
    }

    await queryPromise(this.db,
      'DELETE FROM club_sports WHERE club_id = ? AND sport_name = ?', [clubId, sportName]);
  }

  /**
   * Crée un nouveau club en attente de validation
   * @param {Object} clubData - Données du club
   * @param {string} clubData.name - Nom du club
   * @param {string} clubData.city - Ville
   * @param {string} clubData.phone - Téléphone
   * @param {string} clubData.email - Email
   * @param {string} clubData.address - Adresse (optionnel)
   * @param {string} clubData.postal_code - Code postal (optionnel)
   * @param {string} clubData.description - Description (optionnel)
   * @returns {Promise<Object>} Club créé
   */
  async createClub(clubData) {
    const { name, city, phone, email, address, postal_code, description } = clubData;
    
    const sql = `
      INSERT INTO clubs (name, city, phone, email, address, postal_code, description, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'attente')
    `;
    
    // Utiliser la description fournie ou un message par défaut
    const finalDescription = description || 'Demande d\'ajout de club en attente de validation';
    
    let id;
    try {
      id = await insert(this.db, sql, [name, city, phone, email, address || null, postal_code || null, finalDescription]);
    } catch (err) {
      logger.error(`createClub SQL: ${err.message}`);
      throw err;
    }

    logger.info(`Club créé id=${id}`);
    return {
      id,
      name,
      city,
      phone,
      email,
      address,
      postal_code,
      description: finalDescription,
      status: 'attente',
    };
  }
}

module.exports = ClubsController;
