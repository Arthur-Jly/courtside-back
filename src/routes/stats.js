const express = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { queryOne } = require('../utils/dbHelpers');
const { VERIFIED_STATUSES } = require('../services/placeStatus');

// Chiffres vitrine (hero de l'accueil, page partenaires) : trois COUNT servis
// depuis un cache de 10 min, l'endpoint étant public et appelé à chaque visite.
const TTL_MS = 10 * 60 * 1000;

module.exports = (db, { now = Date.now } = {}) => {
  const router = express.Router();
  let cached = null;
  let cachedAt = 0;

  async function compute() {
    const [players, places, clubs] = await Promise.all([
      // Un compte supprimé (RGPD) est anonymisé, pas effacé : on l'écarte.
      queryOne(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'player' AND password_hash <> 'account-deleted'"),
      // Mêmes terrains que la recherche par défaut : ceux qui ont une preuve d'existence.
      queryOne(db,
        `SELECT COUNT(*) AS n FROM public_places
          WHERE verification_status IN (${VERIFIED_STATUSES.map(() => '?').join(',')})
            AND source_missing_at IS NULL`,
        VERIFIED_STATUSES),
      queryOne(db, "SELECT COUNT(*) AS n FROM clubs WHERE status = 'confirme'"),
    ]);
    return {
      players: Number(players?.n) || 0,
      places: Number(places?.n) || 0,
      clubs: Number(clubs?.n) || 0,
    };
  }

  router.get('/stats', asyncHandler(async (_req, res) => {
    if (!cached || now() - cachedAt > TTL_MS) {
      cached = await compute();
      cachedAt = now();
    }
    res.set('Cache-Control', 'public, max-age=600');
    res.json(cached);
  }));

  return router;
};
