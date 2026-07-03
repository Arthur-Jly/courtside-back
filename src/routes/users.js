const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');
const { validate, schemas } = require('../middleware/validation');
const { notify } = require('../utils/notify');

module.exports = (db) => {
  const router = express.Router();

  const idParam = (req, name = 'id') => {
    const v = Number(req.params[name]);
    return Number.isFinite(v) ? v : null;
  };

  // RGPD data portability: everything we hold about the requesting user.
  router.get('/users/me/export', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const grab = async (sql, params) => {
      try { return await queryPromise(db, sql, params); } catch { return []; }
    };

    const [user] = await grab('SELECT id, name, email, username, role, created_at FROM users WHERE id = ?', [userId]);
    const profile = await grab('SELECT bio, city, birthdate, sports, is_public FROM user_profiles WHERE user_id = ?', [userId]);
    const reservations = await grab('SELECT id, terrain_id, start_time, end_time, price, status, created_at FROM reservations WHERE user_id = ?', [userId]);
    const favorites = await grab('SELECT terrain_id, created_at FROM favorites WHERE user_id = ?', [userId]);
    const friends = await grab('SELECT user_id_1, user_id_2, status FROM amis WHERE user_id_1 = ? OR user_id_2 = ?', [userId, userId]);
    const announcements = await grab('SELECT id, sport_type, level, places_total, status, created_at FROM announcements WHERE created_by = ?', [userId]);
    const messages = await grab('SELECT m.chat_id, m.content, m.message_type, m.created_at FROM messages m WHERE m.sender_id = ? ORDER BY m.created_at LIMIT 5000', [userId]);
    const notifications = await grab('SELECT type, payload, read_at, created_at FROM notifications WHERE user_id = ?', [userId]);

    res.setHeader('Content-Disposition', 'attachment; filename="courtside-export.json"');
    res.json({
      exported_at: new Date().toISOString(),
      user: user || null,
      profile: profile[0] || null,
      reservations, favorites, friends, announcements, messages, notifications,
    });
  }));

  // RGPD account deletion: purge personal data, anonymize what must stay
  // for other users' history (messages, past sessions).
  router.delete('/users/me', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const purge = async (sql, params) => {
      try { await queryPromise(db, sql, params); } catch { /* table/rows may not exist */ }
    };

    await purge('DELETE FROM favorites WHERE user_id = ?', [userId]);
    await purge('DELETE FROM amis WHERE user_id_1 = ? OR user_id_2 = ?', [userId, userId]);
    await purge('DELETE FROM annonce_invitations WHERE user_id = ? OR invited_by = ?', [userId, userId]);
    await purge('DELETE FROM password_resets WHERE user_id = ?', [userId]);
    await purge('DELETE FROM annonce_participants WHERE user_id = ?', [userId]);

    // Anonymize the account: keeps FK integrity, kills login and PII.
    await queryPromise(db, `
      UPDATE users SET
        name = 'Utilisateur supprimé',
        email = CONCAT('deleted-', id, '@deleted.invalid'),
        username = NULL,
        password_hash = 'account-deleted',
        avatar = NULL
      WHERE id = ?
    `, [userId]);

    res.json({ success: true });
  }));

  router.post('/favorites', requireAuth, validate(schemas.addFavorite), asyncHandler(async (req, res) => {
    const user_id = req.user.id;
    const { terrain_id } = req.body;
    await queryPromise(db,
      'INSERT IGNORE INTO favorites (user_id, terrain_id, created_at) VALUES (?, ?, NOW())',
      [user_id, terrain_id]
    );
    res.json({ success: true });
  }));

  router.delete('/favorites', requireAuth, validate(schemas.removeFavorite), asyncHandler(async (req, res) => {
    const user_id = req.user.id;
    const { terrain_id } = req.body;
    await queryPromise(db,
      'DELETE FROM favorites WHERE user_id = ? AND terrain_id = ?',
      [user_id, terrain_id]
    );
    res.json({ success: true });
  }));

  router.get('/favorites/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = idParam(req, 'user_id');
    if (user_id === null) return res.status(400).json({ error: 'user_id invalide' });
    if (req.user.id !== user_id) throw new ForbiddenError();
    const clubs = await queryPromise(db, `
      SELECT c.id, c.name, c.address, c.city, c.lat, c.lon, c.rating,
        GROUP_CONCAT(DISTINCT cs.sport_name) AS sports,
        GROUP_CONCAT(DISTINCT ci.image_url) AS images
      FROM favorites f
      JOIN clubs c ON f.terrain_id = c.id
      LEFT JOIN club_sports cs ON c.id = cs.club_id
      LEFT JOIN club_images ci ON c.id = ci.club_id
      WHERE f.user_id = ? AND c.status = 'confirme'
      GROUP BY c.id
    `, [user_id]);
    res.json(clubs.map(club => ({
      ...club,
      sports: club.sports ? club.sports.split(',') : [],
      images: club.images ? club.images.split(',') : [],
    })));
  }));

  router.get('/users/search', requireAuth, asyncHandler(async (req, res) => {
    const raw = String(req.query.query || req.query.q || '').trim();
    if (raw.length < 2 || raw.length > 100) return res.status(400).json({ error: 'query invalide' });
    // Escape LIKE wildcards so user input cannot widen the match.
    const escaped = raw.replace(/[\\%_]/g, m => `\\${m}`);
    const currentUserId = req.user.id;
    const users = await queryPromise(db, `
      SELECT u.id, u.name, a.status as friendship_status
      FROM users u
      LEFT JOIN amis a ON (
        (a.user_id_1 = ? AND a.user_id_2 = u.id) OR
        (a.user_id_1 = u.id AND a.user_id_2 = ?)
      )
      WHERE u.name LIKE ? AND u.id != ?
      LIMIT 20
    `, [currentUserId, currentUserId, `%${escaped}%`, currentUserId]);
    res.json(users);
  }));

  router.get('/users/:id/profile', asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    const user = await queryOne(db, 'SELECT id, name, username FROM users WHERE id = ?', [id]);
    if (!user) throw new NotFoundError('Utilisateur non trouvé');
    const profile = await queryOne(db, 'SELECT * FROM user_profiles WHERE user_id = ?', [id]);
    res.json({
      profile: profile
        ? { ...profile, is_public: Number(profile.is_public) === 1, user_name: user.name, username: user.username }
        : { user_id: id, is_public: false, user_name: user.name, username: user.username },
    });
  }));

  router.put('/users/:id/profile', requireAuth, validate(schemas.profileUpdate), asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    if (req.user.id !== id) throw new ForbiddenError();
    const { bio, city, birthdate, sports, is_public } = req.body;
    const sportsValue = Array.isArray(sports) ? sports.join(',') : (sports || null);
    const existing = await queryOne(db, 'SELECT user_id FROM user_profiles WHERE user_id = ?', [id]);
    if (existing) {
      await queryPromise(db,
        'UPDATE user_profiles SET bio = ?, city = ?, birthdate = ?, sports = ?, is_public = ?, updated_at = NOW() WHERE user_id = ?',
        [bio || null, city || null, birthdate || null, sportsValue, is_public ? 1 : 0, id]
      );
    } else {
      await queryPromise(db,
        'INSERT INTO user_profiles (user_id, bio, city, birthdate, sports, is_public, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [id, bio || null, city || null, birthdate || null, sportsValue, is_public ? 1 : 0]
      );
    }
    res.json({ success: true });
  }));

  router.put('/users/:id', requireAuth, validate(schemas.userUpdate), asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    if (req.user.id !== id) throw new ForbiddenError();
    const { name, email } = req.body;
    const updates = [];
    const vals = [];
    if (name) { updates.push('name = ?'); vals.push(name); }
    if (email) { updates.push('email = ?'); vals.push(email); }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    vals.push(id);
    const result = await queryPromise(db, `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals);
    if (result.affectedRows === 0) throw new NotFoundError('Utilisateur non trouvé');
    res.json({ success: true });
  }));

  router.get('/users/:id', asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    const user = await queryOne(db,
      'SELECT id, name, role, created_at FROM users WHERE id = ?', [id]
    );
    if (!user) throw new NotFoundError('Utilisateur non trouvé');
    const stats = await queryOne(db,
      'SELECT COUNT(*) as total_reservations FROM reservations WHERE user_id = ?', [id]
    );
    res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      avatar: null,
      location: null,
      bio: null,
      favoriteSport: null,
      memberSince: user.created_at ? new Date(user.created_at).getFullYear().toString() : null,
      totalReservations: stats?.total_reservations ?? 0,
      hoursPlayed: 0,
      rating: null,
    });
  }));

  router.get('/friendship-status', requireAuth, asyncHandler(async (req, res) => {
    const u1 = Number(req.query.user_id_1);
    const u2 = Number(req.query.user_id_2);
    if (!Number.isFinite(u1) || !Number.isFinite(u2)) {
      return res.status(400).json({ error: 'user_id_1 and user_id_2 are required' });
    }
    if (req.user.id !== u1 && req.user.id !== u2) throw new ForbiddenError();
    const row = await queryOne(db, `
      SELECT status FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `, [u1, u2, u2, u1]);
    res.json({ status: row ? row.status : 'none' });
  }));

  router.post('/friend-request', requireAuth, asyncHandler(async (req, res) => {
    const userId1 = req.user.id;
    const userId2 = Number(req.body?.to_user_id ?? req.body?.user_id_2);
    if (!Number.isFinite(userId2)) return res.status(400).json({ error: 'to_user_id required' });
    if (userId1 === userId2) return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    const existing = await queryOne(db, `
      SELECT * FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `, [userId1, userId2, userId2, userId1]);
    if (existing) return res.status(400).json({ error: 'Relation already exists', status: existing.status });
    await insert(db, "INSERT INTO amis (user_id_1, user_id_2, status) VALUES (?, ?, 'pending')", [userId1, userId2]);
    notify(db, userId2, 'friend_request', { from_user_id: userId1, from_name: req.user.name || '' });
    res.json({ success: true, status: 'pending' });
  }));

  router.put('/friend-request/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    const { status } = req.body || {};
    if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be accepted or rejected' });
    const result = await queryPromise(db,
      'UPDATE amis SET status = ? WHERE id = ? AND user_id_2 = ?',
      [status, id, req.user.id]
    );
    if (result.affectedRows === 0) throw new NotFoundError('Friend request not found');
    if (status === 'accepted') {
      const rel = await queryOne(db, 'SELECT user_id_1 FROM amis WHERE id = ?', [id]);
      if (rel) notify(db, rel.user_id_1, 'friend_accept', { from_user_id: req.user.id, from_name: req.user.name || '' });
    }
    res.json({ success: true, status });
  }));

  router.delete('/friend-request/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === null) return res.status(400).json({ error: 'id invalide' });
    const result = await queryPromise(db,
      'DELETE FROM amis WHERE id = ? AND user_id_1 = ? AND status = "pending"',
      [id, req.user.id]
    );
    if (result.affectedRows === 0) throw new NotFoundError('Friend request not found or already processed');
    res.json({ success: true });
  }));

  router.get('/friend-requests/sent/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = idParam(req, 'user_id');
    if (user_id === null) return res.status(400).json({ error: 'user_id invalide' });
    if (req.user.id !== user_id) throw new ForbiddenError();
    const requests = await queryPromise(db, `
      SELECT a.id, a.status, a.created_at, u.id as receiver_id, u.name as receiver_name
      FROM amis a JOIN users u ON a.user_id_2 = u.id
      WHERE a.user_id_1 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `, [user_id]);
    res.json(requests);
  }));

  router.get('/friend-requests/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = idParam(req, 'user_id');
    if (user_id === null) return res.status(400).json({ error: 'user_id invalide' });
    if (req.user.id !== user_id) throw new ForbiddenError();
    const requests = await queryPromise(db, `
      SELECT a.id, a.status, a.created_at, u.id as sender_id, u.name as sender_name
      FROM amis a JOIN users u ON a.user_id_1 = u.id
      WHERE a.user_id_2 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `, [user_id]);
    res.json(requests);
  }));

  router.get('/friends/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = idParam(req, 'user_id');
    if (user_id === null) return res.status(400).json({ error: 'user_id invalide' });
    if (req.user.id !== user_id) throw new ForbiddenError();
    const friends = await queryPromise(db, `
      SELECT u.id, u.name, a.created_at as friends_since
      FROM amis a
      JOIN users u ON (
        CASE WHEN a.user_id_1 = ? THEN a.user_id_2 = u.id ELSE a.user_id_1 = u.id END
      )
      WHERE (a.user_id_1 = ? OR a.user_id_2 = ?) AND a.status = 'accepted'
      ORDER BY a.created_at DESC
    `, [user_id, user_id, user_id]);
    res.json(friends);
  }));

  router.delete('/friends/:user_id/:friend_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = idParam(req, 'user_id');
    const friend_id = idParam(req, 'friend_id');
    if (user_id === null || friend_id === null) return res.status(400).json({ error: 'id invalide' });
    if (req.user.id !== user_id && req.user.id !== friend_id) throw new ForbiddenError();
    const result = await queryPromise(db, `
      DELETE FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `, [user_id, friend_id, friend_id, user_id]);
    if (result.affectedRows === 0) throw new NotFoundError('Relation non trouvée');
    res.json({ success: true });
  }));

  return router;
};
