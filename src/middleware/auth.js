const jwt = require('jsonwebtoken');
const { UnauthorizedError } = require('./errorHandler');

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError());
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'votre_secret_jwt');
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

const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'votre_secret_jwt');
    } catch {
      // invalid token — proceed without user
    }
  }
  next();
};

module.exports = { requireAuth, requireClubAdmin, optionalAuth };
