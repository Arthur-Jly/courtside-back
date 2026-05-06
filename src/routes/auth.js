const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getClubIdByName } = require('../utils/dbHelpers');

module.exports = (db, jwtSecret) => {
  const router = express.Router();

  router.post('/register', async (req, res) => {
    const { name, email, password, role, club_name } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'Champs requis manquants' });
    

    try {
      // Vérifier si l'email existe déjà
      db.query('SELECT id FROM users WHERE email = ?', [email], async (err, results) => {
        if (err) return res.status(500).json({ error: 'Erreur SQL', details: err });
        if (results.length > 0) return res.status(409).json('Cet email est déjà utilisé.');
        
        const hash = await bcrypt.hash(password, 10);
        
        // Si c'est un club_admin et qu'un club_name est fourni, récupérer le club_id
        let club_id = null;
        if (role === 'club_admin' && club_name) {
          try {
            club_id = await getClubIdByName(db, club_name);
            if (!club_id) {
              return res.status(404).json({ error: `Le club "${club_name}" n'existe pas dans la base de données` });
            }
          } catch (clubErr) {
            return res.status(500).json({ error: 'Erreur lors de la recherche du club', details: clubErr });
          }
        }
        
        // Insérer l'utilisateur avec ou sans club_id
        const insertSql = 'INSERT INTO users (name, email, password_hash, role, club_id, created_at) VALUES (?, ?, ?, ?, ?, NOW())';
        db.query(insertSql, [name, email, hash, role, club_id], (err, result) => {
          if (err) return res.status(500).json({ error: 'Erreur SQL', details: err });
          
          // Récupérer l'utilisateur créé
          db.query('SELECT id, name, email, role, club_id FROM users WHERE id = ?', [result.insertId], (err, users) => {
            if (err || users.length === 0) return res.status(500).json({ error: 'Erreur SQL', details: err });
            const user = users[0];
            const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, jwtSecret, { expiresIn: '2h' });
            res.json({ user, token, ...user });
          });
        });
      });
    } catch (err) {
      res.status(500).json({ error: 'Erreur hash', details: err });
    }
  });

  router.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Champs requis manquants' });
    db.query('SELECT * FROM users WHERE email = ?', [email], async (err, results) => {
      if (err) return res.status(500).json({ error: 'Erreur SQL', details: err });
      if (results.length === 0) return res.status(401).json('Email ou mot de passe incorrect.');
      const user = results[0];
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json('Email ou mot de passe incorrect.');
      const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, jwtSecret, { expiresIn: '2h' });
      const safeUser = { id: user.id, name: user.name, email: user.email, role: user.role, club_id: user.club_id };
      res.json({ user: safeUser, token, ...safeUser });
    });
  });

  return router;
};
