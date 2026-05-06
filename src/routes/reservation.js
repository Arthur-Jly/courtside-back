const express = require('express');

module.exports = function(db){
  const router = express.Router();

  // List reservations for a user (with slot / terrain / club info)
  router.get('/users/:id/reservations', (req, res) => {
    const userId = req.params.id;
    const sql = `
      SELECT 
        r.id AS id, 
        r.status AS status, 
        r.created_at AS created_at,
        r.price,
        DATE(r.start_time) AS date,
        TIME(r.start_time) AS start_time,
        TIME(r.end_time) AS end_time,
        r.terrain_id,
        t.name AS terrain_name, 
        t.sport_type,
        t.club_id,
        c.name AS club_name, 
        c.address, 
        c.city,
        (
          SELECT COUNT(*)
          FROM reservation_participants rp
          WHERE rp.reservation_id = r.id
        ) AS participants_count
      FROM reservations r
      JOIN terrains t ON r.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      WHERE r.user_id = ?
      ORDER BY r.start_time DESC
    `;
    db.query(sql, [userId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erreur listing reservations', details: err });
      res.json(rows || []);
    });
  });

  // List reservations for a club (with slot / terrain / user info)
  router.get('/clubs/:id/reservations', (req, res) => {
    const clubId = req.params.id;
    const sql = `
      SELECT r.id AS reservation_id, s.id AS slot_id, r.user_id, r.status AS reservation_status, r.created_at AS reservation_created_at,
             s.date, s.start_time, s.end_time, s.terrain_id,
             t.name AS terrain_name, t.club_id,
             u.name AS user_name, u.email AS user_email,
             r.price
      FROM reservations r
      JOIN slots s ON s.reservation_id = r.id
      JOIN terrains t ON s.terrain_id = t.id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE t.club_id = ?
      ORDER BY s.date DESC, s.start_time DESC
    `;
    db.query(sql, [clubId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erreur listing club reservations', details: err });
      res.json(rows || []);
    });
  });

  // Reservation details
  router.get('/reservations/:id', (req, res) => {
    const id = req.params.id;
    const sql = `
      SELECT r.id AS reservation_id, s.id AS slot_id, r.user_id, r.status AS reservation_status, r.created_at AS reservation_created_at,
             s.date, s.start_time, s.end_time, s.terrain_id,
             t.name AS terrain_name, t.club_id,
             c.name AS club_name, c.address, c.city
      FROM reservations r
      JOIN slots s ON s.reservation_id = r.id
      JOIN terrains t ON s.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id AND c.status = 'confirme'
      WHERE r.id = ?
      LIMIT 1
    `;
    db.query(sql, [id], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erreur reservation details', details: err });
      if (!rows || rows.length === 0) return res.status(404).json({ error: 'reservation not found' });
      const reservation = rows[0];
      // load participants
      db.query('SELECT id, user_id, name, email FROM reservation_participants WHERE reservation_id = ?', [id], (err2, parts) => {
        if (err2) return res.status(500).json({ error: 'Erreur participants', details: err2 });
        reservation.participants = parts || [];
        res.json(reservation);
      });
    });
  });

  // List participants for a reservation
  router.get('/reservations/:id/participants', (req, res) => {
    const reservationId = req.params.id;
    const sql = `SELECT id, reservation_id, user_id, name, email, created_at FROM reservation_participants WHERE reservation_id = ?`;
    db.query(sql, [reservationId], (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erreur participants', details: err });
      res.json(rows || []);
    });
  });

  // Add a participant to a reservation (body: { user_id?, name, email? })
  router.post('/reservations/:id/participants', (req, res) => {
    const reservationId = req.params.id;
    const { user_id, name, email } = req.body || {};
    if (!name && !user_id) return res.status(400).json({ error: 'user_id or name required' });
    const sql = `INSERT INTO reservation_participants (reservation_id, user_id, name, email, created_at) VALUES (?, ?, ?, ?, NOW())`;
    db.query(sql, [reservationId, user_id || null, name || null, email || null], (err, result) => {
      if (err) return res.status(500).json({ error: 'Erreur insert participant', details: err });
      res.json({ ok: true, id: result.insertId });
    });
  });

  return router;
};
