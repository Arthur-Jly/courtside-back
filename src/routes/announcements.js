const AnnouncementsController = require('../controllers/announcements.controller');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError, ValidationError } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');
const { queryOne, queryPromise, insert } = require('../utils/dbHelpers');
const { notify } = require('../utils/notify');
const { track } = require('../utils/track');
const sseHub = require('../services/sseHub');
const rateLimit = require('express-rate-limit');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const SPORT_LABELS = { foot: 'Foot', basket: 'Basket', hand: 'Hand', volley: 'Volley', ping: 'Ping-pong' };

/**
 * Prévient les joueurs de la même ville qui pratiquent ce sport.
 *
 * C'est le moteur du remplissage en phase 1 : une partie publiée pour le soir
 * même n'a que quelques heures pour trouver ses joueurs. Le ciblage est
 * volontairement étroit (ville × sport) — une notification hors sujet coûte un
 * désabonnement, pas une inscription.
 */
async function notifyNearbyPlayers(db, announcement, organizerId) {
  const city = announcement?.city;
  const sport = announcement?.sport_type;
  if (!city || !sport) return;

  const rows = await queryPromise(db, `
    SELECT u.id
    FROM users u
    JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id <> ?
      AND LOWER(p.city) = LOWER(?)
      AND (p.sports IS NULL OR JSON_LENGTH(p.sports) = 0 OR JSON_CONTAINS(p.sports, ?))
    LIMIT 200
  `, [organizerId, city, JSON.stringify(String(sport))]).catch(() => []);

  const when = announcement.slot_start ? String(announcement.slot_start).slice(0, 16).replace('T', ' ') : '';
  const summary = `${SPORT_LABELS[sport] || sport} ${when} · ${announcement.place_name || city}`;

  for (const row of rows) {
    notify(db, row.id, 'new_game_nearby', {
      announcement_id: announcement.id,
      city, sport, summary,
    });
  }
}

function classifyKnownError(err) {
  const m = String(err.message || '');
  if (m.includes('introuvable') || m.includes('traitee') || m.includes('traitée')) return new NotFoundError(err.message);
  if (m.includes('createur') || m.includes('créateur') || m.includes('privees') || m.includes('privées') || m.includes('Acces refuse') || m.includes('Accès refusé')) return new ForbiddenError(err.message);
  if (m.includes('signale') || m.includes('signalé')) return new ValidationError(err.message);
  if (m.includes('Champs requis') || m.includes('Plus de places') || m.includes('deja') || m.includes('déjà') || m.includes('amis') || m.includes('Aucune donnee') || m.includes('Aucune donnée') || m.includes('validee') || m.includes('validée')) return new ValidationError(err.message);
  return err;
}

