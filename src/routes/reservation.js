const express = require('express');
const { requireAuth, requireClubAdmin } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

module.exports = function(db) {
  const router = express.Router();

  // List reservations for a user
  router.get('/users/:id/reservations', requireAuth, asyncHandler(async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (req.user.id !== userId) return res.status(403).json({ error: 'Accès refusé' });
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
    `, [userId]);
    res.json(rows || []);
  }));

  // List reservations for a club (club admin only)
  router.get('/clubs/:id/reservations', requireAuth, requireClubAdmin, asyncHandler(async (req, res) => {
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
    `, [req.params.id]);
    res.json(rows || []);
  }));

  // Reservation details
  router.get('/reservations/:id', requireAuth, asyncHandler(async (req, res) => {
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
    `, [req.params.id]);
    if (!reservation) throw new NotFoundError('Réservation non trouvée');
    if (req.user.id !== reservation.user_id && req.user.role !== 'club_admin') {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const participants = await queryPromise(db,
      'SELECT id, user_id, name FROM reservation_participants WHERE reservation_id = ?',
      [req.params.id]
    );
    reservation.participants = participants || [];
    res.json(reservation);
  }));

  // List participants for a reservation
  router.get('/reservations/:id/participants', requireAuth, asyncHandler(async (req, res) => {
    const rows = await queryPromise(db,
      'SELECT id, reservation_id, user_id, name, created_at FROM reservation_participants WHERE reservation_id = ?',
      [req.params.id]
    );
    res.json(rows || []);
  }));

  // Add a participant to a reservation
  router.post('/reservations/:id/participants', requireAuth, asyncHandler(async (req, res) => {
    const { user_id, name } = req.body || {};
    if (!name && !user_id) return res.status(400).json({ error: 'user_id or name required' });
    const id = await insert(db,
      'INSERT INTO reservation_participants (reservation_id, user_id, name, created_at) VALUES (?, ?, ?, NOW())',
      [req.params.id, user_id || null, name || null]
    );
    res.json({ ok: true, id });
  }));

  return router;
};
