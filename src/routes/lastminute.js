const LastMinuteController = require('../controllers/lastminute.controller');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');

module.exports = function (db) {
  const express = require('express');
  const router = express.Router();
  const controller = new LastMinuteController(db);

  router.get('/lastminute', asyncHandler(async (req, res) => {
    const { sport, location } = req.query;
    const slots = await controller.getLastMinuteSlots({ sport, location });
    res.json({ last_minute_slots: slots, count: slots.length });
  }));

  router.get('/lastminute/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    try {
      const slot = await controller.getSlotById(id);
      res.json({ slot });
    } catch (err) {
      if (err.message === 'Créneau introuvable') throw new NotFoundError(err.message);
      throw err;
    }
  }));

  return router;
};
