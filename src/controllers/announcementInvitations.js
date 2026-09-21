/**
 * Invitations aux annonces privées, partage de session et messagerie liée.
 * Mixin appliqué sur AnnouncementsController.prototype (this.db,
 * this.addParticipant, this.getAnnouncementById restent accessibles).
 * Extrait de announcements.controller.js (juillet 2026) — code inchangé.
 */
const { logger } = require("../utils/logger");
const { queryPromise, queryOne, insert } = require("../utils/dbHelpers");
const { NotFoundError, ForbiddenError, ValidationError, ConflictError } = require("../middleware/errorHandler");

class AnnouncementInvitations {
  /**
   * Invite des amis à une annonce privée
   * @param {number} announcementId - ID de l'annonce
   * @param {number} invitedBy - ID de l'utilisateur qui invite
   * @param {Array<number>} userIds - IDs des utilisateurs à inviter
   * @returns {Promise<Array>}
   */
  async inviteFriends(announcementId, invitedBy, userIds) {
    // Vérifier que l'annonce existe et est privée
    const announcement = await queryOne(this.db,
      'SELECT visibility, created_by FROM announcements WHERE id = ?', [announcementId]);
    if (!announcement) throw new NotFoundError('Annonce introuvable');
    if (announcement.visibility !== 'private') {
      throw new ValidationError('Les invitations ne sont possibles que pour les annonces privées');
    }
    if (announcement.created_by !== invitedBy) throw new ForbiddenError('Seul le créateur peut inviter des amis');

    // Vérifier que les utilisateurs sont bien amis
    const friendChecks = await Promise.all(userIds.map(userId => this.checkIfFriends(invitedBy, userId)));
    const nonFriends = userIds.filter((userId, index) => !friendChecks[index]);
    if (nonFriends.length > 0) {
      throw new ValidationError(`Certains utilisateurs ne sont pas vos amis: ${nonFriends.join(', ')}`);
    }

    const invitations = [];
    for (const userId of userIds) {
      try {
        invitations.push(await this.createInvitation(announcementId, userId, invitedBy));
      } catch (err) {
        // Ignorer les doublons (déjà invité)
        if (!err.message.includes('déjà invité')) throw err;
      }
    }

    return invitations;
  }

  /**
   * Partage une session (publique ou privée) avec des utilisateurs via message.
   * Pas de restriction de visibilité ni de vérification d'amitié.
   */
  async shareSession(announcementId, sharedBy, userIds) {
    const announcement = await this.getAnnouncementById(announcementId, sharedBy);
    if (!announcement) throw new NotFoundError('Annonce introuvable');

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
    const sql = `
        SELECT id FROM amis
        WHERE ((user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?))
        AND status = 'accepted'
      `;

    const results = await queryPromise(this.db, sql, [userId1, userId2, userId2, userId1]);
    return results.length > 0;
  }

  /**
   * Crée une invitation
   * @param {number} announcementId - ID de l'annonce
   * @param {number} userId - ID de l'utilisateur invité
   * @param {number} invitedBy - ID de l'utilisateur qui invite
   * @returns {Promise<Object>}
   */
  async createInvitation(announcementId, userId, invitedBy) {
    // Vérifier si l'invitation n'existe pas déjà
    const existing = await queryPromise(this.db,
      'SELECT id FROM annonce_invitations WHERE annonce_id = ? AND user_id = ?',
      [announcementId, userId]);
    if (existing.length > 0) throw new ConflictError('Cet utilisateur a déjà été invité');

    const id = await insert(this.db, `
            INSERT INTO annonce_invitations (annonce_id, user_id, invited_by, status, invited_at)
            VALUES (?, ?, ?, 'pending', NOW())
          `, [announcementId, userId, invitedBy]);

    return { id, annonce_id: announcementId, user_id: userId, invited_by: invitedBy, status: 'pending' };
  }

  /**
   * Récupère les invitations d'un utilisateur
   * @param {number} userId - ID de l'utilisateur
   * @param {string} status - Statut des invitations (optionnel)
   * @returns {Promise<Array>}
   */
  async getUserInvitations(userId, status = null) {
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

    return queryPromise(this.db, sql, params);
  }

