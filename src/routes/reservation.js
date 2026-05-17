const express = require('express');
const { requireAuth, requireOwnClub } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

module.exports = function (db) {
  const router = express.Router();

  router.get('/users/:id/reservations', requireAuth, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'id invalide' });
    if (req.user.id !== userId) throw new ForbiddenError();
    const rows = await queryPromise(db, `
      SELECT
        r.id AS id, r.status AS status, r.created_at AS created_at, r.price,
        DATE(r.start_time) AS date, TIME(r.start_time) AS start_time, TIME(r.end_time) AS end_time,
        r.terrain_id, t.name AS terrain_name, t.sport_type, t.club_id,
        c.name AS club_name, c.address, c.city,
        (SELECT COUNT(*) FROM reservation_participants rp WHERE rp.reservation_id = r.id) AS participants_count
      FROM reservations r
      JOIN terrains t ON r.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      WHERE r.user_id = ?
      ORDER BY r.start_time DESC
      LIMIT 200
    `, [userId]);
    res.json(rows || []);
  }));

  router.get('/clubs/:id/reservations', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const rows = await queryPromise(db, `
      SELECT r.id AS reservation_id, s.id AS slot_id, r.user_id, r.status AS reservation_status,
             r.created_at AS reservation_created_at, s.date, s.start_time, s.end_time, s.terrain_id,
             t.name AS terrain_name, t.club_id, u.name AS user_name, u.email AS user_email, r.price
      FROM reservations r
      JOIN slots s ON s.reservation_id = r.id
      JOIN terrains t ON s.terrain_id = t.id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE t.club_id = ?
      ORDER BY s.date DESC, s.start_time DESC
      LIMIT 1000
    `, [Number(req.params.id)]);
    res.json(rows || []);
  }));

  router.get('/reservations/:id', requireAuth, asyncHandler(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) return res.status(400).json({ error: 'id invalide' });

    const reservation = await queryOne(db, `
      SELECT r.id AS reservation_id, s.id AS slot_id, r.user_id, r.status AS reservation_status,
             r.created_at AS reservation_created_at, s.date, s.start_time, s.end_time, s.terrain_id,
             t.name AS terrain_name, t.club_id, c.name AS club_name, c.address, c.city
      FROM reservations r
      JOIN slots s ON s.reservation_id = r.id
      JOIN terrains t ON s.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      WHERE r.id = ?
      LIMIT 1
    `, [reservationId]);
    if (!reservation) throw new NotFoundError('Réservation non trouvée');

    const isOwner = req.user.id === reservation.user_id;
    const isClubAdminOfThisClub = req.user.role === 'club_admin' && Number(req.user.club_id) === Number(reservation.club_id);
    if (!isOwner && !isClubAdminOfThisClub) throw new ForbiddenError();

    const participants = await queryPromise(
      db,
      'SELECT id, user_id, name FROM reservation_participants WHERE reservation_id = ?',
      [reservationId],
    );
    reservation.participants = participants || [];
    res.json(reservation);
  }));

  router.get('/reservations/:id/participants', requireAuth, asyncHandler(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) return res.status(400).json({ error: 'id invalide' });

    // Only the reservation owner, a participant, or the club admin may view participants.
    const meta = await queryOne(db, `
      SELECT r.user_id, t.club_id
      FROM reservations r
      JOIN terrains t ON r.terrain_id = t.id
      WHERE r.id = ? LIMIT 1
    `, [reservationId]);
    if (!meta) throw new NotFoundError('Réservation non trouvée');

    const isOwner = req.user.id === meta.user_id;
    const isClubAdmin = req.user.role === 'club_admin' && Number(req.user.club_id) === Number(meta.club_id);
    if (!isOwner && !isClubAdmin) {
      // Allow if user is among the participants
      const member = await queryOne(
        db,
        'SELECT 1 AS ok FROM reservation_participants WHERE reservation_id = ? AND user_id = ? LIMIT 1',
        [reservationId, req.user.id],
      );
      if (!member) throw new ForbiddenError();
    }

    const rows = await queryPromise(db,
      'SELECT id, reservation_id, user_id, name, created_at FROM reservation_participants WHERE reservation_id = ?',
      [reservationId]);
    res.json(rows || []);
  }));

  router.post('/reservations/:id/participants', requireAuth, asyncHandler(async (req, res) => {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) return res.status(400).json({ error: 'id invalide' });

    const reservation = await queryOne(db, 'SELECT user_id FROM reservations WHERE id = ? LIMIT 1', [reservationId]);
    if (!reservation) throw new NotFoundError('Réservation non trouvée');
    if (reservation.user_id !== req.user.id) throw new ForbiddenError("Seul l'organisateur peut ajouter un participant");

    const { user_id, name } = req.body || {};
    if (!name && !user_id) return res.status(400).json({ error: 'user_id or name required' });
    const id = await insert(db,
      'INSERT INTO reservation_participants (reservation_id, user_id, name, created_at) VALUES (?, ?, ?, NOW())',
      [reservationId, user_id || null, name ? String(name).slice(0, 100) : null]);
    res.json({ ok: true, id });
  }));

  return router;
};
