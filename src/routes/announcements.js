const AnnouncementsController = require('../controllers/announcements.controller');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError, ValidationError } = require('../middleware/errorHandler');
const rateLimit = require('express-rate-limit');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function classifyKnownError(err) {
  const m = String(err.message || '');
  if (m.includes('introuvable') || m.includes('traitee') || m.includes('traitée')) return new NotFoundError(err.message);
  if (m.includes('createur') || m.includes('créateur') || m.includes('privees') || m.includes('privées') || m.includes('Acces refuse') || m.includes('Accès refusé')) return new ForbiddenError(err.message);
  if (m.includes('Champs requis') || m.includes('Plus de places') || m.includes('deja') || m.includes('déjà') || m.includes('amis') || m.includes('Aucune donnee') || m.includes('Aucune donnée') || m.includes('validee') || m.includes('validée')) return new ValidationError(err.message);
  return err;
}

module.exports = function (db) {
  const express = require('express');
  const router = express.Router();
  const controller = new AnnouncementsController(db);

  router.get('/announcements', asyncHandler(async (req, res) => {
    const { sport_type, status, club_id, user_id, public_place_id } = req.query;
    const normalizedStatus = status === 'open' ? 'active' : status;
    const announcements = await controller.getPublicAnnouncements({
      sport_type, status: normalizedStatus, club_id, user_id, public_place_id,
    });
    res.json({ announcements, count: announcements.length });
  }));

  router.get('/announcements/last-minute', asyncHandler(async (req, res) => {
    const { sport_type, location, user_id, hours_until_expiration } = req.query;
    const announcements = await controller.getLastMinuteAnnouncements({
      sport_type,
      location,
      user_id: user_id ? parseInt(user_id, 10) : null,
      hours_until_expiration: hours_until_expiration ? parseInt(hours_until_expiration, 10) : 48,
    });
    res.json({ announcements, count: announcements.length });
  }));

  // Internal-only endpoint: must be called by the cron service. Reject external callers.
  router.post('/announcements/check-expired', asyncHandler(async (req, res) => {
    const cronToken = process.env.CRON_TOKEN;
    if (!cronToken || req.headers['x-cron-token'] !== cronToken) {
      throw new ForbiddenError();
    }
    const result = await controller.checkAndCancelExpiredAnnouncements();
    res.json({ success: true, ...result });
  }));

  router.get('/announcements/:id', optionalAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const announcement = await controller.getAnnouncementById(id, req.user?.id ?? null);
      res.json({ announcement });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.post('/announcements', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const announcementData = { ...req.body, created_by: req.user.id };
    try {
      const announcement = await controller.createAnnouncement(announcementData);
      res.status(201).json({ success: true, announcement });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.put('/announcements/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const announcement = await controller.updateAnnouncement(id, req.user.id, req.body);
      res.json({ success: true, announcement });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.delete('/announcements/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const announcement = await controller.cancelAnnouncement(id, req.user.id);
      res.json({ success: true, announcement });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.post('/announcements/:id/join', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const result = await controller.addParticipant(id, req.user.id, 'participant');
      res.json({ success: true, participant: result });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.delete('/announcements/:id/leave', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const result = await controller.removeParticipant(id, req.user.id);
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.post('/announcements/:id/invite', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const { userIds } = req.body || {};
    if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > 50) {
      return res.status(400).json({ error: 'userIds requis (max 50)' });
    }
    try {
      const results = await controller.shareSession(id, req.user.id, userIds.map(Number).filter(Number.isFinite));
      res.status(201).json({ success: true, results, count: results.length });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.get('/users/:userId/invitations', requireAuth, asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'userId invalide' });
    if (req.user.id !== userId) throw new ForbiddenError();
    const invitations = await controller.getUserInvitations(userId, req.query.status);
    res.json({ invitations, count: invitations.length });
  }));

  router.put('/invitations/:id/respond', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const { response } = req.body || {};
    if (!['accepted', 'declined'].includes(response)) return res.status(400).json({ error: 'reponse invalide' });
    try {
      const result = await controller.respondToInvitation(id, req.user.id, response);
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.put('/invitations/:id/accept', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const result = await controller.acceptInvitation(id, req.user.id);
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.put('/invitations/:id/decline', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const result = await controller.declineInvitation(id, req.user.id);
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.get('/users/:userId/announcements', asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'userId invalide' });
    const announcements = await controller.getUserAnnouncements(userId);
    res.json({ announcements, count: announcements.length });
  }));

  router.post('/announcements/:id/validate', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const result = await controller.validateAnnouncement(id, req.user.id);
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  router.get('/slots/available', asyncHandler(async (req, res) => {
    const { sport_type, start_date, days, club_id } = req.query;
    if (!sport_type) return res.status(400).json({ error: 'sport_type requis' });
    const slots = await controller.getAvailableSlots(
      sport_type, start_date,
      days ? parseInt(days, 10) : 7,
      club_id ? parseInt(club_id, 10) : null,
    );
    res.json({ slots, count: slots.length });
  }));

  return router;
};
