/**
 * Middleware de gestion centralisée des erreurs
 */

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Erreurs communes
 */
class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Non autorisé') {
    super(message, 401);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Ressource introuvable') {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409);
  }
}

/**
 * Handler global d'erreurs
 */
const errorHandler = (err, req, res, next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  // Erreur opérationnelle connue
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(isDevelopment && { stack: err.stack })
    });
  }

  // Erreur inconnue/système
  console.error('ERREUR NON GÉRÉE:', err);
  
  return res.status(500).json({
    error: 'Une erreur interne est survenue',
    ...(isDevelopment && { 
      message: err.message,
      stack: err.stack 
    })
  });
};

/**
 * Wrapper async pour éviter try/catch partout
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = {
  AppError,
  ValidationError,
  UnauthorizedError,
  NotFoundError,
  ConflictError,
  errorHandler,
  asyncHandler
};
