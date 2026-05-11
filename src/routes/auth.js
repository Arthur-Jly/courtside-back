const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { queryOne, insert } = require('../utils/dbHelpers');
const { validate, schemas } = require('../middleware/validation');
const { asyncHandler, ConflictError, UnauthorizedError, NotFoundError } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');
const { getClubIdByName } = require('../utils/dbHelpers');

module.exports = (db, jwtSecret) => {
  const router = express.Router();

  router.post('/register', validate(schemas.register), asyncHandler(async (req, res) => {
    const { name, email, password, role, club_name } = req.body;

    const existing = await queryOne(db, 'SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new ConflictError('Cet email est déjà utilisé.');

    const hash = await bcrypt.hash(password, 10);

    let club_id = null;
    if (role === 'club_admin' && club_name) {
      club_id = await getClubIdByName(db, club_name);
      if (!club_id) throw new NotFoundError(`Le club "${club_name}" n'existe pas dans la base de données`);
    }

    const userId = await insert(
      db,
      'INSERT INTO users (name, email, password_hash, role, club_id, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [name, email, hash, role, club_id]
    );

    const user = await queryOne(db, 'SELECT id, name, email, role, club_id FROM users WHERE id = ?', [userId]);
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name, club_id: user.club_id }, jwtSecret, { expiresIn: '2h' });

    logger.info(`Nouvel utilisateur inscrit: ${email}`);
    res.json({ ...user, token });
  }));

  router.post('/login', validate(schemas.login), asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await queryOne(db, 'SELECT * FROM users WHERE email = ?', [email]);
    if (!user) throw new UnauthorizedError('Email ou mot de passe incorrect.');

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) throw new UnauthorizedError('Email ou mot de passe incorrect.');

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name, club_id: user.club_id }, jwtSecret, { expiresIn: '2h' });

    logger.info(`Utilisateur connecté: ${email}`);
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, club_id: user.club_id, token });
  }));

  return router;
};
