/**
 * Centralized error handling.
 */
const { logger } = require('../utils/logger');

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message) { super(message, 400); }
}
class UnauthorizedError extends AppError {
  constructor(message = 'Non autorisé') { super(message, 401); }
}
class ForbiddenError extends AppError {
  constructor(message = 'Accès refusé') { super(message, 403); }
}
class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') { super(message, 404); }
}
class ConflictError extends AppError {
  constructor(message) { super(message, 409); }
}

// Erreurs 4xx levées par les middlewares tiers (body-parser, multer) : sans ce
// mapping elles retombaient dans la branche « inconnue » et sortaient en 500.
function clientErrorOf(err) {
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
    return { status: 413, message: 'Requête ou fichier trop volumineux' };
  }
  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'Corps de requête invalide' };
  }
  if (err.name === 'MulterError') {
    return { status: 400, message: 'Envoi de fichier invalide' };
  }
  const status = Number(err.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, message: 'Requête invalide' };
  }
  return null;
}

const errorHandler = (err, req, res, _next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const rid = req.id ? ` [${req.id}]` : '';

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: err.message,
      requestId: req.id || null,
      ...(isDevelopment && { stack: err.stack }),
    });
  }

  const client = clientErrorOf(err);
  if (client) {
    return res.status(client.status).json({ error: client.message, requestId: req.id || null });
  }

  // Unknown — log and respond generically. Never leak internals.
  logger.error(`Unhandled error${rid}: ${err.message}\n${err.stack || ''}`);
  return res.status(500).json({
    error: 'Une erreur interne est survenue',
    requestId: req.id || null,
    ...(isDevelopment && { message: err.message }),
  });
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  errorHandler,
  asyncHandler,
};
