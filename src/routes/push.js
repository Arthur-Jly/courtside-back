/**
 * Abonnements Web Push.
 * La clé publique VAPID est publique par nature (elle est intégrée au client) :
 * la route de lecture reste ouverte. Tout le reste exige un compte.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { queryPromise } = require('../utils/dbHelpers');
const push = require('../utils/push');

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = (db) => {
  const router = express.Router();

  router.get('/push/public-key', (req, res) => {
    res.json({ enabled: push.isEnabled(), publicKey: push.isEnabled() ? push.publicKey : null });
  });

  router.post('/push/subscribe', requireAuth, writeLimiter, asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 500) {
      return res.status(400).json({ error: 'endpoint invalide' });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'clés d\'abonnement manquantes' });
    }

    // Un même endpoint peut changer de propriétaire (appareil partagé, compte
    // recréé) : on réattribue plutôt que de créer un doublon.
    await queryPromise(db, `
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh),
                              auth = VALUES(auth), failure_count = 0
    `, [
      req.user.id,
      endpoint,
      String(keys.p256dh).slice(0, 255),
      String(keys.auth).slice(0, 255),
      String(req.headers['user-agent'] || '').slice(0, 255) || null,
    ]);

    res.status(201).json({ success: true });
  }));

  router.delete('/push/subscribe', requireAuth, asyncHandler(async (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint) {
      await queryPromise(db, 'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [req.user.id, endpoint]);
    } else {
      await queryPromise(db, 'DELETE FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
    }
    res.json({ success: true });
  }));

  router.get('/push/status', requireAuth, asyncHandler(async (req, res) => {
    const rows = await queryPromise(db, 'SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
    res.json({ enabled: push.isEnabled(), devices: Number(rows[0]?.count || 0) });
  }));

  return router;
};
