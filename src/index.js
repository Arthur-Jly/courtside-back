// Charger les variables d'environnement depuis .env
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const JWT_SECRET = process.env.JWT_SECRET || 'votre_secret_jwt'; 

const app = express();
const port = 3001;

app.use(express.json());
app.use(cors());

app.use('/uploads', express.static(require('path').join(__dirname, '..', 'uploads')));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} -> ${req.method} ${req.url}`);
  next();
});

// health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const db = mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
});

db.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
    throw err;
  }
  console.log('Connected to MySQL:', (process.env.DB_HOST || '127.0.0.1') + ':' + (process.env.DB_PORT || 3306));
});

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
const paymentsRouter = require('./routes/payments')(db);

// Démarrer le service de tâches automatiques (cron jobs)
const CronService = require('./services/cronService');
const cronService = new CronService(db);
cronService.start();

app.use('/api', usersRouter);
app.use('/api', clubsRouter);
app.use('/api/auth', authRouter);  // Monté sous /api/auth au lieu de /api
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

app.listen(port, () => {
  console.log(`Serveur API Sport à l'écoute sur le port ${port}`);
});

// Arrêter gracieusement les cron jobs lors de l'arrêt du serveur
process.on('SIGTERM', () => {
  console.log('⏹️ Arrêt du serveur...');
  cronService.stop();
  db.end();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('⏹️ Arrêt du serveur...');
  cronService.stop();
  db.end();
  process.exit(0);
});
