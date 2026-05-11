const AnnouncementsController = require('../controllers/announcements.controller');
const { requireAuth, optionalAuth } = require('../middleware/auth');

module.exports = function(db) {
  const express = require('express');
  const router = express.Router();
  const controller = new AnnouncementsController(db);

  /**
   * GET /api/announcements
   * Récupère les annonces publiques avec filtres optionnels
   * Query params: sport_type, status, club_id, user_id
   */
  router.get('/announcements', async (req, res) => {
    try {
      const { sport_type, status, club_id, user_id, public_place_id } = req.query;
      const normalizedStatus = status === 'open' ? 'active' : status;
      const announcements = await controller.getPublicAnnouncements({ sport_type, status: normalizedStatus, club_id, user_id, public_place_id });
      
      res.json({ 
        announcements,
        count: announcements.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des annonces:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des annonces', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/announcements/last-minute
   * Récupère les annonces "last minute" (qui expirent bientôt et ont des places disponibles)
   * Query params: sport_type, location, user_id, hours_until_expiration
   */
  router.get('/announcements/last-minute', async (req, res) => {
    try {
      const { sport_type, location, user_id, hours_until_expiration } = req.query;
      const announcements = await controller.getLastMinuteAnnouncements({ 
        sport_type, 
        location, 
        user_id: user_id ? parseInt(user_id) : null,
        hours_until_expiration: hours_until_expiration ? parseInt(hours_until_expiration) : 48
      });
      
      res.json({ 
        announcements,
        count: announcements.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des annonces last minute:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des annonces last minute', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/announcements/check-expired
   * Vérifie et annule automatiquement les annonces expirées sans participants minimum
   * (Cette route devrait être protégée et appelée uniquement par un cron job ou un admin)
   */
  router.post('/announcements/check-expired', async (req, res) => {
    try {
      const result = await controller.checkAndCancelExpiredAnnouncements();
      res.json({ 
        success: true,
        ...result
      });
    } catch (err) {
      console.error('Erreur lors de la vérification des annonces expirées:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la vérification des annonces expirées', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/announcements/:id
   * Récupère une annonce spécifique par son ID
   * Headers: user-id (optionnel pour vérifier l'accès aux annonces privées)
   */
  router.get('/announcements/:id', optionalAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user?.id ?? null;
      
      const announcement = await controller.getAnnouncementById(parseInt(id), userId);
      
      res.json({ announcement });
    } catch (err) {
      console.error('Erreur lors de la récupération de l\'annonce:', err);
      
      if (err.message === 'Annonce introuvable') {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('Accès refusé')) {
        res.status(403).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la récupération de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * POST /api/announcements
   * Crée une nouvelle annonce
   * Body: { sport_type, terrain_id?, slot_start, slot_end, places_total, description?, created_by, visibility? }
   */
  router.post('/announcements', requireAuth, async (req, res) => {
    try {
      const announcementData = { ...req.body, created_by: req.user.id };
      const announcement = await controller.createAnnouncement(announcementData);
      
      res.status(201).json({ 
        success: true,
        announcement 
      });
    } catch (err) {
      console.error('Erreur lors de la création de l\'annonce:', err);
      
      if (err.message.includes('Champs requis')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la création de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * PUT /api/announcements/:id
   * Met à jour une annonce
   * Body: { description?, status?, slot_start?, slot_end? }
   * Headers: user-id (requis)
   */
  router.put('/announcements/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const updateData = req.body;
      
      const announcement = await controller.updateAnnouncement(parseInt(id), userId, updateData);
      
      res.json({ 
        success: true,
        announcement 
      });
    } catch (err) {
      console.error('Erreur lors de la mise à jour de l\'annonce:', err);
      
      if (err.message.includes('introuvable')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('créateur')) {
        res.status(403).json({ error: err.message });
      } else if (err.message.includes('Aucune donnée')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la mise à jour de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * DELETE /api/announcements/:id
   * Annule une annonce (met le status à 'cancelled')
   * Headers: user-id (requis)
   */
  router.delete('/announcements/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const announcement = await controller.cancelAnnouncement(parseInt(id), userId);
      
      res.json({ 
        success: true,
        announcement 
      });
    } catch (err) {
      console.error('Erreur lors de l\'annulation de l\'annonce:', err);
      
      if (err.message.includes('introuvable')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('créateur')) {
        res.status(403).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de l\'annulation de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * POST /api/announcements/:id/join
   * Rejoindre une annonce publique
   * Headers: user-id (requis)
   */
  router.post('/announcements/:id/join', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const result = await controller.addParticipant(parseInt(id), userId, 'participant');
      
      res.json({ 
        success: true,
        participant: result 
      });
    } catch (err) {
      console.error('Erreur lors de la participation à l\'annonce:', err);
      
      if (err.message.includes('déjà participant')) {
        res.status(409).json({ error: err.message });
      } else if (err.message.includes('Plus de places')) {
        res.status(400).json({ error: err.message });
      } else if (err.message.includes('introuvable')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la participation à l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * DELETE /api/announcements/:id/leave
   * Quitter une annonce
   * Headers: user-id (requis)
   */
  router.delete('/announcements/:id/leave', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const result = await controller.removeParticipant(parseInt(id), userId);
      
      res.json(result);
    } catch (err) {
      console.error('Erreur lors du départ de l\'annonce:', err);
      
      if (err.message.includes('ne participez pas')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('créateur')) {
        res.status(403).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors du départ de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * POST /api/announcements/:id/invite
   * Inviter des amis à une annonce privée
   * Body: { userIds: [1, 2, 3] }
   * Headers: user-id (requis)
   */
  router.post('/announcements/:id/invite', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const { userIds } = req.body;

      if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ error: 'userIds requis et doit être un tableau' });
      }
      
      const invitations = await controller.inviteFriends(parseInt(id), userId, userIds);
      
      res.status(201).json({ 
        success: true,
        invitations,
        count: invitations.length
      });
    } catch (err) {
      console.error('Erreur lors de l\'invitation:', err);
      
      if (err.message.includes('introuvable')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('privées') || err.message.includes('créateur')) {
        res.status(403).json({ error: err.message });
      } else if (err.message.includes('amis')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de l\'invitation',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * GET /api/users/:userId/invitations
   * Récupère les invitations d'un utilisateur
   * Query params: status (optionnel)
   */
  router.get('/users/:userId/invitations', async (req, res) => {
    try {
      const { userId } = req.params;
      const { status } = req.query;
      
      const invitations = await controller.getUserInvitations(parseInt(userId), status);
      
      res.json({ 
        invitations,
        count: invitations.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des invitations:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des invitations',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * PUT /api/invitations/:id/respond
   * Répondre à une invitation (accepter/refuser)
   * Body: { response: 'accepted' | 'declined' }
   * Headers: user-id (requis)
   */
  router.put('/invitations/:id/respond', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { response } = req.body;
      const userId = req.user.id;

      if (!response || !['accepted', 'declined'].includes(response)) {
        return res.status(400).json({ error: 'Réponse invalide. Utilisez "accepted" ou "declined"' });
      }
      
      const result = await controller.respondToInvitation(parseInt(id), userId, response);
      
      res.json(result);
    } catch (err) {
      console.error('Erreur lors de la réponse à l\'invitation:', err);
      
      if (err.message.includes('introuvable') || err.message.includes('traitée')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('Plus de places')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la réponse à l\'invitation',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * PUT /api/invitations/:id/accept
   * Accepter une invitation
   * Headers: user-id (requis)
   */
  router.put('/invitations/:id/accept', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const result = await controller.acceptInvitation(parseInt(id), userId);
      
      res.json(result);
    } catch (err) {
      console.error('Erreur lors de l\'acceptation de l\'invitation:', err);
      
      if (err.message.includes('introuvable') || err.message.includes('traitée')) {
        res.status(404).json({ error: err.message });
      } else if (err.message.includes('Plus de places')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de l\'acceptation de l\'invitation',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * PUT /api/invitations/:id/decline
   * Refuser une invitation
   * Headers: user-id (requis)
   */
  router.put('/invitations/:id/decline', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const result = await controller.declineInvitation(parseInt(id), userId);
      
      res.json(result);
    } catch (err) {
      console.error('Erreur lors du refus de l\'invitation:', err);
      
      if (err.message.includes('introuvable') || err.message.includes('traitée')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors du refus de l\'invitation',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * GET /api/users/:userId/announcements
   * Récupère les annonces créées par un utilisateur
   */
  router.get('/users/:userId/announcements', async (req, res) => {
    try {
      const { userId } = req.params;
      
      const announcements = await controller.getUserAnnouncements(parseInt(userId));
      
      res.json({ 
        announcements,
        count: announcements.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des annonces de l\'utilisateur:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des annonces',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/announcements/:id/validate
   * Valider une annonce et créer la réservation payante
   * Headers: user-id (requis)
   */
  router.post('/announcements/:id/validate', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      const result = await controller.validateAnnouncement(parseInt(id), userId);
      
      res.json(result);
    } catch (err) {
      console.error('Erreur lors de la validation de l\'annonce:', err);
      
      if (err.message.includes('introuvable') || err.message.includes('créateur')) {
        res.status(403).json({ error: err.message });
      } else if (err.message.includes('validée')) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la validation de l\'annonce',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * GET /api/slots/available
   * Récupère les créneaux disponibles pour un sport
   * Query params: sport_type (requis), start_date, days, club_id
   */
  router.get('/slots/available', async (req, res) => {
    try {
      const { sport_type, start_date, days, club_id } = req.query;

      if (!sport_type) {
        return res.status(400).json({ error: 'sport_type requis' });
      }
      
      const slots = await controller.getAvailableSlots(
        sport_type,
        start_date,
        days ? parseInt(days) : 7,
        club_id ? parseInt(club_id) : null
      );
      
      res.json({ 
        slots,
        count: slots.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des créneaux:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des créneaux',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  return router;
};
