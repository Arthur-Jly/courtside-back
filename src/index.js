require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const helmet = require('helmet');
const hpp = require('hpp');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { httpLogger, logger } = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandler');

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!JWT_SECRET || JWT_SECRET === 'votre_secret_jwt' || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and >=32 chars.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: NODE_ENV === 'production' ? undefined : false,
}));

const rawCors = process.env.CORS_ORIGIN || 'http://localhost:5173';
const corsAllowlist = rawCors.split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (corsAllowlist.includes('*')) {
      if (NODE_ENV === 'production') return cb(new Error('CORS: wildcard origin disabled in production'));
      return cb(null, true);
    }
    if (corsAllowlist.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: !corsAllowlist.includes('*'),
};
app.use(cors(corsOptions));

// DB pool
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
});

db.getConnection((err, conn) => {
  if (err) {
    logger.error('MySQL connection error: ' + err.message);
    process.exit(1);
  }
  conn.release();
  logger.info('Connected to MySQL');
});

// CRITICAL: Stripe webhook needs RAW body. Mount BEFORE express.json().
const paymentsModule = require('./routes/payments');
app.use('/api', paymentsModule.webhook(db));

// Body parsers with hard limits
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(hpp());
app.use(httpLogger);

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', globalLimiter);

// Static uploads with strict headers
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  dotfiles: 'deny',
  index: false,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  },
}));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const usersRouter = require('./routes/users')(db);
const clubsRouter = require('./routes/clubs')(db);
const authRouter = require('./routes/auth')(db, JWT_SECRET);
const lastminuteRouter = require('./routes/lastminute')(db);
const eventsRouter = require('./routes/events')(db);
const chatsRouter = require('./routes/chats')(db);
const slotsRouter = require('./routes/slots')(db);
const reservationRouter = require('./routes/reservation')(db);
const geocodingRouter = require('./routes/geocoding')(db);
const reviewsRouter = require('./routes/reviews')(db);
const financesRouter = require('./routes/finances')(db);
const announcementsRouter = require('./routes/announcements')(db);
const paymentsRouter = paymentsModule(db);

const CronService = require('./services/cronService');
const cronService = new CronService(db);
cronService.start();

app.use('/api', usersRouter);
app.use('/api', clubsRouter);
app.use('/api/auth', authRouter);
app.use('/api', lastminuteRouter);
app.use('/api', eventsRouter);
app.use('/api', chatsRouter);
app.use('/api', slotsRouter);
app.use('/api', reservationRouter);
app.use('/api', geocodingRouter);
app.use('/api', reviewsRouter);
app.use('/api', financesRouter);
app.use('/api', announcementsRouter);
app.use('/api', paymentsRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

app.use(errorHandler);

const server = app.listen(PORT, () => {
  logger.info(`Serveur API à l'écoute sur le port ${PORT}`);
});

function shutdown(signal) {
  logger.info(`Signal ${signal} reçu, arrêt en cours...`);
  cronService.stop();
  server.close(() => {
    db.end(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection: ' + (reason && reason.message || reason));
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception: ' + err.message);
  shutdown('uncaughtException');
});
