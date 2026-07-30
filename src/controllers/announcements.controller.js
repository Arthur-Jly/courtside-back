/**
 * Contrôleur pour la gestion des annonces publiques et privées
 */
const { logger } = require('../utils/logger');
const { queryOne } = require('../utils/dbHelpers');
const { track } = require('../utils/track');

/**
 * Minimum de joueurs par défaut, en proportion des places.
 * Exiger 10/10 en foot ne confirmerait presque aucune partie ; 8 sur 10 suffit à
 * jouer. Le basket 3x3 tourne à 4 sur 6. À réajuster avec le réel.
 */
const MIN_RATIO = { foot: 0.8, basket: 0.7 };
const MIN_RATIO_DEFAULT = 0.5;

function defaultMinParticipants(sportType, placesTotal) {
  const ratio = MIN_RATIO[String(sportType || '').toLowerCase()] ?? MIN_RATIO_DEFAULT;
  const computed = Math.round(Number(placesTotal) * ratio);
  return Math.min(Math.max(computed, 2), Number(placesTotal));
}

class AnnouncementsController {
  constructor(db) {
    this.db = db;
  }

  /**
   * Récupère les annonces publiques avec filtres optionnels
   * @param {Object} filters - Filtres de recherche
   * @param {string} filters.sport_type - Type de sport à filtrer (optionnel)
   * @param {string} filters.status - Statut à filtrer (optionnel)
   * @param {number} filters.club_id - ID du club à filtrer (optionnel)
   * @param {number} filters.user_id - ID de l'utilisateur pour vérifier sa participation (optionnel)
   * @returns {Promise<Array>} Liste des annonces filtrées
   */
  async getPublicAnnouncements(filters = {}) {
    const { sport_type, status, club_id, user_id, city, date_from, date_to, public_place_ref } = filters;

    // Phase 1 : le lieu vient de `public_places`. On garde le club en repli pour
    // les annonces héritées (créneau club). `a.*` contient désormais `a.city` :
    // les colonnes de lieu sont donc aliasées explicitement, sinon la dernière
    // colonne homonyme écraserait la précédente côté driver.
    let sql = `
      SELECT a.*,
             u.name AS creator_name,
             t.name AS terrain_name,
             c.name AS club_name,
             c.id AS club_id,
             pp.id AS place_id,
             pp.name AS place_name,
             pp.equip_type AS place_type,
             pp.verification_status AS place_status,
             pp.lighting AS place_lighting,
             COALESCE(pp.address, a.manual_address, c.address) AS address,
             COALESCE(a.city, pp.city, a.manual_city, c.city) AS city,
             COALESCE(a.lat, pp.lat, c.lat) AS lat,
             COALESCE(a.lng, pp.lng, c.lon) AS lng
    `;

    const params = [];
    
    // Si user_id est fourni, vérifier si l'utilisateur participe
    if (user_id) {
      sql += `,
             (SELECT COUNT(*) FROM annonce_participants ap 
              WHERE ap.annonce_id = a.id AND ap.user_id = ?) AS user_has_joined
      `;
      params.push(parseInt(user_id));
    }
    
    sql += `
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN terrains t ON a.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      LEFT JOIN public_places pp ON a.public_place_ref = pp.id
      WHERE (
        a.visibility = 'public'
        ${user_id ? `
          OR (a.visibility = 'private' AND (
            a.created_by = ?
            OR EXISTS (
              SELECT 1 FROM annonce_invitations ai 
              WHERE ai.annonce_id = a.id 
              AND ai.user_id = ?
            )
          ))
        ` : ''}
      )
    `;
    
    // Si user_id est fourni, l'ajouter pour les annonces privées
    if (user_id) {
      params.push(parseInt(user_id));
      params.push(parseInt(user_id));
    }

    // Filtrage par club
    if (club_id) {
      logger.debug('✅ Filtrage par club_id:', club_id);
      sql += ' AND c.id = ?';
      params.push(parseInt(club_id));
    } else {
      logger.debug('⚠️ Aucun club_id fourni - affichage de toutes les annonces');
    }

    // Filtrage par sport
    if (sport_type && sport_type !== 'all') {
      sql += ' AND LOWER(a.sport_type) = ?';
      params.push(sport_type.toLowerCase());
    }

    // Filtrage par ville : c'est la granularité de la densité (ville × sport),
    // donc de toutes les métriques du go/no-go. `a.city` fait foi, `pp.city` sert
    // aux annonces créées avant la dénormalisation.
    if (city) {
      sql += ' AND (LOWER(a.city) = LOWER(?) OR LOWER(pp.city) = LOWER(?))';
      params.push(String(city).trim(), String(city).trim());
    }

    // Filtrage par lieu public
    if (public_place_ref) {
      sql += ' AND a.public_place_ref = ?';
      params.push(parseInt(public_place_ref, 10));
    }

    // Fenêtre de dates (sur le créneau, pas sur la création)
    if (date_from) {
      sql += ' AND a.slot_start >= ?';
      params.push(String(date_from).slice(0, 19).replace('T', ' '));
    }
    if (date_to) {
      sql += ' AND a.slot_start <= ?';
      params.push(String(date_to).slice(0, 19).replace('T', ' '));
    }

    // Un lieu signalé comme inexistant ne doit plus porter de partie visible.
    sql += " AND (pp.id IS NULL OR pp.verification_status <> 'reported_invalid')";

    // Filtrage par statut (par défaut, uniquement les annonces actives)
    if (status) {
      sql += ' AND a.status = ?';
      params.push(status);
    } else {
      sql += ' AND a.status = ?';
      params.push('active');
    }

    // Une session dont le créneau est déjà passé n'a plus sa place dans les annonces publiques
    sql += ' AND a.slot_start >= NOW()';

    // Chronologique : une liste de parties à venir se lit par créneau, pas par
    // date de publication.
    sql += ' ORDER BY a.slot_start ASC, a.created_at DESC';

    logger.debug('📝 SQL final:', sql);
    logger.debug('📝 Paramètres:', params);

    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, announcements) => {
        if (err) {
          logger.error('❌ Erreur SQL:', err);
          reject(err);
        } else {
          logger.debug(`✅ ${announcements.length} annonces trouvées`);
          
          // Convertir les dates en strings SANS changer de timezone
          const formattedAnnouncements = announcements.map(announcement => {
            const formatDateTime = (date) => {
              if (!date) return null;
              const d = new Date(date);
              const year = d.getFullYear();
              const month = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const hours = String(d.getHours()).padStart(2, '0');
              const minutes = String(d.getMinutes()).padStart(2, '0');
              const seconds = String(d.getSeconds()).padStart(2, '0');
              return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            };
            
            return {
              ...announcement,
              slot_start: formatDateTime(announcement.slot_start),
              slot_end: formatDateTime(announcement.slot_end),
              created_at: formatDateTime(announcement.created_at)
            };
          });
          
          logger.debug(`${formattedAnnouncements.length} annonces retournées`);
          resolve(formattedAnnouncements);
        }
      });
    });
  }

  /**
   * Récupère une annonce par son ID
   * @param {number} id - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur qui fait la requête (pour vérifier les permissions)
   * @returns {Promise<Object>} Annonce trouvée avec ses participants
   */
  async getAnnouncementById(id, userId = null) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT a.*,
               u.name AS creator_name,
               t.name AS terrain_name,
               t.sport_type AS terrain_sport,
               c.name AS club_name,
               pp.id AS place_id,
               pp.name AS place_name,
               pp.equip_type AS place_type,
               pp.verification_status AS place_status,
               pp.lighting AS place_lighting,
               pp.postal_code AS place_postal_code,
               COALESCE(pp.address, a.manual_address, c.address) AS address,
               COALESCE(a.city, pp.city, a.manual_city, c.city) AS city,
               COALESCE(a.lat, pp.lat, c.lat) AS lat,
               COALESCE(a.lng, pp.lng, c.lon) AS lng
        FROM announcements a
        LEFT JOIN users u ON a.created_by = u.id
        LEFT JOIN terrains t ON a.terrain_id = t.id
        LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
        LEFT JOIN public_places pp ON a.public_place_ref = pp.id
        WHERE a.id = ?
      `;

      this.db.query(sql, [id], async (err, announcements) => {
        if (err) {
          reject(err);
        } else if (announcements.length === 0) {
          reject(new Error('Annonce introuvable'));
        } else {
          const announcement = announcements[0];

          // Vérifier si l'utilisateur a le droit de voir cette annonce privée
          if (announcement.visibility === 'private' && userId) {
            const hasAccess = await this.checkUserAccessToPrivateAnnouncement(id, userId);
            if (!hasAccess) {
              reject(new Error('Accès refusé à cette annonce privée'));
              return;
            }
          } else if (announcement.visibility === 'private' && !userId) {
            reject(new Error('Accès refusé à cette annonce privée'));
            return;
          }

          // Récupérer les participants
          const participants = await this.getAnnouncementParticipants(id);
          announcement.participants = participants;

          // Formater les dates comme dans getPublicAnnouncements
          const formatDateTime = (date) => {
            if (!date) return null;
            const d = new Date(date);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const hours = String(d.getHours()).padStart(2, '0');
            const minutes = String(d.getMinutes()).padStart(2, '0');
            const seconds = String(d.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
          };

          announcement.slot_start = formatDateTime(announcement.slot_start);
          announcement.slot_end = formatDateTime(announcement.slot_end);
          announcement.created_at = formatDateTime(announcement.created_at);

          // Vérifier si l'utilisateur a rejoint cette annonce
          if (userId) {
            const hasJoined = participants.some(p => p.user_id === userId);
            announcement.user_has_joined = hasJoined ? 1 : 0;
          }

          resolve(announcement);
        }
      });
    });
  }

  /**
   * Vérifie si un utilisateur a accès à une annonce privée
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<boolean>}
   */
  async checkUserAccessToPrivateAnnouncement(announcementId, userId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT a.created_by,
               (SELECT COUNT(*) FROM annonce_invitations WHERE annonce_id = ? AND user_id = ?) AS is_invited,
               (SELECT COUNT(*) FROM annonce_participants WHERE annonce_id = ? AND user_id = ?) AS is_participant
        FROM announcements a
        WHERE a.id = ?
      `;

      this.db.query(sql, [announcementId, userId, announcementId, userId, announcementId], (err, results) => {
        if (err) {
          reject(err);
        } else if (results.length === 0) {
          resolve(false);
        } else {
          const result = results[0];
          const hasAccess = result.created_by === userId || result.is_invited > 0 || result.is_participant > 0;
          resolve(hasAccess);
        }
      });
    });
  }

  /**
   * Récupère les participants d'une annonce
   * @param {number} announcementId - ID de l'annonce
   * @returns {Promise<Array>}
   */
  async getAnnouncementParticipants(announcementId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT ap.*, u.name AS user_name, u.email AS user_email
        FROM annonce_participants ap
        LEFT JOIN users u ON ap.user_id = u.id
        WHERE ap.annonce_id = ?
        ORDER BY ap.joined_at ASC
      `;

      this.db.query(sql, [announcementId], (err, participants) => {
        if (err) {
          reject(err);
        } else {
          resolve(participants);
        }
      });
    });
  }

  /**
   * Crée une nouvelle annonce
   * @param {Object} announcementData - Données de l'annonce
   * @returns {Promise<Object>} Annonce créée
   */
  async createAnnouncement(announcementData) {
    const {
      sport_type,
      slot_id,
      places_total,
      description,
      created_by,
      visibility = 'public',
      invited_users = [],
      public_place_id,
      public_place_ref,
      min_participants,
      manual_date,
      manual_start_time,
      manual_end_time,
      title,
      manual_address,
      manual_city,
      lat,
      lng,
    } = announcementData;

    logger.debug('🔍 createAnnouncement - Données reçues:', announcementData);

    // Validation de base
    if (!sport_type || !places_total || !created_by) {
      throw new Error('Champs requis manquants (sport_type, places_total, created_by)');
    }

    // Valider la longueur de la description
    if (description && description.length > 200) {
      throw new Error('La description ne peut pas dépasser 200 caractères');
    }

    // Déterminer si c'est une annonce pour lieu public ou club privé
    const isPublicPlace = !slot_id;

    if (isPublicPlace) {
      // LIEU PUBLIC : Validation des données manuelles
      if (!manual_date || !manual_start_time || !manual_end_time) {
        throw new Error('Date et horaires requis pour les lieux publics');
      }
      // Un lieu est obligatoire : soit une référence du référentiel, soit une
      // adresse saisie. Sans lieu, la partie est injoignable.
      if (!public_place_ref && !manual_address && !public_place_id) {
        throw new Error('Champs requis manquants (public_place_ref ou manual_address)');
      }

      return this._createPublicPlaceAnnouncement({
        sport_type,
        places_total,
        description,
        created_by,
        visibility,
        invited_users,
        public_place_id,
        public_place_ref,
        min_participants,
        manual_date,
        manual_start_time,
        manual_end_time,
        title,
        manual_address,
        manual_city,
        lat,
        lng,
      });
    } else {
      // CLUB PRIVÉ : Validation du slot
      if (!slot_id) {
        throw new Error('slot_id requis pour les clubs privés');
      }
      
      return this._createPrivateClubAnnouncement({
        sport_type,
        slot_id,
        places_total,
        description,
        created_by,
        visibility,
        invited_users,
      });
    }
  }

  /**
   * Crée une annonce pour un lieu public (sans slot_id)
   * @private
   */
  async _createPublicPlaceAnnouncement(data) {
    const {
      sport_type,
      places_total,
      description,
      created_by,
      visibility,
      invited_users,
      public_place_id,
      public_place_ref,
      min_participants,
      manual_date,
      manual_start_time,
      manual_end_time,
      title,
      manual_address,
      manual_city,
      lat,
      lng,
    } = data;

    logger.debug('🏞️ Création annonce LIEU PUBLIC');

    // Le lieu du référentiel fait autorité : ville, adresse et coordonnées en
    // sont recopiées. La ville saisie librement n'est jamais retenue quand un
    // lieu structuré existe — toutes les métriques dépendent de ce champ.
    let placeRef = null;
    let place = null;
    if (public_place_ref) {
      place = await queryOne(this.db,
        `SELECT id, name, address, city, lat, lng, verification_status
         FROM public_places WHERE id = ?`, [public_place_ref]);
      if (!place) throw new Error('Terrain introuvable');
      if (place.verification_status === 'reported_invalid') {
        throw new Error('Ce terrain a été signalé comme inexistant');
      }
      placeRef = place.id;
    }

    const finalAddress = place?.address ?? manual_address ?? null;
    const finalCity = place?.city ?? manual_city ?? null;
    const finalLat = place?.lat != null ? Number(place.lat) : (lat != null ? Number(lat) : null);
    const finalLng = place?.lng != null ? Number(place.lng) : (lng != null ? Number(lng) : null);
    const minParticipants = Number.isFinite(Number(min_participants)) && Number(min_participants) >= 2
      ? Math.min(Number(min_participants), Number(places_total))
      : defaultMinParticipants(sport_type, places_total);

    // Formater les dates/heures
    const slotStart = `${manual_date} ${manual_start_time}:00`;
    const slotEnd = `${manual_date} ${manual_end_time}:00`;

    // Calculer la date d'expiration
    // Priorité : 24h avant le slot > NOW + 3h > slot_start (si match très proche)
    const slotStartDate = new Date(`${manual_date}T${manual_start_time}:00`);
    const idealExpiration = new Date(slotStartDate.getTime() - 24 * 60 * 60 * 1000); // 24h avant
    const minExpiration = new Date(Date.now() + 3 * 60 * 60 * 1000); // NOW + 3h minimum
    
    let expirationDate;
    if (idealExpiration > minExpiration) {
      // Cas normal : expiration 24h avant le match
      expirationDate = idealExpiration;
    } else if (slotStartDate > minExpiration) {
      // Match dans moins de 24h mais plus de 3h : expiration NOW + 3h
      expirationDate = minExpiration;
    } else {
      // Match très proche (< 3h) : expiration = slot_start
      expirationDate = slotStartDate;
    }
    const expirationStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');

    logger.debug('📅 Dates formatées:', { slotStart, slotEnd, expirationDate: expirationStr });

    return new Promise((resolve, reject) => {
      // Créer l'annonce sans slot_id ni terrain_id
      const sql = `
        INSERT INTO announcements
        (sport_type, slot_id, terrain_id, slot_start, slot_end, places_total, places_disponibles, description, created_by, visibility, status, public_place_id, public_place_ref, city, expiration_date, auto_cancel, min_participants, manual_address, manual_city, lat, lng, created_at)
        VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, TRUE, ?, ?, ?, ?, ?, NOW())
      `;

      const values = [
        sport_type,
        slotStart,
        slotEnd,
        places_total,
        places_total,
        description || null,
        created_by,
        visibility,
        public_place_id || null,
        placeRef,
        finalCity,
        expirationStr,
        minParticipants,
        finalAddress,
        finalCity,
        finalLat,
        finalLng,
      ];

      logger.debug('📝 Insertion annonce lieu public:', values);

      this.db.query(sql, values, async (err, result) => {
        if (err) {
          logger.error('❌ Erreur insertion annonce lieu public:', err);
          reject(err);
          return;
        }

        const announcementId = result.insertId;
        logger.debug('✅ Annonce lieu public créée avec l\'ID:', announcementId);

        try {
          // Ajouter le créateur comme participant
          await this.addParticipant(announcementId, created_by, 'creator');
          logger.debug('✅ Créateur ajouté comme participant');

          // Si annonce privée avec invités
          if (visibility === 'private' && invited_users && invited_users.length > 0) {
            logger.debug(`📨 Envoi des invitations à ${invited_users.length} amis`);
            await this.inviteFriendsWithMessages(announcementId, created_by, invited_users);
            logger.debug('✅ Invitations envoyées');
          }

          // Récupérer l'annonce créée
          const announcement = await this.getAnnouncementById(announcementId, created_by);
          logger.debug('✅ Annonce lieu public complète récupérée');
          resolve(announcement);
        } catch (err2) {
          logger.error('❌ Erreur post-création:', err2);
          reject(err2);
        }
      });
    });
  }

  /**
   * Crée une annonce pour un club privé (avec slot_id)
   * @private
   */
  async _createPrivateClubAnnouncement(data) {
    const {
      sport_type,
      slot_id,
      places_total,
      description,
      created_by,
      visibility,
      invited_users,
    } = data;

    logger.debug('🏢 Création annonce CLUB PRIVÉ');

    return new Promise((resolve, reject) => {
      // Vérifier que le slot existe et est disponible
      this.db.query(
        'SELECT * FROM slots WHERE id = ? AND status = ?',
        [slot_id, 'free'],
        async (err, slots) => {
          if (err) {
            logger.error('❌ Erreur lors de la vérification du slot:', err);
            reject(err);
            return;
          }

          logger.debug(`📊 Slots trouvés pour id=${slot_id}:`, slots.length);

          if (slots.length === 0) {
            logger.warn(`⚠️ Slot ${slot_id} non trouvé ou pas disponible`);
            reject(new Error('Ce créneau n\'est plus disponible'));
            return;
          }

          const slot = slots[0];
          logger.debug('✅ Slot trouvé:', slot);

          const formatLocalDate = (dateValue) => {
            if (!dateValue) return null;
            const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          };

          // Formater les dates correctement pour MySQL sans décalage de fuseau
          const slotDate = formatLocalDate(slot.date);
          
          const slotStart = `${slotDate} ${slot.start_time}`;
          const slotEnd = `${slotDate} ${slot.end_time}`;

          logger.debug('📅 Dates formatées:', { slotDate, slotStart, slotEnd });

          // Calculer la date d'expiration
          // Priorité : 24h avant le slot > NOW + 3h > slot_start (si match très proche)
          const slotStartDate = new Date(`${slotDate}T${slot.start_time}`);
          const idealExpiration = new Date(slotStartDate.getTime() - 24 * 60 * 60 * 1000); // 24h avant
          const minExpiration = new Date(Date.now() + 3 * 60 * 60 * 1000); // NOW + 3h minimum
          
          let expirationDate;
          if (idealExpiration > minExpiration) {
            // Cas normal : expiration 24h avant le match
            expirationDate = idealExpiration;
          } else if (slotStartDate > minExpiration) {
            // Match dans moins de 24h mais plus de 3h : expiration NOW + 3h
            expirationDate = minExpiration;
          } else {
            // Match très proche (< 3h) : expiration = slot_start
            expirationDate = slotStartDate;
          }
          const expirationStr = expirationDate.toISOString().slice(0, 19).replace('T', ' ');
          logger.debug(`Date d'expiration: ${expirationStr}`);

          // Créer l'annonce
          const sql = `
            INSERT INTO announcements 
            (sport_type, slot_id, terrain_id, slot_start, slot_end, places_total, places_disponibles, description, created_by, visibility, status, expiration_date, auto_cancel, min_participants, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, TRUE, 2, NOW())
          `;

          const values = [
            sport_type,
            slot_id,
            slot.terrain_id,
            slotStart,
            slotEnd,
            places_total,
            places_total,
            description || null,
            created_by,
            visibility,
            expirationStr
          ];

          logger.debug('📝 Insertion de l\'annonce avec les valeurs:', values);

          this.db.query(sql, values, async (err2, result) => {
            if (err2) {
              logger.error('❌ Erreur lors de l\'insertion de l\'annonce:', err2);
              reject(err2);
              return;
            }

            const announcementId = result.insertId;
            logger.debug('✅ Annonce créée avec l\'ID:', announcementId);

            // Marquer le slot comme réservé pour annonce
            this.db.query(
              'UPDATE slots SET status = ? WHERE id = ?',
              ['reserved_announcement', slot_id],
              async (err3) => {
                if (err3) {
                  logger.error('❌ Erreur lors de la mise à jour du slot:', err3);
                  reject(err3);
                  return;
                }

                logger.debug('✅ Slot mis à jour en reserved_announcement');

                try {
                  // Ajouter le créateur comme participant
                  await this.addParticipant(announcementId, created_by, 'creator');
                  logger.debug('✅ Créateur ajouté comme participant');

                  // Si annonce privée avec invités, créer les invitations et envoyer les messages
                  if (visibility === 'private' && invited_users && invited_users.length > 0) {
                    logger.debug(`📨 Envoi des invitations à ${invited_users.length} amis`);
                    await this.inviteFriendsWithMessages(announcementId, created_by, invited_users);
                    logger.debug('✅ Invitations envoyées avec succès');
                  }

                  // Récupérer l'annonce créée
                  const announcement = await this.getAnnouncementById(announcementId, created_by);
                  logger.debug('✅ Annonce complète récupérée');
                  resolve(announcement);
                } catch (err4) {
                  logger.error('❌ Erreur lors de l\'ajout du participant ou récupération:', err4);
                  reject(err4);
                }
              }
            );
          });
        }
      );
    });
  }

  /**
   * Ajoute un participant à une annonce
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur
   * @param {string} role - Rôle du participant (creator, participant)
   * @returns {Promise<Object>}
   */
  async addParticipant(announcementId, userId, role = 'participant') {
    return new Promise((resolve, reject) => {
      // Vérifier si l'utilisateur n'est pas déjà participant
      this.db.query(
        'SELECT id FROM annonce_participants WHERE annonce_id = ? AND user_id = ?',
        [announcementId, userId],
        (err, existing) => {
          if (err) {
            reject(err);
            return;
          }

          if (existing.length > 0) {
            reject(new Error('Vous participez déjà à cette annonce'));
            return;
          }

          // Vérifier s'il reste des places
          this.db.query(
            'SELECT places_disponibles FROM announcements WHERE id = ?',
            [announcementId],
            (err2, announcements) => {
              if (err2) {
                reject(err2);
                return;
              }

              if (announcements.length === 0) {
                reject(new Error('Annonce introuvable'));
                return;
              }

              if (role !== 'creator' && announcements[0].places_disponibles <= 0) {
                reject(new Error('Plus de places disponibles'));
                return;
              }

              // Ajouter le participant
              const insertSql = 'INSERT INTO annonce_participants (annonce_id, user_id, role, joined_at) VALUES (?, ?, ?, NOW())';
              this.db.query(insertSql, [announcementId, userId, role], (err3, result) => {
                if (err3) {
                  reject(err3);
                  return;
                }

                // Mettre à jour les places disponibles
                this.db.query(
                  'UPDATE announcements SET places_disponibles = places_disponibles - 1 WHERE id = ?',
                  [announcementId],
                  (err4) => {
                    if (err4) {
                      reject(err4);
                    } else {
                      resolve({ id: result.insertId, announcementId, userId, role });
                    }
                  }
                );
              });
            }
          );
        }
      );
    });
  }

  /**
   * Retire un participant d'une annonce
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async removeParticipant(announcementId, userId) {
    return new Promise((resolve, reject) => {
      // Vérifier que l'utilisateur est participant (et pas créateur)
      this.db.query(
        'SELECT id, role FROM annonce_participants WHERE annonce_id = ? AND user_id = ?',
        [announcementId, userId],
        (err, participants) => {
          if (err) {
            reject(err);
            return;
          }

          if (participants.length === 0) {
            reject(new Error('Vous ne participez pas à cette annonce'));
            return;
          }

          if (participants[0].role === 'creator') {
            reject(new Error('Le créateur ne peut pas quitter son annonce'));
            return;
          }

          // Supprimer le participant
          this.db.query(
            'DELETE FROM annonce_participants WHERE annonce_id = ? AND user_id = ?',
            [announcementId, userId],
            (err2) => {
              if (err2) {
                reject(err2);
                return;
              }

              // Mettre à jour les places disponibles
              this.db.query(
                'UPDATE announcements SET places_disponibles = places_disponibles + 1 WHERE id = ?',
                [announcementId],
                (err3) => {
                  if (err3) {
                    reject(err3);
                  } else {
                    resolve({ success: true });
                  }
                }
              );
            }
          );
        }
      );
    });
  }

  /**
   * Met à jour une annonce
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur qui fait la modification
   * @param {Object} updateData - Données à mettre à jour
   * @returns {Promise<Object>}
   */
  async updateAnnouncement(announcementId, userId, updateData) {
    return new Promise((resolve, reject) => {
      // Vérifier que l'utilisateur est le créateur
      this.db.query(
        'SELECT created_by FROM announcements WHERE id = ?',
        [announcementId],
        (err, announcements) => {
          if (err) {
            reject(err);
            return;
          }

          if (announcements.length === 0) {
            reject(new Error('Annonce introuvable'));
            return;
          }

          if (announcements[0].created_by !== userId) {
            reject(new Error('Seul le créateur peut modifier cette annonce'));
            return;
          }

          // Construire la requête de mise à jour
          const allowedFields = ['description', 'status', 'slot_start', 'slot_end', 'expiration_date'];
          const updates = [];
          const params = [];

          Object.keys(updateData).forEach((key) => {
            if (allowedFields.includes(key)) {
              updates.push(`${key} = ?`);
              params.push(updateData[key]);
            }
          });

          if (updates.length === 0) {
            reject(new Error('Aucune donnée à mettre à jour'));
            return;
          }

          params.push(announcementId);
          const sql = `UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`;

          this.db.query(sql, params, async (err2) => {
            if (err2) {
              reject(err2);
            } else {
              const updatedAnnouncement = await this.getAnnouncementById(announcementId, userId);
              resolve(updatedAnnouncement);
            }
          });
        }
      );
    });
  }

  /**
   * Annule une annonce
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async cancelAnnouncement(announcementId, userId) {
    const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');
    const db = this.db;

    const announcements = await queryPromise(db,
      'SELECT * FROM announcements WHERE id = ?', [announcementId]);
    if (announcements.length === 0) throw new Error('Annonce introuvable');

    const announcement = announcements[0];
    if (announcement.created_by !== userId) throw new Error('Seul le créateur peut annuler une annonce');

    // 1. Récupérer les participants AVANT suppression (hors créateur)
    const participants = await queryPromise(db,
      'SELECT user_id FROM annonce_participants WHERE annonce_id = ? AND user_id != ?',
      [announcementId, userId]);

    // 2. Notifier chaque participant via messagerie privée
    const title = announcement.title || announcement.sport_type || 'Session';
    const dateStr = announcement.slot_start
      ? new Date(announcement.slot_start).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : announcement.manual_date || '';
    const msg = `⚠️ La session « ${title} » du ${dateStr} a été annulée par l'organisateur.`;

    for (const p of participants) {
      try {
        let chat = await queryOne(db, `
          SELECT c.id FROM chats c
          WHERE c.type = 'private'
            AND c.id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
            AND c.id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
          LIMIT 1
        `, [userId, p.user_id]);

        if (!chat) {
          const chatId = await insert(db,
            "INSERT INTO chats (type, created_at) VALUES ('private', NOW())");
          await queryPromise(db, `
            INSERT INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at)
            VALUES (?, ?, 'member', NOW(), NOW()), (?, ?, 'member', NOW(), NOW())
          `, [chatId, userId, chatId, p.user_id]);
          chat = { id: chatId };
        }

        await insert(db,
          'INSERT INTO messages (chat_id, sender_id, content, created_at) VALUES (?, ?, ?, NOW())',
          [chat.id, userId, msg]);
      } catch (e) {
        logger.error('Erreur notification annulation participant', { userId: p.user_id, err: e.message });
      }
    }

    // 3. Mettre le status à 'cancelled'
    await queryPromise(db,
      'UPDATE announcements SET status = ? WHERE id = ?', ['cancelled', announcementId]);

    // 4. Libérer le slot
    if (announcement.slot_id) {
      await queryPromise(db,
        'UPDATE slots SET status = ? WHERE id = ?', ['free', announcement.slot_id])
        .catch(e => logger.error('Erreur libération slot', { err: e.message }));
    }

    // 5. Supprimer les participants
    await queryPromise(db,
      'DELETE FROM annonce_participants WHERE annonce_id = ?', [announcementId])
      .catch(e => logger.error('Erreur suppression participants', { err: e.message }));

    return this.getAnnouncementById(announcementId, userId);
  }

  /**
   * Récupère les annonces d'un utilisateur (créées par lui)
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Array>}
   */
  async getUserAnnouncements(userId) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT a.*, 
               t.name AS terrain_name,
               c.name AS club_name,
               c.address, c.city
        FROM announcements a
        LEFT JOIN terrains t ON a.terrain_id = t.id
        LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
        WHERE a.created_by = ?
        ORDER BY a.created_at DESC
      `;

      this.db.query(sql, [userId], (err, announcements) => {
        if (err) {
          reject(err);
        } else {
          resolve(announcements);
        }
      });
    });
  }

  /**
   * Valide une annonce et crée la réservation payante
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur (doit être le créateur)
   * @returns {Promise<Object>} Réservation créée
   */
  async validateAnnouncement(announcementId, userId) {
    return new Promise((resolve, reject) => {
      // Vérifier que l'utilisateur est le créateur
      this.db.query(
        'SELECT * FROM announcements WHERE id = ? AND created_by = ?',
        [announcementId, userId],
        async (err, announcements) => {
          if (err) {
            reject(err);
            return;
          }

          if (announcements.length === 0) {
            reject(new Error('Annonce introuvable ou vous n\'êtes pas le créateur'));
            return;
          }

          const announcement = announcements[0];

          if (announcement.status === 'validated') {
            reject(new Error('Cette annonce a déjà été validée'));
            return;
          }

          if (!announcement.slot_id) {
            reject(new Error('Cette annonce n\'est pas liée à un créneau'));
            return;
          }

          // Récupérer les informations du slot
          this.db.query(
            'SELECT s.*, t.price_per_hour FROM slots s JOIN terrains t ON s.terrain_id = t.id WHERE s.id = ?',
            [announcement.slot_id],
            async (err2, slots) => {
              if (err2) {
                reject(err2);
                return;
              }

              if (slots.length === 0) {
                reject(new Error('Créneau introuvable'));
                return;
              }

              const slot = slots[0];
              
              // Calculer le prix total
              const startTime = new Date(`${slot.date} ${slot.start_time}`);
              const endTime = new Date(`${slot.date} ${slot.end_time}`);
              const durationHours = (endTime - startTime) / (1000 * 60 * 60);
              const totalPrice = durationHours * slot.price_per_hour;

              // Créer la réservation
              this.db.query(
                `INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status, created_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', NOW())`,
                [userId, slot.terrain_id, `${slot.date} ${slot.start_time}`, `${slot.date} ${slot.end_time}`, totalPrice],
                (err3, result) => {
                  if (err3) {
                    reject(err3);
                    return;
                  }

                  const reservationId = result.insertId;

                  // Mettre à jour le slot
                  this.db.query(
                    'UPDATE slots SET status = ?, reservation_id = ? WHERE id = ?',
                    ['booked', reservationId, announcement.slot_id],
                    (err4) => {
                      if (err4) {
                        reject(err4);
                        return;
                      }

                      // Mettre à jour l'annonce
                      this.db.query(
                        'UPDATE announcements SET status = ?, reservation_id = ? WHERE id = ?',
                        ['validated', reservationId, announcementId],
                        (err5) => {
                          if (err5) {
                            reject(err5);
                          } else {
                            resolve({
                              success: true,
                              reservation_id: reservationId,
                              total_price: totalPrice,
                              price_per_person: totalPrice / announcement.places_total
                            });
                          }
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    });
  }

  /**
   * Récupère les créneaux disponibles pour un sport donné
   * @param {string} sportType - Type de sport
   * @param {string} startDate - Date de début (YYYY-MM-DD)
   * @param {number} days - Nombre de jours à afficher
   * @param {number} clubId - ID du club à filtrer (optionnel)
   * @returns {Promise<Array>} Liste des créneaux disponibles
   */
  async getAvailableSlots(sportType, startDate = null, days = 7, clubId = null) {
    return new Promise((resolve, reject) => {
      const start = startDate || new Date().toISOString().split('T')[0];
      
      logger.debug('🔍 getAvailableSlots - Paramètres:', { sportType, startDate: start, days, clubId });
      
      let sql = `
        SELECT s.*, 
               t.name AS terrain_name,
               t.sport_type,
               t.price_per_hour,
               c.name AS club_name,
               c.id AS club_id,
               c.address,
               c.city
        FROM slots s
        JOIN terrains t ON s.terrain_id = t.id
        JOIN clubs c ON t.club_id = c.id
        WHERE s.status = 'free'
          AND c.status = 'confirme'
          AND LOWER(t.sport_type) = LOWER(?)
          AND s.date >= ?
          AND s.date < DATE_ADD(?, INTERVAL ? DAY)
      `;
      
      const params = [sportType, start, start, days];

      // Filtrage par club si fourni
      if (clubId) {
        sql += ' AND c.id = ?';
        params.push(clubId);
      }

      sql += ' ORDER BY s.date, s.start_time';

      this.db.query(sql, params, (err, slots) => {
        if (err) {
          logger.error('❌ Erreur lors de la récupération des créneaux:', err);
          reject(err);
        } else {
          logger.debug(`✅ ${slots.length} créneaux trouvés pour ${sportType}${clubId ? ` dans le club ${clubId}` : ''}`);
          if (slots.length > 0) {
            logger.debug('Premier créneau:', slots[0]);
          }
          const formatLocalDate = (dateValue) => {
            if (!dateValue) return null;
            const d = dateValue instanceof Date ? dateValue : new Date(dateValue);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
          };

          const formattedSlots = slots.map(slot => ({
            ...slot,
            date: formatLocalDate(slot.date)
          }));

          resolve(formattedSlots);
        }
      });
    });
  }

  /**
   * Récupère les annonces "last minute" - annonces qui expirent bientôt et ont des places disponibles
   * @param {Object} filters - Filtres de recherche
   * @param {string} filters.sport_type - Type de sport à filtrer (optionnel)
   * @param {string} filters.location - Recherche textuelle (optionnel)
   * @param {number} filters.user_id - ID de l'utilisateur pour vérifier sa participation (optionnel)
   * @param {number} filters.hours_until_expiration - Nombre d'heures avant expiration (défaut: 48h)
   * @returns {Promise<Array>} Liste des annonces last minute
   */
  async getLastMinuteAnnouncements(filters = {}) {
    const { sport_type, location, user_id, hours_until_expiration = 48 } = filters;
    
    logger.debug('🔥 getLastMinuteAnnouncements - Filtres reçus:', filters);
    
    let sql = `
      SELECT a.*, 
             u.name AS creator_name,
             t.name AS terrain_name,
             c.name AS club_name,
             c.id AS club_id,
             c.address, c.city, c.lat, c.lon,
             TIMESTAMPDIFF(HOUR, NOW(), a.expiration_date) AS hours_until_expiration
    `;
    
    const params = [];
    
    // Si user_id est fourni, vérifier si l'utilisateur participe
    if (user_id) {
      sql += `,
             (SELECT COUNT(*) FROM annonce_participants ap 
              WHERE ap.annonce_id = a.id AND ap.user_id = ?) AS user_has_joined
      `;
      params.push(parseInt(user_id));
    }
    
    sql += `
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN terrains t ON a.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      WHERE a.status = 'active'
        AND a.places_disponibles > 0
        AND a.expiration_date IS NOT NULL
        AND a.expiration_date > NOW()
        AND a.expiration_date <= DATE_ADD(NOW(), INTERVAL ? HOUR)
        AND (a.visibility = 'public'
    `;
    
    params.push(hours_until_expiration);
    
    // Gérer les annonces privées si user_id est fourni
    if (user_id) {
      sql += `
          OR (a.visibility = 'private' AND (
            a.created_by = ?
            OR EXISTS (
              SELECT 1 FROM annonce_invitations ai 
              WHERE ai.annonce_id = a.id 
              AND ai.user_id = ?
            )
          ))
      `;
      params.push(parseInt(user_id));
      params.push(parseInt(user_id));
    }
    
    sql += ')';

    // Filtrage par sport
    if (sport_type && sport_type !== 'all') {
      sql += ' AND LOWER(a.sport_type) = ?';
      params.push(sport_type.toLowerCase());
    }

    // Filtrage par lieu/description
    if (location && location.trim() !== '') {
      sql += ` AND (
        LOWER(c.name) LIKE ? OR 
        LOWER(c.city) LIKE ? OR 
        LOWER(c.address) LIKE ? OR
        LOWER(a.description) LIKE ?
      )`;
      const searchPattern = `%${location.toLowerCase()}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Trier par expiration la plus proche d'abord
    sql += ' ORDER BY a.expiration_date ASC';

    logger.debug('📝 SQL last minute:', sql);
    logger.debug('📝 Paramètres:', params);

    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, announcements) => {
        if (err) {
          logger.error('❌ Erreur SQL getLastMinuteAnnouncements:', err);
          reject(err);
        } else {
          logger.debug(`🔥 ${announcements.length} annonces last minute trouvées`);
          
          // Formater les dates
          const formattedAnnouncements = announcements.map(announcement => {
            const formatDateTime = (date) => {
              if (!date) return null;
              const d = new Date(date);
              const year = d.getFullYear();
              const month = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              const hours = String(d.getHours()).padStart(2, '0');
              const minutes = String(d.getMinutes()).padStart(2, '0');
              const seconds = String(d.getSeconds()).padStart(2, '0');
              return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
            };
            
            return {
              ...announcement,
              slot_start: formatDateTime(announcement.slot_start),
              slot_end: formatDateTime(announcement.slot_end),
              created_at: formatDateTime(announcement.created_at),
              expiration_date: formatDateTime(announcement.expiration_date)
            };
          });
          
          resolve(formattedAnnouncements);
        }
      });
    });
  }

  /**
   * Vérifie et annule automatiquement les annonces expirées sans participants minimum
   * Cette méthode devrait être appelée périodiquement (par exemple via un cron job)
   * @returns {Promise<Object>} Statistiques sur les annonces annulées
   */
  async checkAndCancelExpiredAnnouncements() {
    logger.debug('🔍 Vérification des annonces expirées...');
    
    return new Promise((resolve, reject) => {
      // Trouver les annonces expirées avec auto_cancel activé
      const sql = `
        SELECT a.id, a.sport_type, a.city, a.places_total, a.places_disponibles,
               a.min_participants, a.slot_id,
               (SELECT COUNT(*) FROM annonce_participants WHERE annonce_id = a.id) as participant_count
        FROM announcements a
        WHERE a.status = 'active'
          AND a.auto_cancel = TRUE
          AND a.expiration_date IS NOT NULL
          AND a.expiration_date <= NOW()
      `;

      this.db.query(sql, [], async (err, announcements) => {
        if (err) {
          logger.error('❌ Erreur lors de la récupération des annonces expirées:', err);
          reject(err);
          return;
        }

        logger.debug(`📊 ${announcements.length} annonces expirées trouvées`);

        const cancelledAnnouncements = [];
        const keptAnnouncements = [];

        for (const announcement of announcements) {
          const { id, participant_count, min_participants, slot_id } = announcement;
          
          // Si pas assez de participants, annuler
          if (participant_count < min_participants) {
            logger.debug(`❌ Annonce ${id}: ${participant_count}/${min_participants} participants - ANNULATION`);
            
            try {
              // Annuler l'annonce
              await new Promise((res, rej) => {
                this.db.query(
                  'UPDATE announcements SET status = ? WHERE id = ?',
                  ['cancelled', id],
                  (err2) => (err2 ? rej(err2) : res())
                );
              });

              // Libérer le slot si c'est une annonce de club
              if (slot_id) {
                await new Promise((res, rej) => {
                  this.db.query(
                    'UPDATE slots SET status = ? WHERE id = ?',
                    ['free', slot_id],
                    (err3) => (err3 ? rej(err3) : res())
                  );
                });
              }

              // Mesure : « parties annulées faute de joueurs », l'indicateur de
              // frustration du modèle (alerte au-delà de 30 %).
              track(this.db, 'game_expired', {
                announcementId: id,
                city: announcement.city,
                sport: announcement.sport_type,
                payload: { participants: participant_count, min_participants },
              });

              cancelledAnnouncements.push(id);
            } catch (error) {
              logger.error(`❌ Erreur lors de l'annulation de l'annonce ${id}:`, error);
            }
          } else {
            logger.debug(`✅ Annonce ${id}: ${participant_count}/${min_participants} participants - CONSERVÉE`);
            keptAnnouncements.push(id);
          }
        }

        logger.debug(`✅ Résultat: ${cancelledAnnouncements.length} annulées, ${keptAnnouncements.length} conservées`);

        resolve({
          checked: announcements.length,
          cancelled: cancelledAnnouncements.length,
          kept: keptAnnouncements.length,
          cancelledIds: cancelledAnnouncements,
          keptIds: keptAnnouncements
        });
      });
    });
  }
}

// Invitations / partage de session / messagerie liée — voir announcementInvitations.js
const AnnouncementInvitations = require("./announcementInvitations");
for (const name of Object.getOwnPropertyNames(AnnouncementInvitations.prototype)) {
  if (name !== "constructor") {
    AnnouncementsController.prototype[name] = AnnouncementInvitations.prototype[name];
  }
}

module.exports = AnnouncementsController;
