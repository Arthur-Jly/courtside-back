const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, ForbiddenError } = require('../middleware/errorHandler');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');

const UPLOAD_DIR = path.join(__dirname, '../../uploads/chats');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
]);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXT.has(ext) ? ext : '';
      cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new Error('Type de fichier non autorisé'));
    }
    cb(null, true);
  },
});

async function assertChatMember(db, chatId, userId) {
  const row = await queryOne(
    db,
    'SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ? LIMIT 1',
    [chatId, userId],
  );
  if (!row) throw new ForbiddenError('Vous ne participez pas à ce chat');
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/chats', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sql = `
      SELECT c.id, c.type, c.status as chat_status, c.created_at, c.closed_at,
        CASE WHEN c.type = 'private' THEN (
          SELECT u.name FROM chat_participants cp2 JOIN users u ON cp2.user_id = u.id
          WHERE cp2.chat_id = c.id AND cp2.user_id != ? LIMIT 1
        ) ELSE c.name END as display_name,
        CASE WHEN c.type = 'private' THEN (
          SELECT u.avatar FROM chat_participants cp2 JOIN users u ON cp2.user_id = u.id
          WHERE cp2.chat_id = c.id AND cp2.user_id != ? LIMIT 1
        ) ELSE NULL END as avatar,
        (SELECT m.content FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) as lastMessage,
        (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id ORDER BY m.created_at DESC LIMIT 1) as lastMessageTime,
        (SELECT COUNT(*) FROM messages m
         WHERE m.chat_id = c.id AND m.sender_id != ?
         AND m.created_at > COALESCE(
           (SELECT last_read_at FROM chat_participants WHERE chat_id = c.id AND user_id = ?),
           '1970-01-01'
         )) as unreadCount
      FROM chats c
      JOIN chat_participants cp ON c.id = cp.chat_id
      WHERE cp.user_id = ?
      ORDER BY COALESCE(
        (SELECT MAX(created_at) FROM messages WHERE chat_id = c.id), c.created_at
      ) DESC
      LIMIT 200
    `;
    const chats = await queryPromise(db, sql, [userId, userId, userId, userId, userId]);
    res.json(chats);
  }));

  router.get('/chats/:chat_id/messages', requireAuth, asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id invalide' });
    await assertChatMember(db, chatId, req.user.id);

    const sql = `
      SELECT m.id, m.sender_id, u.name as sender_name, m.content, m.created_at, m.file_url, m.file_type,
             m.message_type as type, m.metadata, m.invitation_id
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ?
      ORDER BY m.created_at ASC
      LIMIT 500
    `;
    const messages = await queryPromise(db, sql, [chatId]);
    res.json(messages.map(msg => {
      if (msg.metadata && typeof msg.metadata === 'string') {
        try { msg.metadata = JSON.parse(msg.metadata); } catch { /* keep raw */ }
      }
      return msg;
    }));
  }));

  router.get('/chats/:chat_id/participants', requireAuth, asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id invalide' });
    await assertChatMember(db, chatId, req.user.id);

    const participants = await queryPromise(db, `
      SELECT cp.user_id, cp.role, cp.joined_at, u.name, u.avatar
      FROM chat_participants cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.chat_id = ?
    `, [chatId]);
    res.json(participants);
  }));

  router.post('/chats/:chat_id/mark-read', requireAuth, asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id invalide' });
    await assertChatMember(db, chatId, req.user.id);
    await queryPromise(db,
      'UPDATE chat_participants SET last_read_at = NOW() WHERE chat_id = ? AND user_id = ?',
      [chatId, req.user.id],
    );
    res.json({ success: true });
  }));

  router.delete('/chats/:chat_id', requireAuth, asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id invalide' });
    const userId = req.user.id;
    await queryPromise(db,
      'DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?',
      [chatId, userId]
    );
    const remaining = await queryOne(db,
      'SELECT COUNT(*) as count FROM chat_participants WHERE chat_id = ?',
      [chatId]
    );
    if (remaining.count === 0) {
      await queryPromise(db, 'DELETE FROM messages WHERE chat_id = ?', [chatId]);
      await queryPromise(db, 'DELETE FROM chats WHERE id = ?', [chatId]);
      return res.json({ success: true, message: 'Chat complètement supprimé' });
    }
    res.json({ success: true, message: 'Utilisateur retiré du chat' });
  }));

  router.post('/chats', requireAuth, asyncHandler(async (req, res) => {
    const userId1 = req.user.id;
    const otherId = Number(req.body?.user_id_2);
    if (!Number.isFinite(otherId) || otherId === userId1) {
      return res.status(400).json({ error: 'user_id_2 invalide' });
    }
    const existing = await queryOne(db, `
      SELECT * FROM chats
      WHERE type = 'private'
        AND id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
        AND id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?)
      LIMIT 1
    `, [userId1, otherId]);
    if (existing) return res.json(existing);

    const friendship = await queryOne(db, `
      SELECT status FROM amis
      WHERE ((user_id_1 = ? AND user_id_2 = ?) OR (user_id_1 = ? AND user_id_2 = ?))
        AND status = 'accepted'
    `, [userId1, otherId, otherId, userId1]);
    const chatStatus = friendship ? 'accepted' : 'pending';

    const chatId = await insert(db,
      "INSERT INTO chats (type, status, created_at) VALUES ('private', ?, NOW())",
      [chatStatus]
    );
    await queryPromise(db, `
      INSERT INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at)
      VALUES (?, ?, 'member', NOW(), NOW()), (?, ?, 'member', NOW(), NOW())
    `, [chatId, userId1, chatId, otherId]);
    const chat = await queryOne(db, 'SELECT * FROM chats WHERE id = ?', [chatId]);
    res.json(chat);
  }));

  router.put('/chats/:chat_id/accept', requireAuth, asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) return res.status(400).json({ error: 'chat_id invalide' });
    await assertChatMember(db, chatId, req.user.id);
    await queryPromise(db,
      "UPDATE chats SET status = 'accepted' WHERE id = ? AND status = 'pending'",
      [chatId]
    );
    res.json({ success: true });
  }));

  router.post('/chats/:chat_id/messages', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
    const chatId = Number(req.params.chat_id);
    if (!Number.isFinite(chatId)) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'chat_id invalide' });
    }
    try {
      await assertChatMember(db, chatId, req.user.id);
    } catch (e) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      throw e;
    }

    const senderId = req.user.id;
    const rawContent = typeof req.body?.content === 'string' ? req.body.content : '';
    const content = rawContent.slice(0, 4000);
    const file_type = typeof req.body?.file_type === 'string' ? req.body.file_type.slice(0, 50) : null;
    const file_url = req.file ? `/uploads/chats/${req.file.filename}` : null;

    if ((!content || content.trim() === '') && !file_url) {
      return res.status(400).json({ error: 'Le message doit contenir du texte ou un fichier.' });
    }
    const messageId = await insert(db, `
      INSERT INTO messages (chat_id, sender_id, content, created_at, file_url, file_type)
      VALUES (?, ?, ?, NOW(), ?, ?)
    `, [chatId, senderId, content || null, file_url, file_type]);
    res.json({ success: true, message_id: messageId, file_url });
  }));

  return router;
};
