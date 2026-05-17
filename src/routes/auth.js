const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { queryOne, insert, getClubIdByName } = require('../utils/dbHelpers');
const { validate, schemas } = require('../middleware/validation');
const { asyncHandler, ConflictError, UnauthorizedError, NotFoundError } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

const TOKEN_TTL = process.env.JWT_TTL || '2h';
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 12;

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

module.exports = (db, jwtSecret) => {
  const router = express.Router();

  router.post('/register', registerLimiter, validate(schemas.register), asyncHandler(async (req, res) => {
    const { first_name, last_name, email, password, role, club_name, username } = req.body;
    const fullName = `${first_name.trim()} ${last_name.trim()}`;

    const existing = await queryOne(db, 'SELECT id FROM users WHERE email = ?', [email]);
    if (existing) throw new ConflictError('Cet email est déjà utilisé.');

    const existingUsername = await queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
    if (existingUsername) throw new ConflictError('Ce pseudo est déjà pris.');

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let club_id = null;
    if (role === 'club_admin' && club_name) {
      club_id = await getClubIdByName(db, club_name);
      if (!club_id) throw new NotFoundError(`Le club "${club_name}" n'existe pas dans la base de données`);
    }

    const userId = await insert(
      db,
      'INSERT INTO users (name, email, password_hash, role, club_id, username, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [fullName, email, hash, role, club_id, username]
    );

    const user = await queryOne(db, 'SELECT id, name, email, role, club_id, username FROM users WHERE id = ?', [userId]);
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, club_id: user.club_id },
      jwtSecret,
      { expiresIn: TOKEN_TTL }
    );

    logger.info(`User registered id=${user.id}`);
    res.json({ ...user, first_name: first_name.trim(), last_name: last_name.trim(), token });
  }));

  router.post('/login', loginLimiter, validate(schemas.login), asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    const user = await queryOne(db, 'SELECT * FROM users WHERE email = ?', [email]);
    // Always perform a bcrypt comparison to avoid user enumeration via timing.
    const stored = user?.password_hash || '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid';
    const match = await bcrypt.compare(password, stored);
    if (!user || !match) throw new UnauthorizedError('Email ou mot de passe incorrect.');

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, club_id: user.club_id },
      jwtSecret,
      { expiresIn: TOKEN_TTL }
    );

    logger.info(`User login id=${user.id}`);
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, club_id: user.club_id, token });
  }));

  return router;
};
