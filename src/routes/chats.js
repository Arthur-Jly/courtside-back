const express = require('express');
const multer = require('multer');
const path = require('path');

// Configurer le dossier d'upload
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

  // d. Récupérer la liste des chats d'un user avec infos complètes
  router.get('/chats', (req, res) => {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }
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
          AND m.sender_id != ? -- Seuls les messages reçus
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
    db.query(sql, [user_id, user_id, user_id, user_id, user_id], (err, chats) => {
      if (err) return res.status(500).json({ error: err });
      res.json(chats);
    });
  });

  // b. Récupérer les messages d'un chat
  router.get('/chats/:chat_id/messages', (req, res) => {
    const { chat_id } = req.params;
    const sql = `
      SELECT m.id, m.sender_id, u.name as sender_name, m.content, m.created_at, m.file_url, m.file_type,
             m.message_type as type, m.metadata, m.invitation_id
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.chat_id = ?
      ORDER BY m.created_at ASC
    `;
    db.query(sql, [chat_id], (err, messages) => {
      if (err) return res.status(500).json({ error: err });
      
      // Parser le metadata JSON pour chaque message
      const parsedMessages = messages.map(msg => {
        if (msg.metadata && typeof msg.metadata === 'string') {
          try {
            msg.metadata = JSON.parse(msg.metadata);
          } catch (e) {
            console.error('Erreur parsing metadata:', e);
          }
        }
        return msg;
      });
      
      res.json(parsedMessages);
    });
  });

  // e. Récupérer les participants d'un chat
  router.get('/chats/:chat_id/participants', (req, res) => {
    const { chat_id } = req.params;
    const sql = `
      SELECT cp.user_id, cp.role, cp.joined_at, u.name, u.email, u.avatar
      FROM chat_participants cp
      JOIN users u ON cp.user_id = u.id
      WHERE cp.chat_id = ?
    `;
    db.query(sql, [chat_id], (err, participants) => {
      if (err) return res.status(500).json({ error: err });
      res.json(participants);
    });
  });

  // f. Marquer les messages comme lus
  router.post('/chats/:chat_id/mark-read', (req, res) => {
    const { chat_id } = req.params;
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }
    const sql = `
      UPDATE chat_participants 
      SET last_read_at = NOW() 
      WHERE chat_id = ? AND user_id = ?
    `;
    db.query(sql, [chat_id, user_id], (err, result) => {
      if (err) return res.status(500).json({ error: err });
      res.json({ success: true });
    });
  });

  // g. Supprimer une discussion pour un utilisateur
  router.delete('/chats/:chat_id', (req, res) => {
    const { chat_id } = req.params;
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }
    
    // Option 1: Supprimer seulement la participation de l'utilisateur
    const sql = `
      DELETE FROM chat_participants 
      WHERE chat_id = ? AND user_id = ?
    `;
    db.query(sql, [chat_id, user_id], (err, result) => {
      if (err) return res.status(500).json({ error: err });
      
      // Vérifier s'il reste des participants
      db.query('SELECT COUNT(*) as count FROM chat_participants WHERE chat_id = ?', [chat_id], (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2 });
        
        // Si plus de participants, supprimer le chat complètement
        if (rows[0].count === 0) {
          db.query('DELETE FROM messages WHERE chat_id = ?', [chat_id], (err3) => {
            if (err3) return res.status(500).json({ error: err3 });
            db.query('DELETE FROM chats WHERE id = ?', [chat_id], (err4) => {
              if (err4) return res.status(500).json({ error: err4 });
              res.json({ success: true, message: 'Chat complètement supprimé' });
            });
          });
        } else {
          res.json({ success: true, message: 'Utilisateur retiré du chat' });
        }
      });
    });
  });

  // a. Créer ou retrouver un chat entre deux amis
  router.post('/chats', (req, res) => {
    const { user_id_1, user_id_2 } = req.body;
    if (!user_id_1 || !user_id_2) {
      return res.status(400).json({ error: 'user_id_1 and user_id_2 required' });
    }
    // Vérifier si un chat privé existe déjà
    const checkSql = `
      SELECT * FROM chats
      WHERE type = 'private'
        AND (
          (id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?) )
          AND (id IN (SELECT chat_id FROM chat_participants WHERE user_id = ?) )
        )
      LIMIT 1
    `;
    db.query(checkSql, [user_id_1, user_id_2], (err, chats) => {
      if (err) return res.status(500).json({ error: err });
      if (chats.length > 0) {
        return res.json(chats[0]);
      }
      // Créer le chat
      db.query(
        "INSERT INTO chats (type, created_at) VALUES ('private', NOW())",
        (err, result) => {
          if (err) return res.status(500).json({ error: err });
          const chat_id = result.insertId;
          // Ajouter les deux participants
          const partSql = `
            INSERT INTO chat_participants (chat_id, user_id, role, joined_at, last_read_at)
            VALUES (?, ?, 'member', NOW(), NOW()), (?, ?, 'member', NOW(), NOW())
          `;
          db.query(partSql, [chat_id, user_id_1, chat_id, user_id_2], (err2) => {
            if (err2) return res.status(500).json({ error: err2 });
            db.query("SELECT * FROM chats WHERE id = ?", [chat_id], (err3, rows) => {
              if (err3) return res.status(500).json({ error: err3 });
              res.json(rows[0]);
            });
          });
        }
      );
    });
  });

  // c. Envoyer un message (texte ou fichier)
  router.post('/chats/:chat_id/messages', upload.single('file'), (req, res) => {
    const { chat_id } = req.params;
    const { sender_id, content, file_type } = req.body;
    let file_url = null;

    // Si un fichier est uploadé, construire l'URL
    if (req.file) {
      // À adapter selon le domaine réel
      file_url = `/uploads/${req.file.filename}`;
    }

    // Vérification : au moins un contenu ou un fichier
    if (!sender_id) {
      return res.status(400).json({ error: 'sender_id required' });
    }
    if ((!content || content.trim() === '') && !file_url) {
      return res.status(400).json({ error: 'Le message doit contenir du texte ou un fichier.' });
    }

    const sql = `
      INSERT INTO messages (chat_id, sender_id, content, created_at, file_url, file_type)
      VALUES (?, ?, ?, NOW(), ?, ?)
    `;
    db.query(sql, [chat_id, sender_id, content || null, file_url, file_type || null], (err, result) => {
      if (err) return res.status(500).json({ error: err });
      res.json({ success: true, message_id: result.insertId, file_url });
    });
  });

  return router;
};