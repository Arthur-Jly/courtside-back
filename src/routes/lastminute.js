const LastMinuteController = require('../controllers/lastminute.controller');

module.exports = function(db) {
  const express = require('express');
  const router = express.Router();
  const controller = new LastMinuteController(db);

  /**
   * GET /api/lastminute
   * Récupère les créneaux last minute avec filtres optionnels
   * Query params: sport, location
   */
  router.get('/lastminute', async (req, res) => {
    try {
      const { sport, location } = req.query;
      const slots = await controller.getLastMinuteSlots({ sport, location });
      
      res.json({ 
        last_minute_slots: slots,
        count: slots.length 
      });
    } catch (err) {
      console.error('Erreur lors de la récupération des créneaux:', err);
      res.status(500).json({ 
        error: 'Erreur lors de la récupération des créneaux last minute', 
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  });

  /**
   * GET /api/lastminute/:id
   * Récupère un créneau spécifique par son ID
   */
  router.get('/lastminute/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const slot = await controller.getSlotById(parseInt(id));
      
      res.json({ slot });
    } catch (err) {
      console.error('Erreur lors de la récupération du créneau:', err);
      
      if (err.message === 'Créneau introuvable') {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ 
          error: 'Erreur lors de la récupération du créneau',
          details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
    }
  });

  return router;
};
