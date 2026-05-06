const express = require('express');

module.exports = function(db) {
  const router = express.Router();

  /**
   * GET /api/reviews/clubs/:clubId
   * Récupère tous les commentaires d'un club avec les infos utilisateur
   */
  router.get('/reviews/clubs/:clubId', (req, res) => {
    const { clubId } = req.params;
    const sql = `
      SELECT 
        r.id, 
        r.user_id, 
        r.club_id, 
        r.public_place_id,
        r.rating, 
        r.comment, 
        r.response,
        r.created_at,
        u.name AS user_name,
        u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.club_id = ?
      ORDER BY r.created_at DESC
    `;
    
    db.query(sql, [clubId], (err, reviews) => {
      if (err) {
        console.error('Erreur lors de la récupération des avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération des avis', 
          details: err 
        });
      }
      res.json(reviews);
    });
  });

  /**
   * GET /api/reviews/public-places/:publicPlaceId
   * Récupère tous les commentaires d'un lieu public avec les infos utilisateur
   */
  router.get('/reviews/public-places/:publicPlaceId', (req, res) => {
    const { publicPlaceId } = req.params;
    const sql = `
      SELECT 
        r.id, 
        r.user_id, 
        r.club_id, 
        r.public_place_id,
        r.rating, 
        r.comment, 
        r.response,
        r.created_at,
        u.name AS user_name,
        u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.public_place_id = ?
      ORDER BY r.created_at DESC
    `;
    
    db.query(sql, [publicPlaceId], (err, reviews) => {
      if (err) {
        console.error('Erreur lors de la récupération des avis du lieu public:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération des avis', 
          details: err 
        });
      }
      res.json(reviews);
    });
  });

  /**
   * GET /api/reviews/public-places/:publicPlaceId/stats
   * Récupère les statistiques des avis d'un lieu public
   */
  router.get('/reviews/public-places/:publicPlaceId/stats', (req, res) => {
    const { publicPlaceId } = req.params;
    const sql = `
      SELECT 
        COUNT(*) AS total_reviews,
        AVG(rating) AS average_rating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five_stars,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four_stars,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three_stars,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two_stars,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one_star
      FROM reviews
      WHERE public_place_id = ?
    `;
    
    db.query(sql, [publicPlaceId], (err, stats) => {
      if (err) {
        console.error('Erreur lors de la récupération des statistiques du lieu public:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération des statistiques', 
          details: err 
        });
      }
      
      const result = stats[0];
      res.json({
        total_reviews: Number(result.total_reviews) || 0,
        average_rating: Number(result.average_rating) || 0,
        five_stars: Number(result.five_stars) || 0,
        four_stars: Number(result.four_stars) || 0,
        three_stars: Number(result.three_stars) || 0,
        two_stars: Number(result.two_stars) || 0,
        one_star: Number(result.one_star) || 0
      });
    });
  });

  /**
   * GET /api/reviews/:id
   * Récupère un commentaire spécifique par son ID
   */
  router.get('/reviews/:id', (req, res) => {
    const { id } = req.params;
    const sql = `
      SELECT 
        r.id, 
        r.user_id, 
        r.club_id, 
        r.public_place_id,
        r.rating, 
        r.comment, 
        r.response,
        r.created_at,
        u.name AS user_name,
        u.avatar AS user_avatar
      FROM reviews r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `;
    
    db.query(sql, [id], (err, reviews) => {
      if (err) {
        console.error('Erreur lors de la récupération de l\'avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération de l\'avis', 
          details: err 
        });
      }
      
      if (reviews.length === 0) {
        return res.status(404).json({ error: 'Avis non trouvé' });
      }
      
      res.json(reviews[0]);
    });
  });

  /**
   * POST /api/reviews
   * Créer un nouveau commentaire
   * Body: { user_id, club_id?, public_place_id?, rating, comment }
   * Note: Soit club_id soit public_place_id doit être fourni
   */
  router.post('/reviews', (req, res) => {
    const { user_id, club_id, public_place_id, rating, comment } = req.body;
    
    // Validation
    if (!user_id || !rating || !comment) {
      return res.status(400).json({ 
        error: 'Champs requis manquants', 
        required: ['user_id', 'rating', 'comment', 'club_id ou public_place_id']
      });
    }

    if (!club_id && !public_place_id) {
      return res.status(400).json({ 
        error: 'Soit club_id soit public_place_id doit être fourni'
      });
    }
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ 
        error: 'La note doit être entre 1 et 5' 
      });
    }
    
    const sql = `
      INSERT INTO reviews (user_id, club_id, public_place_id, rating, comment, created_at) 
      VALUES (?, ?, ?, ?, ?, NOW())
    `;
    
    db.query(sql, [user_id, club_id || null, public_place_id || null, rating, comment], (err, result) => {
      if (err) {
        console.error('Erreur lors de la création de l\'avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la création de l\'avis', 
          details: err 
        });
      }
      
      res.status(201).json({ 
        success: true, 
        id: result.insertId,
        message: 'Avis créé avec succès'
      });
    });
  });

  /**
   * PUT /api/reviews/:id
   * Modifier un commentaire existant
   * Body: { rating?, comment? }
   */
  router.put('/reviews/:id', (req, res) => {
    const { id } = req.params;
    const { rating, comment } = req.body;
    
    if (!rating && !comment) {
      return res.status(400).json({ 
        error: 'Au moins un champ (rating ou comment) doit être fourni' 
      });
    }
    
    if (rating && (rating < 1 || rating > 5)) {
      return res.status(400).json({ 
        error: 'La note doit être entre 1 et 5' 
      });
    }
    
    const updates = [];
    const values = [];
    
    if (rating) {
      updates.push('rating = ?');
      values.push(rating);
    }
    
    if (comment) {
      updates.push('comment = ?');
      values.push(comment);
    }
    
    values.push(id);
    
    const sql = `UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`;
    
    db.query(sql, values, (err, result) => {
      if (err) {
        console.error('Erreur lors de la modification de l\'avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la modification de l\'avis', 
          details: err 
        });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Avis non trouvé' });
      }
      
      res.json({ 
        success: true, 
        message: 'Avis modifié avec succès' 
      });
    });
  });

  /**
   * PUT /api/reviews/:id/response
   * Ajouter/modifier la réponse d'un admin de club à un commentaire
   * Body: { response }
   */
  router.put('/reviews/:id/response', (req, res) => {
    const { id } = req.params;
    const { response } = req.body;
    
    if (response === undefined) {
      return res.status(400).json({ 
        error: 'Le champ response est requis' 
      });
    }
    
    const sql = 'UPDATE reviews SET response = ? WHERE id = ?';
    
    db.query(sql, [response || null, id], (err, result) => {
      if (err) {
        console.error('Erreur lors de l\'ajout de la réponse:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de l\'ajout de la réponse', 
          details: err 
        });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Avis non trouvé' });
      }
      
      res.json({ 
        success: true, 
        message: 'Réponse ajoutée avec succès' 
      });
    });
  });

  /**
   * DELETE /api/reviews/:id
   * Supprimer un commentaire
   */
  router.delete('/reviews/:id', (req, res) => {
    const { id } = req.params;
    const sql = 'DELETE FROM reviews WHERE id = ?';
    
    db.query(sql, [id], (err, result) => {
      if (err) {
        console.error('Erreur lors de la suppression de l\'avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la suppression de l\'avis', 
          details: err 
        });
      }
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Avis non trouvé' });
      }
      
      res.json({ 
        success: true, 
        message: 'Avis supprimé avec succès' 
      });
    });
  });

  /**
   * GET /api/reviews/users/:userId
   * Récupère tous les commentaires d'un utilisateur
   */
  router.get('/reviews/users/:userId', (req, res) => {
    const { userId } = req.params;
    const sql = `
      SELECT 
        r.id, 
        r.user_id, 
        r.club_id, 
        r.rating, 
        r.comment, 
        r.response,
        r.created_at,
        c.name AS club_name,
        c.city AS club_city
      FROM reviews r
      LEFT JOIN clubs c ON r.club_id = c.id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
    `;
    
    db.query(sql, [userId], (err, reviews) => {
      if (err) {
        console.error('Erreur lors de la récupération des avis:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération des avis', 
          details: err 
        });
      }
      res.json(reviews);
    });
  });

  /**
   * GET /api/reviews/clubs/:clubId/stats
   * Récupère les statistiques des avis d'un club
   */
  router.get('/reviews/clubs/:clubId/stats', (req, res) => {
    const { clubId } = req.params;
    const sql = `
      SELECT 
        COUNT(*) AS total_reviews,
        AVG(rating) AS average_rating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five_stars,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four_stars,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three_stars,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two_stars,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one_star
      FROM reviews
      WHERE club_id = ?
    `;
    
    db.query(sql, [clubId], (err, stats) => {
      if (err) {
        console.error('Erreur lors de la récupération des statistiques:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération des statistiques', 
          details: err 
        });
      }
      
      // Convertir les valeurs en nombres pour éviter les problèmes de concaténation
      const result = stats[0];
      res.json({
        total_reviews: Number(result.total_reviews) || 0,
        average_rating: Number(result.average_rating) || 0,
        five_stars: Number(result.five_stars) || 0,
        four_stars: Number(result.four_stars) || 0,
        three_stars: Number(result.three_stars) || 0,
        two_stars: Number(result.two_stars) || 0,
        one_star: Number(result.one_star) || 0
      });
    });
  });

  return router;
};
