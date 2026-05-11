const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ClubsController = require('../controllers/clubs.controller');
const { requireAuth, requireClubAdmin } = require('../middleware/auth');

// Configuration de multer pour l'upload d'images
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/terrains');
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'terrain-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // Limite à 5MB
  },
  fileFilter: function (req, file, cb) {
    // Accepter uniquement les images
    const filetypes = /jpeg|jpg|png|gif|webp/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Seules les images sont autorisées (jpeg, jpg, png, gif, webp)'));
  }
});

module.exports = (db) => {
  const router = express.Router();
  const controller = new ClubsController(db);

  /**
   * GET /api/clubs/list/names
   * Récupère la liste simplifiée des clubs (id, name) pour dropdown
   * IMPORTANT: Cette route doit être AVANT /clubs/:id pour éviter que "list" soit interprété comme un ID
   */
  router.get('/clubs/list/names', (req, res) => {
    const sql = "SELECT id, name, city FROM clubs WHERE status = 'confirme' ORDER BY name ASC";
    db.query(sql, (err, clubs) => {
      if (err) {
        console.error('Erreur lors de la récupération de la liste des clubs:', err);
        return res.status(500).json({ 
          error: 'Erreur lors de la récupération de la liste des clubs',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
      res.json(clubs);
    });
  });

  /**
   * GET /api/clubs/stream
   * Récupère les clubs avec streaming progressif (SSE)
   * Query params: lat, lon, sport, radius, limit
   */
  router.get('/clubs/stream', async (req, res) => {
    try {
      const { lat, lon, sport, sport_type, radius, limit, city } = req.query;
      const sportFilter = sport_type || sport;
      
      // Configuration SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Fonction callback pour envoyer les données
      const sendData = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Appeler la méthode de streaming
      await controller.getClubsStream(
        { lat, lon, sport: sportFilter, radius, limit, city },
        sendData
      );

      // Fermer la connexion
      res.end();
    } catch (err) {
      console.error('Erreur lors du streaming des clubs:', err);
      // Envoyer l'erreur en format SSE
      res.write(`data: ${JSON.stringify({ error: 'Erreur serveur', done: true })}\n\n`);
      res.end();
    }
  });

  /**
   * GET /api/clubs
   * Récupère les clubs avec filtres optionnels
   * Query params: lat, lon, sport, radius, limit
   */
  router.get('/clubs', async (req, res) => {
    try {
      const { lat, lon, sport, sport_type, radius, limit, city } = req.query;
      const sportFilter = sport_type || sport;
      const clubs = await controller.getClubs({ lat, lon, sport: sportFilter, radius, limit, city });
      
      res.json(clubs);
    } catch (err) {
      console.error('Erreur lors de la récupération des clubs:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des clubs', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/partners
   * Récupère la liste simplifiée des partenaires
   */
  router.get('/partners', async (req, res) => {
    try {
      const partners = await controller.getPartners();
      res.json(partners);
    } catch (err) {
      console.error('Erreur lors de la récupération des partenaires:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des partenaires',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/clubs/:id/kpis
   * Retourne les KPIs du club pour le dashboard admin
   */
  router.get('/clubs/:id/kpis', requireAuth, requireClubAdmin, (req, res) => {
    const { id } = req.params;
    const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

    const currentMonth = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_res,
                SUM(price) AS revenue,
                COUNT(DISTINCT user_id) AS unique_users
         FROM reservations r
         JOIN slots s ON s.reservation_id = r.id
         WHERE s.club_id = ?
           AND DATE_FORMAT(r.date, '%Y-%m') = ?`,
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
         FROM slots
         WHERE club_id = ? AND DATE_FORMAT(date, '%Y-%m') = ?`,
        [id, currentMonth]
      ),
    ]).then(([[statsRows], [todayRows], [occRows]]) => {
      const stats = statsRows[0] || {};
      const occ = occRows[0] || {};
      const occRate = occ.total_slots > 0
        ? Math.round((occ.booked_slots / occ.total_slots) * 100)
        : 0;

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
    }).catch(err => {
      res.status(500).json({ error: 'Erreur KPIs club', details: err.message });
    });
  });

  /**
   * GET /api/clubs/:id
   * Récupère un club spécifique par son ID
   */
  router.get('/clubs/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const club = await controller.getClubById(parseInt(id));
      
      res.json(club);
    } catch (err) {
      console.error('Erreur lors de la récupération du club:', err);
      
      if (err.message === 'Club introuvable') {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la récupération du club',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * GET /api/clubs/:id/terrains
   * Récupère les terrains d'un club
   */
  router.get('/clubs/:id/terrains', async (req, res) => {
    try {
      const { id } = req.params;
      const terrains = await controller.getTerrainsByClubId(parseInt(id));
      
      res.json(terrains);
    } catch (err) {
      console.error('Erreur lors de la récupération des terrains:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des terrains',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/clubs/:id/sports
   * Récupère les sports d'un club
   */
  router.get('/clubs/:id/sports', async (req, res) => {
    try {
      const { id } = req.params;
      const sports = await controller.getClubSports(parseInt(id));
      
      res.json(sports);
    } catch (err) {
      console.error('Erreur lors de la récupération des sports:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des sports',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/clubs
   * Crée une nouvelle demande de club (status = 'attente')
   * Body: { name, city, phone, email, address?, postal_code?, description?, contactPersonName, contactPersonEmail }
   */
  router.post('/clubs', async (req, res) => {
    try {
      const { name, city, phone, email, address, postal_code, description } = req.body;

      // Validation des champs requis
      if (!name || !city || !phone || !email) {
        return res.status(400).json({ 
          error: 'Les champs name, city, phone et email sont requis',
          required: ['name', 'city', 'phone', 'email']
        });
      }

      const club = await controller.createClub({
        name,
        city,
        phone,
        email,
        address,
        postal_code,
        description
      });
      
      res.status(201).json({ 
        message: 'Votre demande d\'ajout de club a été envoyée avec succès. Nous vous contacterons sous 48h.',
        club 
      });
    } catch (err) {
      console.error('Erreur lors de la création du club:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la création du club',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/clubs/:id/sports
   * Ajoute un sport à un club
   * Body: { sportName: string }
   */
  router.post('/clubs/:id/sports', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { sportName } = req.body;

      if (!sportName) {
        return res.status(400).json({ error: 'Le nom du sport est requis' });
      }

      const sport = await controller.addClubSport(parseInt(id), sportName);
      
      res.status(201).json(sport);
    } catch (err) {
      console.error('Erreur lors de l\'ajout du sport:', err);
      
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Ce sport existe déjà pour ce club' });
      }
      
      res.status(500).json({ 
        error: 'Erreur lors de l\'ajout du sport',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * DELETE /api/clubs/:id/sports/:sportName
   * Supprime un sport d'un club
   */
  router.delete('/clubs/:id/sports/:sportName', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id, sportName } = req.params;

      await controller.removeClubSport(parseInt(id), decodeURIComponent(sportName));
      
      res.status(204).send();
    } catch (err) {
      console.error('Erreur lors de la suppression du sport:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la suppression du sport',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/clubs/:id/terrains
   * Crée un nouveau terrain
   * Body: { name, sport_type, price_per_hour, slot_duration, recurring_availabilities }
   */
  router.post('/clubs/:id/terrains', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = req.body;

      if (!name || !sport_type || !price_per_hour || !slot_duration) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
      }

      const terrain = await controller.createTerrain({
        club_id: parseInt(id),
        name,
        sport_type,
        price_per_hour: parseFloat(price_per_hour),
        slot_duration: parseInt(slot_duration),
        recurring_availabilities: recurring_availabilities || []
      });
      
      res.status(201).json(terrain);
    } catch (err) {
      console.error('Erreur lors de la création du terrain:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la création du terrain',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * PUT /api/clubs/:clubId/terrains/:terrainId
   * Met à jour un terrain
   * Body: { name, sport_type, price_per_hour, slot_duration, recurring_availabilities }
   */
  router.put('/clubs/:clubId/terrains/:terrainId', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { terrainId } = req.params;
      const { name, sport_type, price_per_hour, slot_duration, recurring_availabilities } = req.body;

      if (!name || !sport_type || !price_per_hour || !slot_duration) {
        return res.status(400).json({ error: 'Tous les champs sont requis' });
      }

      await controller.updateTerrain(parseInt(terrainId), {
        name,
        sport_type,
        price_per_hour: parseFloat(price_per_hour),
        slot_duration: parseInt(slot_duration),
        recurring_availabilities: recurring_availabilities || []
      });
      
      res.status(200).json({ message: 'Terrain mis à jour avec succès' });
    } catch (err) {
      console.error('Erreur lors de la mise à jour du terrain:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la mise à jour du terrain',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * DELETE /api/clubs/:clubId/terrains/:terrainId
   * Supprime un terrain
   */
  router.delete('/clubs/:clubId/terrains/:terrainId', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { terrainId } = req.params;

      await controller.deleteTerrain(parseInt(terrainId));
      
      res.status(204).send();
    } catch (err) {
      console.error('Erreur lors de la suppression du terrain:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la suppression du terrain',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/db-status (internal health check — auth required)
   */
  router.get('/db-status', requireAuth, (req, res) => {
    db.query('SELECT 1 AS ok', (err) => {
      if (err) return res.status(500).json({ status: 'error', message: 'DB unreachable' });
      res.json({ status: 'ok' });
    });
  });

  /**
   * GET /api/clubs/:clubId/terrains/:terrainId/images
   * Récupère les images d'un terrain
   */
  router.get('/clubs/:clubId/terrains/:terrainId/images', async (req, res) => {
    try {
      const { terrainId } = req.params;
      const images = await controller.getTerrainImages(parseInt(terrainId));
      
      res.json(images);
    } catch (err) {
      console.error('Erreur lors de la récupération des images:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des images',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * POST /api/clubs/:clubId/terrains/:terrainId/images
   * Ajoute une ou plusieurs images à un terrain
   * Multipart form-data avec le champ "images"
   */
  router.post('/clubs/:clubId/terrains/:terrainId/images', requireAuth, requireClubAdmin, upload.array('images', 10), async (req, res) => {
    try {
      const { terrainId } = req.params;
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Aucune image fournie' });
      }

      // Récupérer le nombre d'images existantes pour l'ordre d'affichage
      const existingImages = await controller.getTerrainImages(parseInt(terrainId));
      let displayOrder = existingImages.length;

      const uploadedImages = [];
      for (const file of req.files) {
        // Construire l'URL de l'image (sera accessible via le serveur statique)
        const imageUrl = `/uploads/terrains/${file.filename}`;
        
        const image = await controller.addTerrainImage(
          parseInt(terrainId),
          imageUrl,
          displayOrder++
        );
        
        uploadedImages.push(image);
      }
      
      res.status(201).json(uploadedImages);
    } catch (err) {
      console.error('Erreur lors de l\'upload des images:', err);
      
      // Supprimer les fichiers uploadés en cas d'erreur
      if (req.files) {
        req.files.forEach(file => {
          fs.unlink(file.path, (unlinkErr) => {
            if (unlinkErr) console.error('Erreur lors de la suppression du fichier:', unlinkErr);
          });
        });
      }
      
      res.status(500).json({ 
        error: 'Erreur lors de l\'upload des images',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * DELETE /api/clubs/:clubId/terrains/:terrainId/images/:imageId
   * Supprime une image d'un terrain
   */
  router.delete('/clubs/:clubId/terrains/:terrainId/images/:imageId', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { imageId } = req.params;
      
      // Récupérer l'info de l'image avant de la supprimer pour effacer le fichier
      const images = await controller.getTerrainImages(parseInt(req.params.terrainId));
      const imageToDelete = images.find(img => img.id === parseInt(imageId));
      
      if (imageToDelete) {
        // Supprimer le fichier physique
        const filePath = path.join(__dirname, '../../', imageToDelete.image_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      // Supprimer l'entrée en BDD
      await controller.deleteTerrainImage(parseInt(imageId));
      
      res.status(204).send();
    } catch (err) {
      console.error('Erreur lors de la suppression de l\'image:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la suppression de l\'image',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/clubs/:id/details
   * Récupère toutes les informations détaillées d'un club
   * (infos de base + sports + images + horaires + réseaux sociaux + moyens de paiement)
   */
  router.get('/clubs/:id/details', async (req, res) => {
    try {
      const { id } = req.params;
      const clubDetails = await controller.getClubFullDetails(parseInt(id));
      
      res.json(clubDetails);
    } catch (err) {
      console.error('Erreur lors de la récupération des détails du club:', err);
      
      if (err.message === 'Club introuvable') {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la récupération des détails du club',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  /**
   * PUT /api/clubs/:id/info
   * Met à jour les informations de base d'un club
   * Body: { name, description, address, city, postal_code, phone, email, website }
   */
  router.put('/clubs/:id/info', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, address, city, postal_code, phone, email, website } = req.body;

      await controller.updateClubInfo(parseInt(id), {
        name, description, address, city, postal_code, phone, email, website
      });
      
      res.status(200).json({ message: 'Informations mises à jour avec succès' });
    } catch (err) {
      console.error('Erreur lors de la mise à jour des informations:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la mise à jour des informations',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * PUT /api/clubs/:id/opening-hours
   * Met à jour les horaires d'ouverture d'un club
   * Body: { hours: [{day_of_week, open_time, close_time, is_closed}] }
   */
  router.put('/clubs/:id/opening-hours', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { hours } = req.body;

      if (!Array.isArray(hours)) {
        return res.status(400).json({ error: 'Le champ hours doit être un tableau' });
      }

      await controller.updateClubOpeningHours(parseInt(id), hours);
      
      res.status(200).json({ message: 'Horaires mis à jour avec succès' });
    } catch (err) {
      console.error('Erreur lors de la mise à jour des horaires:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la mise à jour des horaires',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * PUT /api/clubs/:id/socials
   * Met à jour les réseaux sociaux d'un club
   * Body: { socials: [{type, url}] }
   */
  router.put('/clubs/:id/socials', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { socials } = req.body;

      if (!Array.isArray(socials)) {
        return res.status(400).json({ error: 'Le champ socials doit être un tableau' });
      }

      await controller.updateClubSocials(parseInt(id), socials);
      
      res.status(200).json({ message: 'Réseaux sociaux mis à jour avec succès' });
    } catch (err) {
      console.error('Erreur lors de la mise à jour des réseaux sociaux:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la mise à jour des réseaux sociaux',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * PUT /api/clubs/:id/payment-methods
   * Met à jour les moyens de paiement d'un club
   * Body: { methods: ['CB', 'Stripe', 'PayPal'] }
   */
  router.put('/clubs/:id/payment-methods', requireAuth, requireClubAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { methods } = req.body;

      if (!Array.isArray(methods)) {
        return res.status(400).json({ error: 'Le champ methods doit être un tableau' });
      }

      await controller.updateClubPaymentMethods(parseInt(id), methods);
      
      res.status(200).json({ message: 'Moyens de paiement mis à jour avec succès' });
    } catch (err) {
      console.error('Erreur lors de la mise à jour des moyens de paiement:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la mise à jour des moyens de paiement',
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  return router;
};