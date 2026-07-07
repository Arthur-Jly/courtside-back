/**
 * Invitations aux annonces privées, partage de session et messagerie liée.
 * Mixin appliqué sur AnnouncementsController.prototype (this.db,
 * this.addParticipant, this.getAnnouncementById restent accessibles).
 * Extrait de announcements.controller.js (juillet 2026) — code inchangé.
 */
const { logger } = require("../utils/logger");

class AnnouncementInvitations {
  /**
   * Invite des amis à une annonce privée
   * @param {number} announcementId - ID de l'annonce
   * @param {number} invitedBy - ID de l'utilisateur qui invite
   * @param {Array<number>} userIds - IDs des utilisateurs à inviter
   * @returns {Promise<Array>}
   */
  async inviteFriends(announcementId, invitedBy, userIds) {
    return new Promise((resolve, reject) => {
      // Vérifier que l'annonce existe et est privée
      this.db.query(
        'SELECT visibility, created_by FROM announcements WHERE id = ?',
        [announcementId],
        async (err, announcements) => {
          if (err) {
            reject(err);
            return;
          }

          if (announcements.length === 0) {
            reject(new Error('Annonce introuvable'));
            return;
          }

          if (announcements[0].visibility !== 'private') {
            reject(new Error('Les invitations ne sont possibles que pour les annonces privées'));
            return;
          }

          if (announcements[0].created_by !== invitedBy) {
            reject(new Error('Seul le créateur peut inviter des amis'));
            return;
          }

          // Vérifier que les utilisateurs sont bien amis
          const friendCheckPromises = userIds.map(userId => this.checkIfFriends(invitedBy, userId));
          
          try {
            const friendChecks = await Promise.all(friendCheckPromises);
            const nonFriends = userIds.filter((userId, index) => !friendChecks[index]);
            
            if (nonFriends.length > 0) {
              reject(new Error(`Certains utilisateurs ne sont pas vos amis: ${nonFriends.join(', ')}`));
              return;
            }

            // Créer les invitations
            const invitations = [];
            for (const userId of userIds) {
              try {
                const invitation = await this.createInvitation(announcementId, userId, invitedBy);
                invitations.push(invitation);
              } catch (err) {
                // Ignorer les doublons (déjà invité)
                if (!err.message.includes('déjà invité')) {
                  throw err;
                }
              }
            }

            resolve(invitations);
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  }

  /**
   * Partage une session (publique ou privée) avec des utilisateurs via message.
   * Pas de restriction de visibilité ni de vérification d'amitié.
   */
  async shareSession(announcementId, sharedBy, userIds) {
    const announcement = await this.getAnnouncementById(announcementId, sharedBy);
    if (!announcement) throw new Error('Annonce introuvable');

    const results = [];
    for (const userId of userIds) {
      try {
        const chatId = await this.getOrCreatePrivateChat(sharedBy, userId);
        const fakeInvitation = { id: null, user_id: userId };
        await this.sendInvitationMessage(chatId, sharedBy, fakeInvitation, announcement);
        results.push({ userId, success: true });
      } catch (err) {
        logger.error(`Erreur partage session pour user ${userId}:`, err);
        results.push({ userId, success: false });
      }
    }
    return results;
  }

  /**
   * Vérifie si deux utilisateurs sont amis
   * @param {number} userId1 - ID du premier utilisateur
   * @param {number} userId2 - ID du second utilisateur
   * @returns {Promise<boolean>}
   */
  async checkIfFriends(userId1, userId2) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT id FROM amis 
        WHERE ((user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?))
        AND status = 'accepted'
      `;

      this.db.query(sql, [userId1, userId2, userId2, userId1], (err, results) => {
        if (err) {
          reject(err);
        } else {
          resolve(results.length > 0);
        }
      });
    });
  }

  /**
   * Crée une invitation
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur invité
   * @param {number} invitedBy - ID de l'utilisateur qui invite
   * @returns {Promise<Object>}
   */
  async createInvitation(announcementId, userId, invitedBy) {
    return new Promise((resolve, reject) => {
      // Vérifier si l'invitation n'existe pas déjà
      this.db.query(
        'SELECT id FROM annonce_invitations WHERE annonce_id = ? AND user_id = ?',
        [announcementId, userId],
        (err, existing) => {
          if (err) {
            reject(err);
            return;
          }

          if (existing.length > 0) {
            reject(new Error('Cet utilisateur a déjà été invité'));
            return;
          }

          const sql = `
            INSERT INTO annonce_invitations (annonce_id, user_id, invited_by, status, invited_at)
            VALUES (?, ?, ?, 'pending', NOW())
          `;

          this.db.query(sql, [announcementId, userId, invitedBy], (err2, result) => {
            if (err2) {
              reject(err2);
            } else {
              resolve({
                id: result.insertId,
                annonce_id: announcementId,
                user_id: userId,
                invited_by: invitedBy,
                status: 'pending'
              });
            }
          });
        }
      );
    });
  }

  /**
   * Récupère les invitations d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} status - Statut des invitations (optionnel)
   * @returns {Promise<Array>}
   */
  async getUserInvitations(userId, status = null) {
    return new Promise((resolve, reject) => {
      let sql = `
        SELECT ai.*, 
               a.sport_type, a.slot_start, a.slot_end, a.description, a.places_disponibles,
               u.name AS inviter_name,
               t.name AS terrain_name,
               c.name AS club_name, c.address, c.city
        FROM annonce_invitations ai
        LEFT JOIN announcements a ON ai.annonce_id = a.id
        LEFT JOIN users u ON ai.invited_by = u.id
        LEFT JOIN terrains t ON a.terrain_id = t.id
        LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
        WHERE ai.user_id = ?
      `;
      const params = [userId];

      if (status) {
        sql += ' AND ai.status = ?';
        params.push(status);
      }

      sql += ' ORDER BY ai.invited_at DESC';

      this.db.query(sql, params, (err, invitations) => {
        if (err) {
          reject(err);
        } else {
          resolve(invitations);
        }
      });
    });
  }

  /**
   * Accepte une invitation
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async acceptInvitation(invitationId, userId) {
    return new Promise((resolve, reject) => {
      // Récupérer l'invitation
      this.db.query(
        'SELECT * FROM annonce_invitations WHERE id = ? AND user_id = ?',
        [invitationId, userId],
        async (err, invitations) => {
          if (err) {
            reject(err);
            return;
          }

          if (invitations.length === 0) {
            reject(new Error('Invitation introuvable'));
            return;
          }

          const invitation = invitations[0];

          if (invitation.status !== 'pending') {
            reject(new Error('Cette invitation a déjà été traitée'));
            return;
          }

          try {
            // Ajouter le participant à l'annonce
            await this.addParticipant(invitation.annonce_id, userId, 'participant');

            // Mettre à jour le statut de l'invitation
            this.db.query(
              'UPDATE annonce_invitations SET status = ? WHERE id = ?',
              ['accepted', invitationId],
              (err2) => {
                if (err2) {
                  reject(err2);
                } else {
                  resolve({ success: true, invitation });
                }
              }
            );
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  }

  /**
   * Refuse une invitation
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async declineInvitation(invitationId, userId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        'UPDATE annonce_invitations SET status = ? WHERE id = ? AND user_id = ? AND status = ?',
        ['declined', invitationId, userId, 'pending'],
        (err, result) => {
          if (err) {
            reject(err);
          } else if (result.affectedRows === 0) {
            reject(new Error('Invitation introuvable ou déjà traitée'));
          } else {
            resolve({ success: true });
          }
        }
      );
    });
  }

  /**
   * Invite des amis avec envoi de messages automatique
   * @param {number} announcementId - ID de l'annonce
   * @param {number} invitedBy - ID de l'utilisateur qui invite
   * @param {Array<number>} userIds - IDs des utilisateurs à inviter
   * @returns {Promise<Array>}
   */
  async inviteFriendsWithMessages(announcementId, invitedBy, userIds) {
    logger.debug(`inviteFriendsWithMessages - annonce ${announcementId}, inviteur ${invitedBy}, ${userIds.length} invités`);
    
    try {
      // Créer les invitations (utilise la méthode existante)
      const invitations = await this.inviteFriends(announcementId, invitedBy, userIds);
      logger.debug(`✅ ${invitations.length} invitations créées`);

      // Récupérer les détails de l'annonce pour le message
      const announcement = await this.getAnnouncementById(announcementId, invitedBy);
      
      // Pour chaque invitation, envoyer un message
      for (const invitation of invitations) {
        try {
          // Trouver ou créer un chat privé
          const chatId = await this.getOrCreatePrivateChat(invitedBy, invitation.user_id);
          logger.debug(`💬 Chat ${chatId} créé/trouvé pour user ${invitation.user_id}`);
          
          // Envoyer le message d'invitation
          await this.sendInvitationMessage(chatId, invitedBy, invitation, announcement);
          logger.debug(`✅ Message d'invitation envoyé à user ${invitation.user_id}`);
        } catch (msgErr) {
          logger.error(`❌ Erreur envoi message pour user ${invitation.user_id}:`, msgErr);
          // Continue même si un message échoue
        }
      }

      return invitations;
    } catch (error) {
      logger.error('❌ Erreur dans inviteFriendsWithMessages:', error);
      throw error;
    }
  }

  /**
   * Trouve ou crée un chat privé entre deux utilisateurs
   * @param {number} userId1 - Premier utilisateur
   * @param {number} userId2 - Second utilisateur
   * @returns {Promise<number>} ID du chat
   */
  async getOrCreatePrivateChat(userId1, userId2) {
    return new Promise((resolve, reject) => {
      // Chercher un chat privé existant entre ces deux utilisateurs
      const sql = `
        SELECT c.id 
        FROM chats c
        INNER JOIN chat_participants cp1 ON c.id = cp1.chat_id AND cp1.user_id = ?
        INNER JOIN chat_participants cp2 ON c.id = cp2.chat_id AND cp2.user_id = ?
        WHERE c.type = 'private'
        LIMIT 1
      `;

      this.db.query(sql, [userId1, userId2], (err, chats) => {
        if (err) {
          reject(err);
          return;
        }

        // Si chat existe, le retourner
        if (chats.length > 0) {
          resolve(chats[0].id);
          return;
        }

        // Sinon, créer un nouveau chat privé
        this.db.query(
          'INSERT INTO chats (type, created_at) VALUES (?, NOW())',
          ['private'],
          (err2, result) => {
            if (err2) {
              reject(err2);
              return;
            }

            const chatId = result.insertId;

            // Ajouter les deux participants
            const insertParticipants = `
              INSERT INTO chat_participants (chat_id, user_id, role, joined_at) VALUES 
              (?, ?, 'member', NOW()),
              (?, ?, 'member', NOW())
            `;

            this.db.query(insertParticipants, [chatId, userId1, chatId, userId2], (err3) => {
              if (err3) {
                reject(err3);
                return;
              }

              resolve(chatId);
            });
          }
        );
      });
    });
  }

  /**
   * Envoie un message d'invitation dans un chat
   * @param {number} chatId - ID du chat
   * @param {number} senderId - ID de l'expéditeur
   * @param {Object} invitation - Objet invitation
   * @param {Object} announcement - Détails de l'annonce
   * @returns {Promise<Object>}
   */
  async sendInvitationMessage(chatId, senderId, invitation, announcement) {
    return new Promise((resolve, reject) => {
      // Créer le metadata JSON avec toutes les infos
      const metadata = {
        type: 'invitation',
        announcementId: announcement.id,
        sport: announcement.sport_type,
        slotStart: announcement.slot_start,
        slotEnd: announcement.slot_end,
        location: announcement.club_name,
        address: announcement.address,
        city: announcement.city,
        placesTotal: announcement.places_total,
        placesDisponibles: announcement.places_disponibles,
        description: announcement.description,
        invitationId: invitation.id
      };

      const content = `Vous avez été invité à rejoindre une partie de ${announcement.sport_type}`;

      const sql = `
        INSERT INTO messages (chat_id, sender_id, content, message_type, invitation_id, metadata, created_at)
        VALUES (?, ?, ?, 'invitation', ?, ?, NOW())
      `;

      this.db.query(
        sql,
        [chatId, senderId, content, invitation.id, JSON.stringify(metadata)],
        (err, result) => {
          if (err) {
            reject(err);
            return;
          }

          resolve({
            id: result.insertId,
            chat_id: chatId,
            sender_id: senderId,
            content,
            message_type: 'invitation',
            invitation_id: invitation.id,
            metadata
          });
        }
      );
    });
  }

  /**
   * Répondre à une invitation (accepter/refuser)
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur qui répond
   * @param {string} response - 'accepted' ou 'declined'
   * @returns {Promise<Object>}
   */
  async respondToInvitation(invitationId, userId, response) {
    return new Promise((resolve, reject) => {
      // Vérifier que l'invitation existe et appartient à l'utilisateur
      this.db.query(
        'SELECT * FROM annonce_invitations WHERE id = ? AND user_id = ? AND status = ?',
        [invitationId, userId, 'pending'],
        async (err, invitations) => {
          if (err) {
            reject(err);
            return;
          }

          if (invitations.length === 0) {
            reject(new Error('Invitation introuvable ou déjà traitée'));
            return;
          }

          const invitation = invitations[0];

          try {
            // Si accepté, ajouter comme participant
            if (response === 'accepted') {
              await this.addParticipant(invitation.annonce_id, userId, 'participant');
            }

            // Mettre à jour le statut de l'invitation
            await new Promise((res, rej) => {
              this.db.query(
                'UPDATE annonce_invitations SET status = ?, responded_at = NOW() WHERE id = ?',
                [response, invitationId],
                (err2) => (err2 ? rej(err2) : res())
              );
            });

            // Mettre à jour le message d'invitation
            await new Promise((res, rej) => {
              this.db.query(
                `UPDATE messages 
                 SET metadata = JSON_SET(metadata, '$.responded', ?) 
                 WHERE invitation_id = ?`,
                [response, invitationId],
                (err3) => (err3 ? rej(err3) : res())
              );
            });

            resolve({
              success: true,
              status: response,
              announcementId: invitation.annonce_id
            });
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  }

}

module.exports = AnnouncementInvitations;
