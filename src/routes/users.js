const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

module.exports = (db) => {
  const router = express.Router();

  // Add a club to favorites
  router.post('/favorites', requireAuth, asyncHandler(async (req, res) => {
    const user_id = req.user.id;
    const { terrain_id } = req.body;
    if (!terrain_id) return res.status(400).json({ error: 'terrain_id requis' });
    await queryPromise(db,
      'INSERT IGNORE INTO favorites (user_id, terrain_id, created_at) VALUES (?, ?, NOW())',
      [user_id, terrain_id]
    );
    res.json({ success: true });
  }));

  // Remove a club from favorites
  router.delete('/favorites', requireAuth, asyncHandler(async (req, res) => {
    const user_id = req.user.id;
    const { terrain_id } = req.body;
    if (!terrain_id) return res.status(400).json({ error: 'terrain_id requis' });
    await queryPromise(db,
      'DELETE FROM favorites WHERE user_id = ? AND terrain_id = ?',
      [user_id, terrain_id]
    );
    res.json({ success: true });
  }));

  // Get favorites for a user
  router.get('/favorites/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = parseInt(req.params.user_id, 10);
    if (req.user.id !== user_id) return res.status(403).json({ error: 'Accès refusé' });
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

  // Search users with friendship status — MUST be before /users/:id
  router.get('/users/search', requireAuth, asyncHandler(async (req, res) => {
    const query = req.query.query || req.query.q;
    const currentUserId = req.user.id;
    if (!query) return res.status(400).json({ error: 'query required' });
    const users = await queryPromise(db, `
      SELECT u.id, u.name, a.status as friendship_status
      FROM users u
      LEFT JOIN amis a ON (
        (a.user_id_1 = ? AND a.user_id_2 = u.id) OR
        (a.user_id_1 = u.id AND a.user_id_2 = ?)
      )
      WHERE u.name LIKE ? AND u.id != ?
      LIMIT 20
    `, [currentUserId, currentUserId, `%${query}%`, currentUserId]);
    res.json(users);
  }));

  // Get user_profiles details
  router.get('/users/:id/profile', asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const user = await queryOne(db, 'SELECT id, name, username FROM users WHERE id = ?', [id]);
    if (!user) throw new NotFoundError('Utilisateur non trouvé');
    const profile = await queryOne(db, 'SELECT * FROM user_profiles WHERE user_id = ?', [id]);
    res.json({
      profile: profile
        ? { ...profile, is_public: Number(profile.is_public) === 1, user_name: user.name, username: user.username }
        : { user_id: id, is_public: false, user_name: user.name, username: user.username },
    });
  }));

  // Upsert user_profiles details
  router.put('/users/:id/profile', requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (req.user.id !== id) return res.status(403).json({ error: 'Accès refusé' });
    const { bio, city, birthdate, sports, is_public } = req.body;
    const existing = await queryOne(db, 'SELECT user_id FROM user_profiles WHERE user_id = ?', [id]);
    if (existing) {
      await queryPromise(db,
        'UPDATE user_profiles SET bio = ?, city = ?, birthdate = ?, sports = ?, is_public = ?, updated_at = NOW() WHERE user_id = ?',
        [bio || null, city || null, birthdate || null, sports || null, is_public ? 1 : 0, id]
      );
    } else {
      await queryPromise(db,
        'INSERT INTO user_profiles (user_id, bio, city, birthdate, sports, is_public, updated_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
        [id, bio || null, city || null, birthdate || null, sports || null, is_public ? 1 : 0]
      );
    }
    res.json({ success: true });
  }));

  // Update user profile
  router.put('/users/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (req.user.id !== id) return res.status(403).json({ error: 'Accès refusé' });
    const { name, email } = req.body;
    const updates = [];
    const vals = [];
    if (name) { updates.push('name = ?'); vals.push(name); }
    if (email) { updates.push('email = ?'); vals.push(email); }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    vals.push(id);
    const result = await queryPromise(db,
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals
    );
    if (result.affectedRows === 0) throw new NotFoundError('Utilisateur non trouvé');
    res.json({ success: true });
  }));

  // Get user by ID (public profile)
  router.get('/users/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
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

  // Check friendship status between two users
  router.get('/friendship-status', requireAuth, asyncHandler(async (req, res) => {
    const { user_id_1, user_id_2 } = req.query;
    if (!user_id_1 || !user_id_2) return res.status(400).json({ error: 'user_id_1 and user_id_2 are required' });
    if (req.user.id !== parseInt(user_id_1, 10) && req.user.id !== parseInt(user_id_2, 10)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const row = await queryOne(db, `
      SELECT status FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?)
         OR (user_id_1 = ? AND user_id_2 = ?)
    `, [user_id_1, user_id_2, user_id_2, user_id_1]);
    res.json({ status: row ? row.status : 'none' });
  }));

  // Send a friend request
  router.post('/friend-request', requireAuth, asyncHandler(async (req, res) => {
    const userId1 = req.user.id;
    const userId2 = req.body.to_user_id || req.body.user_id_2;
    if (!userId2) return res.status(400).json({ error: 'to_user_id required' });
    if (String(userId1) === String(userId2)) return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    const existing = await queryOne(db, `
      SELECT * FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?)
         OR (user_id_1 = ? AND user_id_2 = ?)
    `, [userId1, userId2, userId2, userId1]);
    if (existing) return res.status(400).json({ error: 'Relation already exists', status: existing.status });
    await insert(db, "INSERT INTO amis (user_id_1, user_id_2, status) VALUES (?, ?, 'pending')", [userId1, userId2]);
    res.json({ success: true, status: 'pending' });
  }));

  // Accept / reject a friend request
  router.put('/friend-request/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status must be accepted or rejected' });
    const result = await queryPromise(db,
      'UPDATE amis SET status = ? WHERE id = ? AND user_id_2 = ?',
      [status, id, req.user.id]
    );
    if (result.affectedRows === 0) throw new NotFoundError('Friend request not found');
    res.json({ success: true, status });
  }));

  // Cancel / delete a friend request
  router.delete('/friend-request/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await queryPromise(db,
      'DELETE FROM amis WHERE id = ? AND user_id_1 = ? AND status = "pending"',
      [id, req.user.id]
    );
    if (result.affectedRows === 0) throw new NotFoundError('Friend request not found or already processed');
    res.json({ success: true });
  }));

  // Get sent (pending) friend requests
  router.get('/friend-requests/sent/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = parseInt(req.params.user_id, 10);
    if (req.user.id !== user_id) return res.status(403).json({ error: 'Accès refusé' });
    const requests = await queryPromise(db, `
      SELECT a.id, a.status, a.created_at, u.id as receiver_id, u.name as receiver_name
      FROM amis a JOIN users u ON a.user_id_2 = u.id
      WHERE a.user_id_1 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `, [user_id]);
    res.json(requests);
  }));

  // Get received friend requests
  router.get('/friend-requests/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = parseInt(req.params.user_id, 10);
    if (req.user.id !== user_id) return res.status(403).json({ error: 'Accès refusé' });
    const requests = await queryPromise(db, `
      SELECT a.id, a.status, a.created_at, u.id as sender_id, u.name as sender_name
      FROM amis a JOIN users u ON a.user_id_1 = u.id
      WHERE a.user_id_2 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `, [user_id]);
    res.json(requests);
  }));

  // Get friends list
  router.get('/friends/:user_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = parseInt(req.params.user_id, 10);
    if (req.user.id !== user_id) return res.status(403).json({ error: 'Accès refusé' });
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

  // Delete a friendship
  router.delete('/friends/:user_id/:friend_id', requireAuth, asyncHandler(async (req, res) => {
    const user_id = parseInt(req.params.user_id, 10);
    const friend_id = parseInt(req.params.friend_id, 10);
    if (req.user.id !== user_id && req.user.id !== friend_id) return res.status(403).json({ error: 'Accès refusé' });
    const result = await queryPromise(db, `
      DELETE FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?)
    `, [user_id, friend_id, friend_id, user_id]);
    if (result.affectedRows === 0) throw new NotFoundError('Relation non trouvée');
    res.json({ success: true });
  }));

  return router;
};