module.exports = function (db) {
  const express = require('express');
  const router = express.Router();
  const controller = new AnnouncementsController(db);

  router.get('/announcements',
    validate(schemas.announcementListQuery, 'query'),
    asyncHandler(async (req, res) => {
      const {
        sport_type, status, club_id, user_id, public_place_id,
        public_place_ref, city, date_from, date_to,
      } = req.query;
      const normalizedStatus = status === 'open' ? 'active' : status;
      const announcements = await controller.getPublicAnnouncements({
        sport_type, status: normalizedStatus, club_id, user_id, public_place_id,
        public_place_ref, city, date_from, date_to,
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
      // Mesure : parties publiées par jour × ville × sport (go/no-go phase 1).
      track(db, 'game_published', {
        userId: req.user.id,
        announcementId: announcement?.id,
        placeId: announcement?.public_place_ref,
        city: announcement?.city,
        sport: announcement?.sport_type,
        payload: { places_total: announcement?.places_total, min_participants: announcement?.min_participants },
      });
      // Best-effort : la partie est créée quoi qu'il arrive côté diffusion.
      if (announcement?.visibility !== 'private') {
        notifyNearbyPlayers(db, announcement, req.user.id).catch(() => {});
      }
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
      track(db, 'game_cancelled', {
        userId: req.user.id,
        announcementId: id,
        city: announcement?.city,
        sport: announcement?.sport_type,
        payload: { reason: 'organisateur' },
      });
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
      // Joining clears any waitlist entry of this user.
      queryPromise(db, 'DELETE FROM annonce_waitlist WHERE annonce_id = ? AND user_id = ?', [id, req.user.id]).catch(() => {});
      // Notify the organizer (unless they joined their own session).
      const ann = await queryOne(db,
        `SELECT created_by, city, sport_type, places_total, places_disponibles, min_participants, created_at
         FROM announcements WHERE id = ?`, [id]).catch(() => null);
      if (ann && Number(ann.created_by) !== Number(req.user.id)) {
        notify(db, ann.created_by, 'session_join', {
          announcement_id: id,
          from_user_id: req.user.id,
          from_name: req.user.name || '',
        });
      }
      if (ann) {
        const meta = { userId: req.user.id, announcementId: id, city: ann.city, sport: ann.sport_type };
        track(db, 'game_joined', meta);
        // `game_filled` = le minimum de joueurs est atteint : c'est ce qui donne
        // le délai de remplissage, l'indicateur qui valide (ou non) la fenêtre.
        const taken = Number(ann.places_total) - Number(ann.places_disponibles);
        const min = Number(ann.min_participants) || 2;
        if (taken === min) {
          const hours = ann.created_at
            ? Math.round((Date.now() - new Date(ann.created_at).getTime()) / 36e5)
            : null;
          track(db, 'game_filled', { ...meta, payload: { hours_to_fill: hours, players: taken } });
        }
      }
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
      queryOne(db, 'SELECT city, sport_type FROM announcements WHERE id = ?', [id])
        .then(a => track(db, 'game_left', { userId: req.user.id, announcementId: id, city: a?.city, sport: a?.sport_type }))
        .catch(() => {});
      // A spot just freed up: ping the first waitlisted user not yet notified.
      try {
        const next = await queryOne(db,
          'SELECT user_id FROM annonce_waitlist WHERE annonce_id = ? AND notified_at IS NULL ORDER BY created_at ASC LIMIT 1',
          [id]
        );
        if (next) {
          await queryPromise(db,
            'UPDATE annonce_waitlist SET notified_at = NOW() WHERE annonce_id = ? AND user_id = ?',
            [id, next.user_id]
          );
          notify(db, next.user_id, 'waitlist_spot', { announcement_id: id });
        }
      } catch { /* waitlist promotion is best-effort */ }
      res.json(result);
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  // ── Waitlist (full sessions) ───────────────────────────────────────────────

  router.post('/announcements/:id/waitlist', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const ann = await queryOne(db,
      'SELECT id, created_by, places_disponibles, status FROM announcements WHERE id = ?', [id]);
    if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });
    if (['cancelled', 'expired'].includes(String(ann.status))) {
      return res.status(400).json({ error: 'Cette session est terminée' });
    }
    if (Number(ann.created_by) === Number(req.user.id)) {
      return res.status(400).json({ error: 'Tu organises cette session' });
    }
    if (Number(ann.places_disponibles) > 0) {
      return res.status(400).json({ error: 'Des places sont disponibles — rejoins directement la session' });
    }
    await queryPromise(db,
      'INSERT IGNORE INTO annonce_waitlist (annonce_id, user_id, created_at) VALUES (?, ?, NOW())',
      [id, req.user.id]
    );
    res.status(201).json({ success: true, waitlisted: true });
  }));

  router.delete('/announcements/:id/waitlist', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    await queryPromise(db,
      'DELETE FROM annonce_waitlist WHERE annonce_id = ? AND user_id = ?',
      [id, req.user.id]
    );
    res.json({ success: true, waitlisted: false });
  }));

  // ── Post-match fair-play ratings ───────────────────────────────────────────

  router.post('/announcements/:id/rate-players', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const ratings = Array.isArray(req.body?.ratings) ? req.body.ratings : [];
    if (ratings.length === 0 || ratings.length > 30) {
      return res.status(400).json({ error: 'ratings requis (max 30)' });
    }

    const ann = await queryOne(db,
      'SELECT id, created_by, manual_date, slot_start FROM announcements WHERE id = ?', [id]);
    if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });

    // Only past sessions can be rated.
    const sessionDate = ann.manual_date || ann.slot_start;
    if (sessionDate && new Date(sessionDate) > new Date()) {
      return res.status(400).json({ error: 'La session n\'a pas encore eu lieu' });
    }

    const participants = await queryPromise(db,
      'SELECT user_id FROM annonce_participants WHERE annonce_id = ?', [id]);
    const memberSet = new Set(participants.map(p => Number(p.user_id)));
    memberSet.add(Number(ann.created_by));
    if (!memberSet.has(Number(req.user.id))) {
      return res.status(403).json({ error: 'Réservé aux participants de la session' });
    }

    let saved = 0;
    for (const r of ratings) {
      const ratedId = Number(r?.user_id);
      const rating = Number(r?.rating);
      if (!Number.isFinite(ratedId) || ratedId === Number(req.user.id)) continue;
      if (!memberSet.has(ratedId)) continue;
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) continue;
      await queryPromise(db, `
        INSERT INTO player_ratings (annonce_id, rater_id, rated_user_id, rating, created_at)
        VALUES (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE rating = VALUES(rating), created_at = NOW()
      `, [id, req.user.id, ratedId, rating]);
      saved++;
    }
    res.status(201).json({ success: true, saved });
  }));

  router.get('/announcements/:id/my-ratings', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const rows = await queryPromise(db,
      'SELECT rated_user_id, rating FROM player_ratings WHERE annonce_id = ? AND rater_id = ?',
      [id, req.user.id]
    );
    res.json(rows);
  }));

  router.get('/users/:userId/fairplay', asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'userId invalide' });
    const row = await queryOne(db,
      'SELECT ROUND(AVG(rating), 1) AS avg_rating, COUNT(*) AS count FROM player_ratings WHERE rated_user_id = ?',
      [userId]
    );
    res.json({ avg: row?.avg_rating != null ? Number(row.avg_rating) : null, count: Number(row?.count || 0) });
  }));

  router.get('/announcements/:id/waitlist/me', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const row = await queryOne(db,
      'SELECT id FROM annonce_waitlist WHERE annonce_id = ? AND user_id = ? LIMIT 1',
      [id, req.user.id]
    );
    res.json({ waitlisted: !!row });
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
      for (const r of results) {
        if (r.success) {
          notify(db, r.userId, 'invitation', {
            announcement_id: id,
            from_user_id: req.user.id,
            from_name: req.user.name || '',
          });
        }
      }
      res.status(201).json({ success: true, results, count: results.length });
    } catch (err) {
      throw classifyKnownError(err);
    }
  }));

  // Match conversation: one group chat per announcement, organizer or
  // participant can open it; creation is idempotent (chats.announcement_id).
  router.post('/announcements/:id/chat', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });

    const ann = await queryOne(db,
      'SELECT id, created_by, sport_type, manual_date FROM announcements WHERE id = ?', [id]);
    if (!ann) return res.status(404).json({ error: 'Annonce introuvable' });

    const participants = await queryPromise(db,
      'SELECT user_id FROM annonce_participants WHERE annonce_id = ?', [id]);
    const memberSet = new Set(participants.map(p => Number(p.user_id)));
    memberSet.add(Number(ann.created_by));
    if (!memberSet.has(Number(req.user.id))) {
      return res.status(403).json({ error: 'Réservé aux participants de la session' });
    }

    const existing = await queryOne(db, 'SELECT * FROM chats WHERE announcement_id = ?', [id]);
    if (existing) {
      // Late joiners are added on open.
      await queryPromise(db, `
        INSERT IGNORE INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at)
        VALUES (?, ?, 'member', NOW(), NOW())
      `, [existing.id, req.user.id]);
      return res.json({ ...existing, display_name: existing.name });
    }

    const sport = String(ann.sport_type || 'match');
    const name = `Match ${sport.charAt(0).toUpperCase()}${sport.slice(1)}${ann.manual_date ? ` · ${String(ann.manual_date).slice(0, 10)}` : ''}`.slice(0, 100);
    const chatId = await insert(db,
      "INSERT INTO chats (type, name, status, announcement_id, created_at) VALUES ('group', ?, 'accepted', ?, NOW())",
      [name, id]
    );
    const members = [...memberSet];
    const values = members.map(uid => [chatId, uid, Number(uid) === Number(ann.created_by) ? 'admin' : 'member']);
    const placeholders = values.map(() => '(?, ?, ?, NOW(), NOW())').join(', ');
    await queryPromise(db,
      `INSERT INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at) VALUES ${placeholders}`,
      values.flat()
    );
    for (const uid of members) {
      if (Number(uid) !== Number(req.user.id)) sseHub.push(uid, 'message', { chat_id: chatId });
    }
    const chat = await queryOne(db, 'SELECT * FROM chats WHERE id = ?', [chatId]);
    res.status(201).json({ ...chat, display_name: name });
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
