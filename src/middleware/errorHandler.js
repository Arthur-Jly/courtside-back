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

const errorHandler = (err, req, res, _next) => {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(isDevelopment && { stack: err.stack }),
    });
  }

  // Unknown — log and respond generically. Never leak internals.
  logger.error(`Unhandled error: ${err.message}\n${err.stack || ''}`);
  return res.status(500).json({
    error: 'Une erreur interne est survenue',
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
