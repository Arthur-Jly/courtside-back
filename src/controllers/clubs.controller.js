/**
 * Contrôleur pour la gestion des clubs et terrains
 */

const datagouvApi = require('../services/datagouvApi');

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

      return new Promise((resolve, reject) => {
        this.db.query(sql, params, (err, clubs) => {
          if (err) {
            reject(err);
          } else {
            // Transforme les chaînes en tableaux
            const clubsWithArrays = clubs.map(club => ({
              ...club,
              sports: club.sports ? club.sports.split(',') : [],
              images: club.images ? club.images.split(',') : [],
              lng: club.lon, // Alias pour compatibilité front
              min_price: club.min_price || null,
              max_price: club.max_price || null
            }));
            resolve(clubsWithArrays);
          }
        });
      });
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

    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, clubs) => {
        if (err) {
          reject(err);
        } else {
          const clubsWithArrays = clubs.map(club => ({
            ...club,
            sports: club.sports ? club.sports.split(',') : [],
            images: club.images ? club.images.split(',') : [],
            lng: club.lon,
            min_price: club.min_price || null,
            max_price: club.max_price || null
          }));
          resolve(clubsWithArrays);
        }
      });
    });
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
    
    console.log(`[ClubsController] Envoi immédiat de ${dbClubs.length} clubs BDD`);
    onData({ clubs: dbClubs, source: 'database', done: false });

    // 2. Si coordonnées GPS fournies et includeDatagouv=true, récupérer les équipements data.gouv
    if (includeDatagouv && lat && lon) {
      try {
        console.log('[ClubsController] Recherche équipements data.gouv.fr avec:', { lat, lon, sport, radius });
        
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
            console.log(`[ClubsController] Envoi lot ${Math.floor(i / batchSize) + 1} de ${datagouvClubs.length} équipements data.gouv`);
            
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
          console.log('[ClubsController] Aucun équipement data.gouv trouvé');
          onData({ clubs: [], source: 'data.gouv.fr', done: true });
        }
      } catch (error) {
        console.error('[ClubsController] Erreur data.gouv (non bloquante):', error.message);
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

    return new Promise((resolve, reject) => {
      this.db.query(sql, [id], (err, clubs) => {
        if (err) {
          reject(err);
        } else if (clubs.length === 0) {
          reject(new Error('Club introuvable'));
        } else {
          const club = {
            ...clubs[0],
            sports: clubs[0].sports ? clubs[0].sports.split(',') : [],
            images: clubs[0].images ? clubs[0].images.split(',') : [],
            lng: clubs[0].lon
          };
          resolve(club);
        }
      });
    });
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

    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId], async (err, terrains) => {
        if (err) return reject(err);
        
        // Pour chaque terrain, récupérer les recurring_availabilities
        const terrainsWithAvailabilities = await Promise.all(
          terrains.map(async (terrain) => {
            const availSql = 'SELECT day_of_week, start_time, end_time, is_closed FROM recurring_availabilities WHERE terrain_id = ? ORDER BY day_of_week';
            
            const availabilities = await new Promise((res, rej) => {
              this.db.query(availSql, [terrain.id], (err, rows) => {
                if (err) rej(err);
                else res(rows || []);
              });
            });
            
            return {
              ...terrain,
              images: terrain.images ? terrain.images.split(',') : [],
              recurring_availabilities: availabilities
            };
          })
        );
        
        resolve(terrainsWithAvailabilities);
      });
    });
  }

  /**
   * Récupère la liste simplifiée des partenaires (pour compatibilité)
   * @returns {Promise<Array>} Liste des partenaires
   */
  async getPartners() {
    const sql = "SELECT id, name, address, city, lat, lon FROM clubs WHERE status = 'confirme'";

    return new Promise((resolve, reject) => {
      this.db.query(sql, (err, partners) => {
        if (err) {
          reject(err);
        } else {
          const partnersWithLng = partners.map(p => ({ ...p, lng: p.lon }));
          resolve(partnersWithLng);
        }
      });
    });
  }

  /**
   * Récupère les sports d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Array>} Liste des sports
   */
  async getClubSports(clubId) {
    const sql = 'SELECT id, sport_name FROM club_sports WHERE club_id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId], (err, sports) => {
        if (err) reject(err);
        else resolve(sports || []);
      });
    });
  }

  /**
   * Ajoute un sport à un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<Object>} Sport ajouté
   */
  async addClubSport(clubId, sportName) {
    const sql = 'INSERT INTO club_sports (club_id, sport_name) VALUES (?, ?)';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId, sportName], (err, result) => {
        if (err) reject(err);
        else resolve({ id: result.insertId, club_id: clubId, sport_name: sportName });
      });
    });
  }

  /**
   * Supprime un sport d'un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<void>}
   */
  async removeClubSport(clubId, sportName) {
    const sql = 'DELETE FROM club_sports WHERE club_id = ? AND sport_name = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId, sportName], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Crée un nouveau terrain
   * @param {Object} terrainData - Données du terrain
   * @returns {Promise<Object>} Terrain créé
   */
  async createTerrain(terrainData) {
    const { club_id, name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = terrainData;
    
    console.log('[createTerrain] Received data:', { club_id, name, sport_type, price_per_hour, slot_duration, recurring_availabilities });
    
    const sql = `
      INSERT INTO \`terrains\` (club_id, name, sport_type, price_per_hour, slot_duration) 
      VALUES (?, ?, ?, ?, ?)
    `;
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [club_id, name, sport_type, price_per_hour, slot_duration], async (err, result) => {
        if (err) return reject(err);
        
        const terrainId = result.insertId;
        console.log('[createTerrain] Terrain created with ID:', terrainId);
        
        // Si des recurring_availabilities sont fournis, les créer
        if (recurring_availabilities && Array.isArray(recurring_availabilities) && recurring_availabilities.length > 0) {
          try {
            console.log('[createTerrain] Inserting recurring_availabilities:', recurring_availabilities);
            
            const insertAvailSql = 'INSERT INTO recurring_availabilities (terrain_id, day_of_week, start_time, end_time, is_closed) VALUES ?';
            const values = recurring_availabilities.map(avail => [
              terrainId,
              avail.day_of_week,
              avail.start_time,
              avail.end_time,
              avail.is_closed || false
            ]);
            
            await new Promise((res, rej) => {
              this.db.query(insertAvailSql, [values], (err, result) => {
                if (err) {
                  console.error('[createTerrain] Error inserting recurring_availabilities:', err);
                  rej(err);
                } else {
                  console.log('[createTerrain] Successfully inserted recurring_availabilities, affected rows:', result.affectedRows);
                  res();
                }
              });
            });
          } catch (availErr) {
            console.error('[createTerrain] Erreur lors de la création des recurring_availabilities:', availErr);
            // On continue même si erreur sur les availabilities
          }
        } else {
          console.log('[createTerrain] No recurring_availabilities to insert');
        }
        
        resolve({ 
          id: terrainId, 
          club_id, 
          name, 
          sport_type, 
          price_per_hour, 
          slot_duration 
        });
      });
    });
  }

  /**
   * Met à jour un terrain
   * @param {number} terrainId - ID du terrain
   * @param {Object} terrainData - Données du terrain
   * @returns {Promise<void>}
   */
  async updateTerrain(terrainId, terrainData) {
    const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = terrainData;
    
    console.log('[updateTerrain] Updating terrain ID:', terrainId, 'with data:', { name, sport_type, price_per_hour, slot_duration, recurring_availabilities });
    
    const sql = `
      UPDATE \`terrains\` 
      SET name = ?, sport_type = ?, price_per_hour = ?, slot_duration = ? 
      WHERE id = ?
    `;
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [name, sport_type, price_per_hour, slot_duration, terrainId], async (err) => {
        if (err) return reject(err);
        
        console.log('[updateTerrain] Terrain updated successfully');
        
        // Si des recurring_availabilities sont fournis, les mettre à jour
        if (recurring_availabilities && Array.isArray(recurring_availabilities)) {
          try {
            // Supprimer les anciens recurring_availabilities
            await new Promise((res, rej) => {
              this.db.query('DELETE FROM recurring_availabilities WHERE terrain_id = ?', [terrainId], (err, result) => {
                if (err) {
                  console.error('[updateTerrain] Error deleting old recurring_availabilities:', err);
                  rej(err);
                } else {
                  console.log('[updateTerrain] Deleted old recurring_availabilities, affected rows:', result.affectedRows);
                  res();
                }
              });
            });
            
            // Insérer les nouveaux (seulement si le tableau n'est pas vide)
            if (recurring_availabilities.length > 0) {
              console.log('[updateTerrain] Inserting new recurring_availabilities:', recurring_availabilities);
              
              const insertAvailSql = 'INSERT INTO recurring_availabilities (terrain_id, day_of_week, start_time, end_time, is_closed) VALUES ?';
              const values = recurring_availabilities.map(avail => [
                terrainId,
                avail.day_of_week,
                avail.start_time,
                avail.end_time,
                avail.is_closed || false
              ]);
              
              await new Promise((res, rej) => {
                this.db.query(insertAvailSql, [values], (err, result) => {
                  if (err) {
                    console.error('[updateTerrain] Error inserting new recurring_availabilities:', err);
                    rej(err);
                  } else {
                    console.log('[updateTerrain] Successfully inserted new recurring_availabilities, affected rows:', result.affectedRows);
                    res();
                  }
                });
              });
            } else {
              console.log('[updateTerrain] No recurring_availabilities to insert');
            }
          } catch (availErr) {
            console.error('[updateTerrain] Erreur lors de la mise à jour des recurring_availabilities:', availErr);
            // On continue même si erreur sur les availabilities
          }
        } else {
          console.log('[updateTerrain] No recurring_availabilities provided for update');
        }
        
        resolve();
      });
    });
  }

  /**
   * Supprime un terrain
   * @param {number} terrainId - ID du terrain
   * @returns {Promise<void>}
   */
  async deleteTerrain(terrainId) {
    const sql = 'DELETE FROM `terrains` WHERE id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [terrainId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [terrainId], (err, images) => {
        if (err) reject(err);
        else resolve(images || []);
      });
    });
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
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [terrainId, imageUrl, displayOrder], (err, result) => {
        if (err) reject(err);
        else resolve({ 
          id: result.insertId, 
          terrain_id: terrainId, 
          image_url: imageUrl,
          display_order: displayOrder 
        });
      });
    });
  }

  /**
   * Supprime une image d'un terrain
   * @param {number} imageId - ID de l'image
   * @returns {Promise<void>}
   */
  async deleteTerrainImage(imageId) {
    const sql = 'DELETE FROM terrain_images WHERE id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [imageId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Récupère toutes les informations détaillées d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Object>} Informations complètes du club
   */
  async getClubFullDetails(clubId) {
    // Récupérer les infos de base du club
    const clubSql = "SELECT * FROM clubs WHERE id = ? AND status = 'confirme'";
    
    return new Promise((resolve, reject) => {
      this.db.query(clubSql, [clubId], async (err, clubs) => {
        if (err) return reject(err);
        if (clubs.length === 0) return reject(new Error('Club introuvable'));
        
        const club = clubs[0];
        
        try {
          // Récupérer les sports
          const sports = await this.getClubSports(clubId);
          
          // Récupérer les images
          const imagesSql = 'SELECT image_url FROM club_images WHERE club_id = ?';
          const images = await new Promise((res, rej) => {
            this.db.query(imagesSql, [clubId], (err, results) => {
              if (err) rej(err);
              else res(results.map(r => r.image_url));
            });
          });
          
          // Récupérer les horaires
          const hoursSql = 'SELECT * FROM club_opening_hours WHERE club_id = ? ORDER BY day_of_week';
          const openingHours = await new Promise((res, rej) => {
            this.db.query(hoursSql, [clubId], (err, results) => {
              if (err) rej(err);
              else res(results);
            });
          });
          
          // Récupérer les réseaux sociaux
          // Note: Vérifier d'abord si la table club_socials existe avec la bonne structure
          const socials = await new Promise((res, rej) => {
            // Vérifier la structure de la table
            this.db.query('DESCRIBE club_socials', (err, columns) => {
              if (err) {
                // Table n'existe pas, retourner un tableau vide
                return res([]);
              }
              
              const hasTypeColumn = columns.some((col) => col.Field === 'type');
              
              if (hasTypeColumn) {
                // Nouvelle structure avec type
                this.db.query('SELECT type, url FROM club_socials WHERE club_id = ?', [clubId], (err, results) => {
                  if (err) rej(err);
                  else res(results);
                });
              } else {
                // Ancienne structure, retourner vide pour l'instant
                res([]);
              }
            });
          });
          
          // Récupérer les moyens de paiement
          const paymentsSql = 'SELECT method FROM club_payment_methods WHERE club_id = ?';
          const paymentMethods = await new Promise((res, rej) => {
            this.db.query(paymentsSql, [clubId], (err, results) => {
              if (err) rej(err);
              else res(results.map(r => r.method));
            });
          });
          
          resolve({
            ...club,
            sports: sports.map(s => s.sport_name),
            images,
            openingHours,
            socials,
            paymentMethods
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Met à jour les informations de base d'un club
   * @param {number} clubId - ID du club
   * @param {Object} data - Données à mettre à jour
   * @returns {Promise<void>}
   */
  async updateClubInfo(clubId, data) {
    const { name, description, address, city, postal_code, phone, email, website } = data;
    const sql = `
      UPDATE clubs 
      SET name = ?, description = ?, address = ?, city = ?, postal_code = ?, 
          phone = ?, email = ?, website = ?
      WHERE id = ?
    `;
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [name, description, address, city, postal_code, phone, email, website, clubId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Ajoute ou met à jour les horaires d'un club
   * @param {number} clubId - ID du club
   * @param {Array} hours - Tableau d'horaires [{day_of_week, open_time, close_time, is_closed}]
   * @returns {Promise<void>}
   */
  async updateClubOpeningHours(clubId, hours) {
    // Supprimer les horaires existants
    const deleteSql = 'DELETE FROM club_opening_hours WHERE club_id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(deleteSql, [clubId], (err) => {
        if (err) return reject(err);
        
        // Insérer les nouveaux horaires
        if (hours.length === 0) return resolve();
        
        const insertSql = 'INSERT INTO club_opening_hours (club_id, day_of_week, open_time, close_time, is_closed) VALUES ?';
        const values = hours.map(h => [clubId, h.day_of_week, h.open_time, h.close_time, h.is_closed || false]);
        
        this.db.query(insertSql, [values], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Ajoute ou met à jour les réseaux sociaux d'un club
   * @param {number} clubId - ID du club
   * @param {Array} socials - Tableau de réseaux sociaux [{type, url}]
   * @returns {Promise<void>}
   */
  async updateClubSocials(clubId, socials) {
    // Supprimer les réseaux existants
    const deleteSql = 'DELETE FROM club_socials WHERE club_id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(deleteSql, [clubId], (err) => {
        if (err) return reject(err);
        
        // Insérer les nouveaux réseaux
        if (socials.length === 0) return resolve();
        
        const insertSql = 'INSERT INTO club_socials (club_id, type, url) VALUES ?';
        const values = socials.map(s => [clubId, s.type, s.url]);
        
        this.db.query(insertSql, [values], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Ajoute ou met à jour les moyens de paiement d'un club
   * @param {number} clubId - ID du club
   * @param {Array} methods - Tableau de moyens de paiement ['CB', 'Stripe', etc.]
   * @returns {Promise<void>}
   */
  async updateClubPaymentMethods(clubId, methods) {
    // Supprimer les méthodes existantes
    const deleteSql = 'DELETE FROM club_payment_methods WHERE club_id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(deleteSql, [clubId], (err) => {
        if (err) return reject(err);
        
        // Insérer les nouvelles méthodes
        if (methods.length === 0) return resolve();
        
        const insertSql = 'INSERT INTO club_payment_methods (club_id, method) VALUES ?';
        const values = methods.map(m => [clubId, m]);
        
        this.db.query(insertSql, [values], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Récupère les sports d'un club
   * @param {number} clubId - ID du club
   * @returns {Promise<Array>} Liste des sports
   */
  async getClubSports(clubId) {
    const sql = 'SELECT id, club_id, sport_name FROM club_sports WHERE club_id = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId], (err, results) => {
        if (err) reject(err);
        else resolve(results);
      });
    });
  }

  /**
   * Ajoute un sport à un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<Object>} Sport créé
   */
  async addClubSport(clubId, sportName) {
    const sql = 'INSERT INTO club_sports (club_id, sport_name) VALUES (?, ?)';
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [clubId, sportName], (err, result) => {
        if (err) reject(err);
        else resolve({ id: result.insertId, club_id: clubId, sport_name: sportName });
      });
    });
  }

  /**
   * Supprime un sport d'un club
   * @param {number} clubId - ID du club
   * @param {string} sportName - Nom du sport
   * @returns {Promise<void>}
   */
  async removeClubSport(clubId, sportName) {
    // Vérifier d'abord si des terrains utilisent ce sport
    const checkSql = 'SELECT COUNT(*) as count FROM terrains WHERE club_id = ? AND sport_type = ?';
    
    return new Promise((resolve, reject) => {
      this.db.query(checkSql, [clubId, sportName], (err, results) => {
        if (err) return reject(err);
        
        const count = results[0].count;
        if (count > 0) {
          return reject(new Error(`Impossible de supprimer ce sport car ${count} terrain(s) l'utilise(nt) encore`));
        }
        
        // Si aucun terrain n'utilise ce sport, on peut le supprimer
        const deleteSql = 'DELETE FROM club_sports WHERE club_id = ? AND sport_name = ?';
        this.db.query(deleteSql, [clubId, sportName], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
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
    
    return new Promise((resolve, reject) => {
      this.db.query(sql, [name, city, phone, email, address || null, postal_code || null, finalDescription], (err, result) => {
        if (err) {
          console.error('❌ Erreur SQL createClub:', err);
          reject(err);
        } else {
          console.log('✅ Club créé avec ID:', result.insertId);
          resolve({
            id: result.insertId,
            name,
            city,
            phone,
            email,
            address,
            postal_code,
            description: finalDescription,
            status: 'attente'
          });
        }
      });
    });
  }
}

module.exports = ClubsController;
