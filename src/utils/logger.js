/**
 * Logger structuré pour le backend
 * Remplace les console.log dispersés
 */

const chalk = require('chalk');

const LOG_LEVELS = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
  HTTP: 'http'
};

class Logger {
  constructor() {
    this.isDevelopment = process.env.NODE_ENV === 'development';
  }

  _log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...meta
    };

    // En production, on pourrait envoyer à un service (Sentry, etc.)
    if (!this.isDevelopment && level === LOG_LEVELS.ERROR) {
      // TODO: Send to error tracking service
    }

    // Console output avec couleurs
    const colors = {
      error: chalk.red,
      warn: chalk.yellow,
      info: chalk.blue,
      debug: chalk.gray,
      http: chalk.green
    };

    const colorFn = colors[level] || chalk.white;
    const hasExtra = meta !== null && meta !== undefined && meta !== '';
    console.log(
      colorFn(`[${timestamp}] [${level.toUpperCase()}]`),
      message,
      hasExtra ? meta : ''
    );
  }

  error(message, meta = {}) {
    this._log(LOG_LEVELS.ERROR, message, meta);
  }

  warn(message, meta = {}) {
    this._log(LOG_LEVELS.WARN, message, meta);
  }

  info(message, meta = {}) {
    this._log(LOG_LEVELS.INFO, message, meta);
  }

  debug(message, meta = {}) {
    if (this.isDevelopment) {
      this._log(LOG_LEVELS.DEBUG, message, meta);
    }
  }

  http(req, res, duration) {
    // Strip query string from logged URL — query params can carry tokens or PII.
    const urlPath = (req.originalUrl || req.url || '').split('?')[0];
    const message = `${req.method} ${urlPath} - ${res.statusCode} - ${duration}ms`;
    this._log(LOG_LEVELS.HTTP, message, {
      method: req.method,
      url: urlPath,
      status: res.statusCode,
      duration,
      ip: req.ip,
    });
  }
}

// Singleton
const logger = new Logger();

/**
 * Middleware HTTP logging
 */
const httpLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(req, res, duration);
  });
  
  next();
};

module.exports = {
  logger,
  httpLogger
};
