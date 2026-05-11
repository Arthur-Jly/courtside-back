const express = require('express');
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, path.join(__dirname, '../../uploads'));
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + '-' + file.originalname);
    }
  })
});

module.exports = (db) => {
  const router = express.Router();

  // List chats for the authenticated user
  router.get('/chats', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sql = `
      SELECT
        c.id,
        c.type,
        c.created_at,
        c.closed_at,
        CASE
          WHEN c.type = 'private' THEN (
            SELECT u.name
            FROM chat_participants cp2
            JOIN users u ON cp2.user_id = u.id
            WHERE cp2.chat_id = c.id AND cp2.user_id != ?
            LIMIT 1
          )
          ELSE c.name
        END as display_name,
        CASE
          WHEN c.type = 'private' THEN (
            SELECT u.avatar
            FROM chat_participants cp2
            JOIN users u ON cp2.user_id = u.id
            WHERE cp2.chat_id = c.id AND cp2.user_id != ?
            LIMIT 1
          )
          ELSE NULL
        END as avatar,
        (
          SELECT m.content
          FROM messages m
          WHERE m.chat_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as lastMessage,
        (
          SELECT m.created_at
          FROM messages m
          WHERE m.chat_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as lastMessageTime,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.chat_id = c.id
          AND m.sender_id != ?
          AND m.created_at > COALESCE(
            (SELECT last_read_at FROM chat_participants WHERE chat_id = c.id AND user_id = ?),
            '1970-01-01'
          )
        ) as unreadCount
      FROM chats c
      JOIN chat_participants cp ON c.id = cp.chat_id
      WHERE cp.user_id = ?
      ORDER BY COALESCE(
        (SELECT MAX(created_at) FROM messages WHERE chat_id = c.id),
        c.created_at
      ) DESC
    `;
    const chats = await queryPromise(db, sql, [userId, userId, userId, userId, userId]);
    res.json(chats);
  }));

  // Get messages for a chat
  router.get('/chats/:chat_id/messages', requireAuth, asyncHandler(async (req, res) => {
    const { chat_id } = req.params;
    const sql = `
      SELECT m.id, m.sender_id, u.name as sender_name, m.content, m.created_at, m.file_url, m.file_type,
             m.message_type as type, m.metadata, m.invitation_id
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ?
      ORDER BY m.created_at ASC
    `;
    const messages = await queryPromise(db, sql, [chat_id]);
    const parsed = messages.map(msg => {
      if (msg.metadata && typeof msg.metadata === 'string') {
        try { msg.metadata = JSON.parse(msg.metadata); } catch { /* keep raw */ }
      }
      return msg;
    });
    res.json(parsed);
  }));

  // Get participants of a chat
  router.get('/chats/:chat_id/participants', requireAuth, asyncHandler(async (req, res) => {
    const { chat_id } = req.params;
    const sql = `
      SELECT cp.user_id, cp.role, cp.joined_at, u.name, u.email, u.avatar
      FROM chat_participants cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.chat_id = ?
    `;
    const participants = await queryPromise(db, sql, [chat_id]);
    res.json(participants);
  }));

  // Mark messages as read
  router.post('/chats/:chat_id/mark-read', requireAuth, asyncHandler(async (req, res) => {
    const { chat_id } = req.params;
    const userId = req.user.id;
    await queryPromise(db,
      'UPDATE chat_participants SET last_read_at = NOW() WHERE chat_id = ? AND user_id = ?',
      [chat_id, userId]
    );
    res.json({ success: true });
  }));

  // Delete / leave a chat
  router.delete('/chats/:chat_id', requireAuth, asyncHandler(async (req, res) => {
    const { chat_id } = req.params;
    const userId = req.user.id;
    await queryPromise(db,
      'DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?',
      [chat_id, userId]
    );
    const remaining = await queryOne(db,
      'SELECT COUNT(*) as count FROM chat_participants WHERE chat_id = ?',
      [chat_id]
    );
    if (remaining.count === 0) {
      await queryPromise(db, 'DELETE FROM messages WHERE chat_id = ?', [chat_id]);
      await queryPromise(db, 'DELETE FROM chats WHERE id = ?', [chat_id]);
      return res.json({ success: true, message: 'Chat complètement supprimé' });
    }
    res.json({ success: true, message: 'Utilisateur retiré du chat' });
  }));

  // Create or find an existing private chat between two users
  router.post('/chats', requireAuth, asyncHandler(async (req, res) => {
    const userId1 = req.user.id;
    const { user_id_2 } = req.body;
    if (!user_id_2) {
      return res.status(400).json({ error: 'user_id_2 required' });
    }
    const existing = await queryOne(db, `
      SELECT * FROM chats
      WHERE type = 'private'
        AND id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
        AND id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
      LIMIT 1
    `, [userId1, user_id_2]);
    if (existing) return res.json(existing);

    const chatId = await insert(db,
      "INSERT INTO chats (type, created_at) VALUES ('private', NOW())"
    );
    await queryPromise(db, `
      INSERT INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at)
      VALUES (?, ?, 'member', NOW(), NOW()), (?, ?, 'member', NOW(), NOW())
    `, [chatId, userId1, chatId, user_id_2]);
    const chat = await queryOne(db, 'SELECT * FROM chats WHERE id = ?', [chatId]);
    res.json(chat);
  }));

  // Send a message (text or file)
  router.post('/chats/:chat_id/messages', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    const { chat_id } = req.params;
    const senderId = req.user.id;
    const { content, file_type } = req.body;
    const file_url = req.file ? `/uploads/${req.file.filename}` : null;

    if ((!content || content.trim() === '') && !file_url) {
      return res.status(400).json({ error: 'Le message doit contenir du texte ou un fichier.' });
    }
    const messageId = await insert(db, `
      INSERT INTO messages (chat_id, sender_id, content, created_at, file_url, file_type)
      VALUES (?, ?, ?, NOW(), ?, ?)
    `, [chat_id, senderId, content || null, file_url, file_type || null]);
    res.json({ success: true, message_id: messageId, file_url });
  }));

  return router;
};
