const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError, ConflictError } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = (db) => {
  const router = express.Router();

  router.get('/reviews/clubs/:clubId', asyncHandler(async (req, res) => {
    const clubId = Number(req.params.clubId);
    if (!Number.isFinite(clubId)) return res.status(400).json({ error: 'clubId invalide' });
    const reviews = await queryPromise(db, `
      SELECT r.id, r.user_id, r.club_id, r.public_place_id, r.rating, r.comment, r.response, r.created_at,
             u.name AS user_name, u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.club_id = ?
      ORDER BY r.created_at DESC
      LIMIT 200
    `, [clubId]);
    res.json(reviews);
  }));

  router.get('/reviews/public-places/:publicPlaceId', asyncHandler(async (req, res) => {
    const id = String(req.params.publicPlaceId).slice(0, 255);
    const reviews = await queryPromise(db, `
      SELECT r.id, r.user_id, r.club_id, r.public_place_id, r.rating, r.comment, r.response, r.created_at,
             u.name AS user_name, u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.public_place_id = ?
      ORDER BY r.created_at DESC
      LIMIT 200
    `, [id]);
    res.json(reviews);
  }));

  const statsSql = (col) => `
    SELECT COUNT(*) AS total_reviews, AVG(rating) AS average_rating,
           SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five_stars,
           SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four_stars,
           SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three_stars,
           SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two_stars,
           SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one_star
    FROM reviews WHERE ${col} = ?`;

  const shapeStats = (row) => ({
    total_reviews: Number(row.total_reviews) || 0,
    average_rating: Number(row.average_rating) || 0,
    five_stars: Number(row.five_stars) || 0,
    four_stars: Number(row.four_stars) || 0,
    three_stars: Number(row.three_stars) || 0,
    two_stars: Number(row.two_stars) || 0,
    one_star: Number(row.one_star) || 0,
  });

  router.get('/reviews/clubs/:clubId/stats', asyncHandler(async (req, res) => {
    const clubId = Number(req.params.clubId);
    if (!Number.isFinite(clubId)) return res.status(400).json({ error: 'clubId invalide' });
    const row = (await queryPromise(db, statsSql('club_id'), [clubId]))[0] || {};
    res.json(shapeStats(row));
  }));

  router.get('/reviews/public-places/:publicPlaceId/stats', asyncHandler(async (req, res) => {
    const id = String(req.params.publicPlaceId).slice(0, 255);
    const row = (await queryPromise(db, statsSql('public_place_id'), [id]))[0] || {};
    res.json(shapeStats(row));
  }));

  router.get('/reviews/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const r = await queryOne(db, `
      SELECT r.id, r.user_id, r.club_id, r.public_place_id, r.rating, r.comment, r.response, r.created_at,
             u.name AS user_name, u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `, [id]);
    if (!r) throw new NotFoundError('Avis non trouvé');
    res.json(r);
  }));

  router.post('/reviews', requireAuth, writeLimiter, validate(schemas.reviewCreate), asyncHandler(async (req, res) => {
    const { club_id, public_place_id, rating, comment } = req.body;
    const userId = req.user.id;

    // One review per (user, target) — prevent spam.
    if (club_id) {
      const dup = await queryOne(db, 'SELECT id FROM reviews WHERE user_id = ? AND club_id = ?', [userId, club_id]);
      if (dup) throw new ConflictError('Vous avez déjà publié un avis pour ce club.');
    } else if (public_place_id) {
      const dup = await queryOne(db, 'SELECT id FROM reviews WHERE user_id = ? AND public_place_id = ?', [userId, public_place_id]);
      if (dup) throw new ConflictError('Vous avez déjà publié un avis pour ce lieu.');
    }

    const id = await insert(db, `
      INSERT INTO reviews (user_id, club_id, public_place_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [userId, club_id || null, public_place_id || null, rating, comment]);
    res.status(201).json({ success: true, id });
  }));

  router.put('/reviews/:id', requireAuth, validate(schemas.reviewUpdate), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const row = await queryOne(db, 'SELECT user_id FROM reviews WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Avis non trouvé');
    if (row.user_id !== req.user.id) throw new ForbiddenError();

    const { rating, comment } = req.body;
    const updates = [];
    const vals = [];
    if (rating !== undefined) { updates.push('rating = ?'); vals.push(rating); }
    if (comment !== undefined) { updates.push('comment = ?'); vals.push(comment); }
    vals.push(id);
    await queryPromise(db, `UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
  }));

  router.put('/reviews/:id/response', requireAuth, validate(schemas.reviewResponse), asyncHandler(async (req, res) => {
    if (req.user.role !== 'club_admin') throw new ForbiddenError('Réservé aux admins de club');
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const row = await queryOne(db, 'SELECT club_id FROM reviews WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Avis non trouvé');
    if (!row.club_id || Number(row.club_id) !== Number(req.user.club_id)) throw new ForbiddenError();
    await queryPromise(db, 'UPDATE reviews SET response = ? WHERE id = ?', [req.body.response, id]);
    res.json({ success: true });
  }));

  router.delete('/reviews/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const row = await queryOne(db, 'SELECT user_id FROM reviews WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Avis non trouvé');
    if (row.user_id !== req.user.id) throw new ForbiddenError();
    await queryPromise(db, 'DELETE FROM reviews WHERE id = ?', [id]);
    res.json({ success: true });
  }));

  router.get('/reviews/users/:userId', asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'userId invalide' });
    const reviews = await queryPromise(db, `
      SELECT r.id, r.user_id, r.club_id, r.rating, r.comment, r.response, r.created_at,
             c.name AS club_name, c.city AS club_city
      FROM reviews r
      LEFT JOIN clubs c ON r.club_id = c.id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
      LIMIT 200
    `, [userId]);
    res.json(reviews);
  }));

  return router;
};
