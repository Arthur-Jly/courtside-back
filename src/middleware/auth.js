const jwt = require('jsonwebtoken');
const { UnauthorizedError, AppError } = require('./errorHandler');
const { queryOne } = require('../utils/dbHelpers');

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new AppError('JWT secret not configured', 500, false);
  return s;
}

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError());
  }
  try {
    req.user = jwt.verify(header.slice(7), getSecret());
    next();
  } catch {
    next(new UnauthorizedError('Token invalide ou expiré'));
  }
};

const requireClubAdmin = (req, res, next) => {
  if (req.user?.role !== 'club_admin') {
    return next(new UnauthorizedError('Accès réservé aux administrateurs de club'));
  }
  next();
};

// Verifies that the authenticated club_admin owns the :id (or alternate param name).
// Uses req.user.club_id from JWT. For terrains, performs a DB lookup.
function requireOwnClub(paramName = 'id') {
  return async (req, res, next) => {
    try {
      if (req.user?.role !== 'club_admin') return next(new UnauthorizedError('Accès refusé'));
      const claimedClubId = Number(req.params[paramName]);
      if (!Number.isFinite(claimedClubId)) return next(new UnauthorizedError('club_id invalide'));
      if (Number(req.user.club_id) !== claimedClubId) {
        return next(new UnauthorizedError("Vous n'êtes pas administrateur de ce club"));
      }
      next();
    } catch (e) { next(e); }
  };
}

// Verifies that the authenticated club_admin owns the terrain referenced in :terrainId.
function requireOwnTerrain(db, paramName = 'terrainId') {
  return async (req, res, next) => {
    try {
      if (req.user?.role !== 'club_admin') return next(new UnauthorizedError('Accès refusé'));
      const terrainId = Number(req.params[paramName]);
      if (!Number.isFinite(terrainId)) return next(new UnauthorizedError('terrain_id invalide'));
      const row = await queryOne(db, 'SELECT club_id FROM terrains WHERE id = ? LIMIT 1', [terrainId]);
      if (!row) return next(new UnauthorizedError('Terrain introuvable'));
      if (Number(row.club_id) !== Number(req.user.club_id)) {
        return next(new UnauthorizedError("Vous n'êtes pas administrateur de ce terrain"));
      }
      next();
    } catch (e) { next(e); }
  };
}

const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), getSecret());
    } catch {
      // invalid token — proceed without user
    }
  }
  next();
};

module.exports = { requireAuth, requireClubAdmin, requireOwnClub, requireOwnTerrain, optionalAuth };
