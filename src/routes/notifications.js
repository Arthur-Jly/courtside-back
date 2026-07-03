const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { queryPromise, queryOne } = require('../utils/dbHelpers');

module.exports = (db) => {
  const router = express.Router();

  router.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
    const rows = await queryPromise(db, `
      SELECT id, type, payload, read_at, created_at
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.id]);
    res.json(rows.map(r => ({
      ...r,
      payload: typeof r.payload === 'string' ? (() => { try { return JSON.parse(r.payload); } catch { return null; } })() : r.payload,
    })));
  }));

  // Single cheap endpoint for the header polling: unread notifications
  // + unread chat messages.
  router.get('/notifications/summary', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const notif = await queryOne(db,
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
    const msgs = await queryOne(db, `
      SELECT COUNT(*) AS n
      FROM messages m
      JOIN chat_participants cp ON cp.chat_id = m.chat_id AND cp.user_id = ?
      WHERE m.sender_id != ?
        AND m.created_at > COALESCE(cp.last_read_at, '1970-01-01')
    `, [userId, userId]);
    res.json({ unread_notifications: Number(notif?.n || 0), unread_messages: Number(msgs?.n || 0) });
  }));

  router.put('/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
    await queryPromise(db,
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ success: true });
  }));

  router.put('/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    await queryPromise(db,
      'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    res.json({ success: true });
  }));

  return router;
};
