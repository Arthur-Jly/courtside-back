const express = require('express');

  module.exports = (db) => {
    const router = express.Router();

    // Ajouter un club aux favoris (like)
    router.post('/favorites', (req, res) => {
      console.log('Payload reçu:', req.body); // Ajoute ce log
      const { user_id, terrain_id } = req.body;
      if (!user_id || !terrain_id) {
        return res.status(400).json({ error: 'user_id et terrain_id requis' });
      }
      const sql = 'INSERT IGNORE INTO favorites (user_id, terrain_id, created_at) VALUES (?, ?, NOW())';
      db.query(sql, [user_id, terrain_id], (err, result) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ success: true });
      });
    });

    // Retirer un club des favoris (unlike)
    router.delete('/favorites', (req, res) => {
      const { user_id, terrain_id } = req.body;
      if (!user_id || !terrain_id) {
        return res.status(400).json({ error: 'user_id et terrain_id requis' });
      }
      const sql = 'DELETE FROM favorites WHERE user_id = ? AND terrain_id = ?';
      db.query(sql, [user_id, terrain_id], (err, result) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ success: true });
      });
    });

    // Récupérer les clubs favoris d'un utilisateur
    router.get('/favorites/:user_id', (req, res) => {
      const { user_id } = req.params;
      const sql = `
        SELECT c.id, c.name, c.address, c.city, c.lat, c.lon, c.rating,
          GROUP_CONCAT(DISTINCT cs.sport_name) AS sports,
          GROUP_CONCAT(DISTINCT ci.image_url) AS images
        FROM favorites f
        JOIN clubs c ON f.terrain_id = c.id
        LEFT JOIN club_sports cs ON c.id = cs.club_id
        LEFT JOIN club_images ci ON c.id = ci.club_id
        WHERE f.user_id = ? AND c.status = 'confirme'
        GROUP BY c.id
      `;
      db.query(sql, [user_id], (err, clubs) => {
        if (err) return res.status(500).json({ error: err });
        const clubsWithSports = clubs.map(club => ({
          ...club,
          sports: club.sports ? club.sports.split(',') : [],
          images: club.images ? club.images.split(',') : []
        }));
        res.json(clubsWithSports);
      });
    });

  // Simple users endpoint (sans champs sensibles)
  router.get('/users', (req, res) => {
    console.log('Endpoint /api/users called (users router)');
    db.query('SELECT id, name, email, role FROM users', (err, users) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur users', details: err });
      }
      res.json(users);
    });
  });

  // Recherche d'utilisateurs avec statut d'amitié — MUST be before /users/:id
  router.get('/users/search', (req, res) => {
    const query = req.query.query || req.query.q;
    const currentUserId = req.query.current_user_id ? parseInt(req.query.current_user_id, 10) : null;
    if (!query) {
      return res.status(400).json({ error: 'query required' });
    }

    if (!currentUserId) {
      const sql = `
        SELECT u.id, u.name, u.email
        FROM users u
        WHERE u.name LIKE ?
        LIMIT 20
      `;
      return db.query(sql, [`%${query}%`], (err, users) => {
        if (err) return res.status(500).json({ error: 'Erreur search users', details: err });
        res.json(users);
      });
    }

    const sql = `
      SELECT u.id, u.name, u.email,
             a.status as friendship_status
      FROM users u
      LEFT JOIN amis a ON (
        (a.user_id_1 = ? AND a.user_id_2 = u.id) OR
        (a.user_id_1 = u.id AND a.user_id_2 = ?)
      )
      WHERE u.name LIKE ? AND u.id != ?
      LIMIT 20
    `;
    db.query(sql, [currentUserId, currentUserId, `%${query}%`, currentUserId], (err, users) => {
      if (err) return res.status(500).json({ error: 'Erreur search users', details: err });
      res.json(users);
    });
  });

  // Mettre à jour le profil d'un utilisateur
  router.put('/users/:id', (req, res) => {
    const { id } = req.params;
    const { name, email } = req.body;
    const updates = [];
    const vals = [];
    if (name) { updates.push('name = ?'); vals.push(name); }
    if (email) { updates.push('email = ?'); vals.push(email); }
    if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    vals.push(id);
    db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, vals, (err, result) => {
      if (err) return res.status(500).json({ error: 'Erreur mise à jour profil', details: err });
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
      res.json({ success: true });
    });
  });

  // Récupérer un utilisateur par ID (profil public)
  router.get('/users/:id', (req, res) => {
    const { id } = req.params;
    
    // Requête principale pour les infos utilisateur (table users uniquement)
    const userSql = `
      SELECT id, name, email, role, created_at
      FROM users
      WHERE id = ?
    `;
    
    // Requête pour compter les réservations
    const reservationsSql = `
      SELECT COUNT(*) as total_reservations
      FROM reservations
      WHERE user_id = ?
    `;
    
    db.query(userSql, [id], (err, userResults) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur récupération profil', details: err });
      }
      
      if (userResults.length === 0) {
        return res.status(404).json({ error: 'Utilisateur non trouvé' });
      }
      
      const user = userResults[0];
      const memberSince = user.created_at ? new Date(user.created_at).getFullYear().toString() : null;
      
      // Récupérer les stats de réservation
      db.query(reservationsSql, [id], (err2, statsResults) => {
        const totalReservations = statsResults && statsResults[0] ? statsResults[0].total_reservations : 0;
        
        res.json({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          avatar: null, // Pas de table user_profiles pour l'instant
          location: null,
          bio: null,
          favoriteSport: null,
          memberSince,
          totalReservations,
          hoursPlayed: 0,
          rating: null
        });
      });
    });
  });

  // Vérifier le statut d'amitié entre deux utilisateurs
  router.get('/friendship-status', (req, res) => {
    const { user_id_1, user_id_2 } = req.query;
    
    if (!user_id_1 || !user_id_2) {
      return res.status(400).json({ error: 'user_id_1 and user_id_2 are required' });
    }
    
    const sql = `
      SELECT status FROM amis 
      WHERE (user_id_1 = ? AND user_id_2 = ?) 
         OR (user_id_1 = ? AND user_id_2 = ?)
    `;
    
    db.query(sql, [user_id_1, user_id_2, user_id_2, user_id_1], (err, results) => {
      if (err) return res.status(500).json({ error: 'Erreur check friendship', details: err });
      
      if (results.length === 0) {
        return res.json({ status: 'none' });
      }
      
      res.json({ status: results[0].status });
    });
  });

  // Envoyer une demande d'ami
  router.post('/friend-request', (req, res) => {
    const headerUserId = req.headers['user-id'];
    const body = req.body || {};
    const userId1 = body.user_id_1 || body.from_user_id || headerUserId;
    const userId2 = body.user_id_2 || body.to_user_id;
    
    if (!userId1 || !userId2) {
      return res.status(400).json({ error: 'user_id_1 and user_id_2 are required' });
    }

    if (String(userId1) === String(userId2)) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' });
    }
    
    // Vérifie si une relation existe déjà (dans les deux sens)
    const checkSql = `
      SELECT * FROM amis 
      WHERE (user_id_1 = ? AND user_id_2 = ?) 
         OR (user_id_1 = ? AND user_id_2 = ?)
    `;
    
    db.query(checkSql, [userId1, userId2, userId2, userId1], (err, existing) => {
      if (err) return res.status(500).json({ error: 'Erreur check existing', details: err });
      
      if (existing.length > 0) {
        const relation = existing[0];
        return res.status(400).json({ 
          error: 'Relation already exists',
          status: relation.status 
        });
      }
      
      // Crée la nouvelle demande
      const insertSql = `
        INSERT INTO amis (user_id_1, user_id_2, status) 
        VALUES (?, ?, 'pending')
      `;
      
      db.query(insertSql, [userId1, userId2], (err, result) => {
        if (err) return res.status(500).json({ error: 'Erreur create request', details: err });
        res.json({ success: true, status: 'pending' });
      });
    });
  });

  // Accepter/rejeter une demande d'ami
  router.put('/friend-request/:id', (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'accepted' ou 'rejected'
    
    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be accepted or rejected' });
    }

    const sql = 'UPDATE amis SET status = ? WHERE id = ?';
    
    db.query(sql, [status, id], (err, result) => {
      if (err) return res.status(500).json({ error: 'Erreur update request', details: err });
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Friend request not found' });
      }
      
      res.json({ success: true, status });
    });
  });

  // Annuler/Supprimer une demande d'ami
  router.delete('/friend-request/:id', (req, res) => {
    const { id } = req.params;
    
    const sql = 'DELETE FROM amis WHERE id = ? AND status = "pending"';
    
    db.query(sql, [id], (err, result) => {
      if (err) return res.status(500).json({ error: 'Erreur delete request', details: err });
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Friend request not found or already processed' });
      }
      
      res.json({ success: true });
    });
  });

  // Récupérer les demandes d'ami envoyées (en attente) - DOIT ÊTRE AVANT /friend-requests/:user_id
  router.get('/friend-requests/sent/:user_id', (req, res) => {
    const { user_id } = req.params;
    
    const sql = `
      SELECT a.id, a.status, a.created_at,
             u.id as receiver_id, u.name as receiver_name, u.email as receiver_email
      FROM amis a
      JOIN users u ON a.user_id_2 = u.id
      WHERE a.user_id_1 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `;
    
    db.query(sql, [user_id], (err, requests) => {
      if (err) return res.status(500).json({ error: 'Erreur get sent requests', details: err });
      res.json(requests);
    });
  });

  // Récupérer les demandes d'ami reçues
  router.get('/friend-requests/:user_id', (req, res) => {
    const { user_id } = req.params;
    
    const sql = `
      SELECT a.id, a.status, a.created_at,
             u.id as sender_id, u.name as sender_name, u.email as sender_email
      FROM amis a
      JOIN users u ON a.user_id_1 = u.id
      WHERE a.user_id_2 = ? AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `;
    
    db.query(sql, [user_id], (err, requests) => {
      if (err) return res.status(500).json({ error: 'Erreur get requests', details: err });
      res.json(requests);
    });
  });

  // Récupérer la liste des amis
  router.get('/friends/:user_id', (req, res) => {
    const { user_id } = req.params;
    
    const sql = `
      SELECT u.id, u.name, u.email, a.created_at as friends_since
      FROM amis a
      JOIN users u ON (
        CASE 
          WHEN a.user_id_1 = ? THEN a.user_id_2 = u.id
          ELSE a.user_id_1 = u.id
        END
      )
      WHERE (a.user_id_1 = ? OR a.user_id_2 = ?) 
        AND a.status = 'accepted'
      ORDER BY a.created_at DESC
    `;
    
    db.query(sql, [user_id, user_id, user_id], (err, friends) => {
      if (err) return res.status(500).json({ error: 'Erreur get friends', details: err });
      res.json(friends);
    });
  });

    // Supprimer une relation d'amitié
  router.delete('/friends/:user_id/:friend_id', (req, res) => {
    const { user_id, friend_id } = req.params;
    // Supprime la relation dans les deux sens
    const sql = `
      DELETE FROM amis
      WHERE (user_id_1 = ? AND user_id_2 = ?)
        OR (user_id_1 = ? AND user_id_2 = ?)
    `;
    db.query(sql, [user_id, friend_id, friend_id, user_id], (err, result) => {
      if (err) return res.status(500).json({ error: 'Erreur suppression ami', details: err });
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Relation non trouvée' });
      }
      res.json({ success: true });
    });
  });

  return router;
};
