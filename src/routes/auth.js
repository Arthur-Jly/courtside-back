const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { queryOne, queryPromise, insert, getClubIdByName } = require('../utils/dbHelpers');
const { validate, schemas } = require('../middleware/validation');
const { asyncHandler, ConflictError, UnauthorizedError, NotFoundError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const emailService = require('../services/emailService');
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

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Same hashing scheme as reset tokens (sha256 hex), reused for club invitations.
const hashInviteToken = hashResetToken;

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
    emailService.sendWelcome(user.email, first_name.trim()).catch(e => {
      logger.error('sendWelcome failed: ' + e.message);
    });
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

  // Preview an invitation (used by the /rejoindre-club page to show the club name
  // and pre-fill the email). Does not consume the token.
  router.get('/club-invitation/:token', asyncHandler(async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Jeton invalide' });
    const row = await queryOne(db, `
      SELECT ci.email, ci.club_id, c.name AS club_name
      FROM club_invitations ci JOIN clubs c ON c.id = ci.club_id
      WHERE ci.token_hash = ? AND ci.used_at IS NULL AND ci.expires_at > NOW() LIMIT 1`,
      [hashInviteToken(token)]);
    if (!row) throw new UnauthorizedError('Lien invalide ou expiré.');
    res.json({ email: row.email, clubName: row.club_name });
  }));

  // Accept a club invitation: creates the gérant's account, linked to the club.
  router.post('/accept-club-invitation', registerLimiter, validate(schemas.acceptClubInvitation), asyncHandler(async (req, res) => {
    const { token, first_name, last_name, password, username } = req.body;

    const invite = await queryOne(db, `
      SELECT id, club_id, email FROM club_invitations
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [hashInviteToken(token)]);
    if (!invite) throw new UnauthorizedError('Lien invalide ou expiré. Demande une nouvelle invitation.');

    const existing = await queryOne(db, 'SELECT id FROM users WHERE email = ?', [invite.email]);
    if (existing) throw new ConflictError('Un compte existe déjà pour cet email. Connecte-toi puis contacte le support pour rattacher ton club.');

    const existingUsername = await queryOne(db, 'SELECT id FROM users WHERE username = ?', [username]);
    if (existingUsername) throw new ConflictError('Ce pseudo est déjà pris.');

    const fullName = `${first_name.trim()} ${last_name.trim()}`;
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = await insert(db,
      'INSERT INTO users (name, email, password_hash, role, club_id, username, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [fullName, invite.email, hash, 'club_admin', invite.club_id, username]);

    // Consume the invitation (and any other outstanding one for this club).
    await queryPromise(db, 'UPDATE club_invitations SET used_at = NOW() WHERE club_id = ? AND used_at IS NULL', [invite.club_id]);

    const user = await queryOne(db, 'SELECT id, name, email, role, club_id, username FROM users WHERE id = ?', [userId]);
    const authToken = jwt.sign(
      { id: user.id, role: user.role, name: user.name, club_id: user.club_id },
      jwtSecret,
      { expiresIn: TOKEN_TTL }
    );
    logger.info(`Club admin account created via invitation id=${user.id} club=${user.club_id}`);
    res.json({ ...user, first_name: first_name.trim(), last_name: last_name.trim(), token: authToken });
  }));

  // Validates the bearer token and returns fresh user data.
  router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await queryOne(
      db,
      'SELECT id, name, email, role, club_id, username FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) throw new UnauthorizedError('Compte introuvable');
    res.json(user);
  }));

  // Always answers 200 to avoid account enumeration.
  router.post('/forgot-password', resetLimiter, validate(schemas.forgotPassword), asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await queryOne(db, 'SELECT id, email FROM users WHERE email = ?', [email]);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      await queryPromise(db,
        'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())',
        [user.id, hashResetToken(token)]
      );
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const resetUrl = `${baseUrl}/reinitialiser-mot-de-passe?token=${token}`;
      emailService.sendPasswordReset(user.email, resetUrl).catch(e => {
        logger.error('sendPasswordReset failed: ' + e.message);
      });
      logger.info(`Password reset requested for user id=${user.id}`);
    }
    res.json({ success: true, message: 'Si un compte existe pour cet email, un lien de réinitialisation a été envoyé.' });
  }));

  router.post('/reset-password', resetLimiter, validate(schemas.resetPassword), asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const row = await queryOne(db,
      'SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [hashResetToken(token)]
    );
    if (!row) throw new UnauthorizedError('Lien invalide ou expiré. Refais une demande de réinitialisation.');

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await queryPromise(db, 'UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.user_id]);
    await queryPromise(db, 'UPDATE password_resets SET used_at = NOW() WHERE id = ?', [row.id]);
    // Invalidate any other outstanding links for this user.
    await queryPromise(db, 'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [row.user_id]);

    logger.info(`Password reset completed for user id=${row.user_id}`);
    res.json({ success: true });
  }));

  return router;
};
