const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const ClubsController = require('../controllers/clubs.controller');
const { requireAuth, requireClubAdmin, requireOwnClub, requireOwnTerrain } = require('../middleware/auth');
const { asyncHandler, NotFoundError, ForbiddenError } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');
const { logger } = require('../utils/logger');

const UPLOAD_DIR = path.join(__dirname, '../../uploads/terrains');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXT.has(ext) ? ext : '';
      cb(null, `terrain-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
      return cb(new Error('Type de fichier non autorisé'));
    }
    cb(null, true);
  },
});

const publicClubCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

const reqId = (req, name = 'id') => {
  const v = Number(req.params[name]);
  if (!Number.isFinite(v)) {
    const err = new Error(`${name} invalide`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return v;
};

module.exports = (db) => {
  const router = express.Router();
  const controller = new ClubsController(db);
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

  router.get('/clubs/list/names', asyncHandler(async (_req, res) => {
    const [rows] = await pool.query(
      "SELECT id, name, city FROM clubs WHERE status = 'confirme' ORDER BY name ASC"
    );
    res.json(rows);
  }));

  router.get('/clubs/stream', asyncHandler(async (req, res) => {
    const { lat, lon, sport, sport_type, radius, limit, city } = req.query;
    const sportFilter = sport_type || sport;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendData = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      await controller.getClubsStream({ lat, lon, sport: sportFilter, radius, limit, city }, sendData);
    } catch (e) {
      logger.error('SSE stream error: ' + e.message);
      res.write(`data: ${JSON.stringify({ error: 'Erreur serveur', done: true })}\n\n`);
    } finally {
      res.end();
    }
  }));

  router.get('/clubs', asyncHandler(async (req, res) => {
    const { lat, lon, sport, sport_type, radius, limit, city } = req.query;
    const clubs = await controller.getClubs({ lat, lon, sport: sport_type || sport, radius, limit, city });
    res.json(clubs);
  }));

  router.get('/partners', asyncHandler(async (_req, res) => {
    res.json(await controller.getPartners());
  }));

  router.get('/clubs/:id/kpis', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const id = reqId(req);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    const [[statsRows], [todayRows], [occRows]] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_res, SUM(price) AS revenue, COUNT(DISTINCT user_id) AS unique_users
         FROM reservations r
         JOIN slots s ON s.reservation_id = r.id
         WHERE s.club_id = ? AND DATE_FORMAT(r.date, '%Y-%m') = ?`,
        [id, currentMonth]
      ),
      pool.query(
        `SELECT s.*, t.name AS terrain_name, u.name AS who
         FROM slots s
         JOIN terrains t ON s.terrain_id = t.id
         LEFT JOIN reservations r ON s.reservation_id = r.id
         LEFT JOIN users u ON r.user_id = u.id
         WHERE s.club_id = ? AND DATE(s.date) = ?
         ORDER BY s.start_time`,
        [id, today]
      ),
      pool.query(
        `SELECT COUNT(*) AS total_slots,
                SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) AS booked_slots
         FROM slots WHERE club_id = ? AND DATE_FORMAT(date, '%Y-%m') = ?`,
        [id, currentMonth]
      ),
    ]);

    const stats = statsRows[0] || {};
    const occ = occRows[0] || {};
    const occRate = occ.total_slots > 0 ? Math.round((occ.booked_slots / occ.total_slots) * 100) : 0;

    res.json({
      kpis: [
        { label: 'Revenus du mois', value: `${Math.round(stats.revenue || 0)} €`, trend: 'up' },
        { label: 'Réservations', value: String(stats.total_res || 0), trend: 'up' },
        { label: "Taux d'occupation", value: `${occRate} %`, trend: 'up' },
        { label: 'Joueurs uniques', value: String(stats.unique_users || 0), trend: 'up' },
      ],
      today: (Array.isArray(todayRows) ? todayRows : []).map(s => ({
        time: String(s.start_time).slice(0, 5),
        court: s.terrain_name,
        who: s.who || '—',
        status: s.status === 'booked' ? 'Confirmé' : s.status === 'reserved_announcement' ? 'En attente' : 'Libre',
        price: s.price || 0,
      })),
    });
  }));

  router.get('/clubs/:id', asyncHandler(async (req, res) => {
    const club = await controller.getClubById(reqId(req));
    if (!club) throw new NotFoundError('Club introuvable');
    res.json(club);
  }));

  router.get('/clubs/:id/terrains', asyncHandler(async (req, res) => {
    res.json(await controller.getTerrainsByClubId(reqId(req)));
  }));

  router.get('/clubs/:id/sports', asyncHandler(async (req, res) => {
    res.json(await controller.getClubSports(reqId(req)));
  }));

  router.post('/clubs', publicClubCreateLimiter, validate(schemas.clubRequest), asyncHandler(async (req, res) => {
    const club = await controller.createClub(req.body);
    res.status(201).json({
      message: "Votre demande d'ajout de club a été envoyée avec succès. Nous vous contacterons sous 48h.",
      club,
    });
  }));

  router.post('/clubs/:id/sports', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { sportName } = req.body || {};
    if (typeof sportName !== 'string' || sportName.length < 1 || sportName.length > 50) {
      return res.status(400).json({ error: 'sportName invalide' });
    }
    try {
      const sport = await controller.addClubSport(reqId(req), sportName);
      res.status(201).json(sport);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ce sport existe déjà pour ce club' });
      throw e;
    }
  }));

  router.delete('/clubs/:id/sports/:sportName', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    await controller.removeClubSport(reqId(req), decodeURIComponent(req.params.sportName).slice(0, 50));
    res.status(204).send();
  }));

  router.post('/clubs/:id/terrains', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = req.body || {};
    if (!name || !sport_type || price_per_hour == null || slot_duration == null) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    const terrain = await controller.createTerrain({
      club_id: reqId(req),
      name: String(name).slice(0, 100),
      sport_type: String(sport_type).slice(0, 50),
      price_per_hour: Number(price_per_hour),
      slot_duration: parseInt(slot_duration, 10),
      recurring_availabilities: Array.isArray(recurring_availabilities) ? recurring_availabilities : [],
    });
    res.status(201).json(terrain);
  }));

  router.put('/clubs/:clubId/terrains/:terrainId',
    requireAuth, requireOwnClub('clubId'), requireOwnTerrain(db, 'terrainId'),
    asyncHandler(async (req, res) => {
      const terrainId = reqId(req, 'terrainId');
      const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = req.body || {};
      if (!name || !sport_type || price_per_hour == null || slot_duration == null) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
      }
      await controller.updateTerrain(terrainId, {
        name: String(name).slice(0, 100),
        sport_type: String(sport_type).slice(0, 50),
        price_per_hour: Number(price_per_hour),
        slot_duration: parseInt(slot_duration, 10),
        recurring_availabilities: Array.isArray(recurring_availabilities) ? recurring_availabilities : [],
      });
      res.status(200).json({ message: 'Terrain mis à jour avec succès' });
    }));

  router.delete('/clubs/:clubId/terrains/:terrainId',
    requireAuth, requireOwnClub('clubId'), requireOwnTerrain(db, 'terrainId'),
    asyncHandler(async (req, res) => {
      await controller.deleteTerrain(reqId(req, 'terrainId'));
      res.status(204).send();
    }));

  router.get('/db-status', requireAuth, requireClubAdmin, asyncHandler(async (_req, res) => {
    await pool.query('SELECT 1 AS ok');
    res.json({ status: 'ok' });
  }));

  router.get('/clubs/:clubId/terrains/:terrainId/images', asyncHandler(async (req, res) => {
    res.json(await controller.getTerrainImages(reqId(req, 'terrainId')));
  }));

  router.post('/clubs/:clubId/terrains/:terrainId/images',
    requireAuth, requireOwnClub('clubId'), requireOwnTerrain(db, 'terrainId'),
    upload.array('images', 10),
    asyncHandler(async (req, res) => {
      const terrainId = reqId(req, 'terrainId');
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Aucune image fournie' });
      }

      const existingImages = await controller.getTerrainImages(terrainId);
      let displayOrder = existingImages.length;

      try {
        const uploadedImages = [];
        for (const file of req.files) {
          const imageUrl = `/uploads/terrains/${file.filename}`;
          const image = await controller.addTerrainImage(terrainId, imageUrl, displayOrder++);
          uploadedImages.push(image);
        }
        res.status(201).json(uploadedImages);
      } catch (e) {
        for (const f of req.files) {
          try { fs.unlinkSync(f.path); } catch {}
        }
        throw e;
      }
    }));

  router.delete('/clubs/:clubId/terrains/:terrainId/images/:imageId',
    requireAuth, requireOwnClub('clubId'), requireOwnTerrain(db, 'terrainId'),
    asyncHandler(async (req, res) => {
      const imageId = reqId(req, 'imageId');
      const terrainId = reqId(req, 'terrainId');
      const images = await controller.getTerrainImages(terrainId);
      const imageToDelete = images.find(img => img.id === imageId);

      if (imageToDelete) {
        // Guard against path traversal — only delete files inside UPLOAD_DIR.
        const rel = String(imageToDelete.image_url).replace(/^\/+/, '');
        const filePath = path.normalize(path.join(__dirname, '../../', rel));
        const base = path.normalize(UPLOAD_DIR + path.sep);
        if (filePath.startsWith(base) && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) { logger.error('image unlink: ' + e.message); }
        }
      }
      await controller.deleteTerrainImage(imageId);
      res.status(204).send();
    }));

  router.get('/clubs/:id/details', asyncHandler(async (req, res) => {
    const details = await controller.getClubFullDetails(reqId(req));
    if (!details) throw new NotFoundError('Club introuvable');
    res.json(details);
  }));

  router.put('/clubs/:id/info', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { name, description, address, city, postal_code, phone, email, website } = req.body || {};
    await controller.updateClubInfo(reqId(req), { name, description, address, city, postal_code, phone, email, website });
    res.status(200).json({ message: 'Informations mises à jour avec succès' });
  }));

  router.put('/clubs/:id/opening-hours', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { hours } = req.body || {};
    if (!Array.isArray(hours)) return res.status(400).json({ error: 'Le champ hours doit être un tableau' });
    await controller.updateClubOpeningHours(reqId(req), hours);
    res.status(200).json({ message: 'Horaires mis à jour avec succès' });
  }));

  router.put('/clubs/:id/socials', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { socials } = req.body || {};
    if (!Array.isArray(socials)) return res.status(400).json({ error: 'Le champ socials doit être un tableau' });
    await controller.updateClubSocials(reqId(req), socials);
    res.status(200).json({ message: 'Réseaux sociaux mis à jour avec succès' });
  }));

  router.put('/clubs/:id/payment-methods', requireAuth, requireOwnClub('id'), asyncHandler(async (req, res) => {
    const { methods } = req.body || {};
    if (!Array.isArray(methods)) return res.status(400).json({ error: 'Le champ methods doit être un tableau' });
    await controller.updateClubPaymentMethods(reqId(req), methods);
    res.status(200).json({ message: 'Moyens de paiement mis à jour avec succès' });
  }));

  return router;
};
