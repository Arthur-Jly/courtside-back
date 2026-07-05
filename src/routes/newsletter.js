const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../middleware/errorHandler');
const { queryPromise } = require('../utils/dbHelpers');

const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = (db) => {
  const router = express.Router();

  // Public opt-in. Idempotent: re-subscribing an existing email is a no-op.
  router.post('/newsletter/subscribe', subscribeLimiter, asyncHandler(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email invalide' });
    await queryPromise(db,
      'INSERT IGNORE INTO newsletter_subscribers (email, created_at) VALUES (?, NOW())',
      [email]
    );
    res.status(201).json({ success: true });
  }));

  return router;
};