  /**
   * Accepte une invitation
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async acceptInvitation(invitationId, userId) {
    const invitation = await queryOne(this.db,
      'SELECT * FROM annonce_invitations WHERE id = ? AND user_id = ?', [invitationId, userId]);
    if (!invitation) throw new NotFoundError('Invitation introuvable');
    if (invitation.status !== 'pending') throw new ConflictError('Cette invitation a déjà été traitée');

    await this.addParticipant(invitation.annonce_id, userId, 'participant');

    await queryPromise(this.db,
      'UPDATE annonce_invitations SET status = ? WHERE id = ?', ['accepted', invitationId]);

    return { success: true, invitation };
  }

  /**
   * Refuse une invitation
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur
   * @returns {Promise<Object>}
   */
  async declineInvitation(invitationId, userId) {
    const result = await queryPromise(this.db,
      'UPDATE annonce_invitations SET status = ? WHERE id = ? AND user_id = ? AND status = ?',
      ['declined', invitationId, userId, 'pending']);
    if (result.affectedRows === 0) throw new NotFoundError('Invitation introuvable ou déjà traitée');
    return { success: true };
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
    // Chercher un chat privé existant entre ces deux utilisateurs
    const existing = await queryOne(this.db, `
        SELECT c.id
        FROM chats c
        INNER JOIN chat_participants cp1 ON c.id = cp1.chat_id AND cp1.user_id = ?
        INNER JOIN chat_participants cp2 ON c.id = cp2.chat_id AND cp2.user_id = ?
        WHERE c.type = 'private'
        LIMIT 1
      `, [userId1, userId2]);
    if (existing) return existing.id;

    // Sinon, créer un nouveau chat privé
    const chatId = await insert(this.db,
      'INSERT INTO chats (type, created_at) VALUES (?, NOW())', ['private']);

    await queryPromise(this.db, `
              INSERT INTO chat_participants (chat_id, user_id, role, joined_at) VALUES
              (?, ?, 'member', NOW()),
              (?, ?, 'member', NOW())
            `, [chatId, userId1, chatId, userId2]);

    return chatId;
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
      invitationId: invitation.id,
    };

    const content = `Vous avez été invité à rejoindre une partie de ${announcement.sport_type}`;

    const id = await insert(this.db, `
        INSERT INTO messages (chat_id, sender_id, content, message_type, invitation_id, metadata, created_at)
        VALUES (?, ?, ?, 'invitation', ?, ?, NOW())
      `, [chatId, senderId, content, invitation.id, JSON.stringify(metadata)]);

    return {
      id,
      chat_id: chatId,
      sender_id: senderId,
      content,
      message_type: 'invitation',
      invitation_id: invitation.id,
      metadata,
    };
  }

  /**
   * Répondre à une invitation (accepter/refuser)
   * @param {number} invitationId - ID de l'invitation
   * @param {number} userId - ID de l'utilisateur qui répond
   * @param {string} response - 'accepted' ou 'declined'
   * @returns {Promise<Object>}
   */
  async respondToInvitation(invitationId, userId, response) {
    // Vérifier que l'invitation existe et appartient à l'utilisateur
    const invitation = await queryOne(this.db,
      'SELECT * FROM annonce_invitations WHERE id = ? AND user_id = ? AND status = ?',
      [invitationId, userId, 'pending']);
    if (!invitation) throw new NotFoundError('Invitation introuvable ou déjà traitée');

    // Si accepté, ajouter comme participant
    if (response === 'accepted') {
      await this.addParticipant(invitation.annonce_id, userId, 'participant');
    }

    await queryPromise(this.db,
      'UPDATE annonce_invitations SET status = ?, responded_at = NOW() WHERE id = ?',
      [response, invitationId]);

    // Mettre à jour le message d'invitation
    await queryPromise(this.db,
      `UPDATE messages
                 SET metadata = JSON_SET(metadata, '$.responded', ?)
                 WHERE invitation_id = ?`,
      [response, invitationId]);

    return { success: true, status: response, announcementId: invitation.annonce_id };
  }

}

module.exports = AnnouncementInvitations;
