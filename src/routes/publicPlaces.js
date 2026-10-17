/**
 * Routes des terrains publics (phase 1).
 * Lecture ouverte (on doit pouvoir découvrir des parties sans compte),
 * écriture authentifiée et limitée en débit.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const PublicPlacesController = require('../controllers/publicPlaces.controller');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');
const { track } = require('../utils/track');

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = (db, { coverage, verification, osmQueue } = {}) => {
  const router = express.Router();
  const controller = new PublicPlacesController(db, { coverage, verification, osmQueue });

  router.get('/public-places',
    validate(schemas.publicPlaceQuery, 'query'),
    asyncHandler(async (req, res) => {
      const places = await controller.search(req.query);
      // Rubrique « À confirmer (n) » : combien de terrains sans preuve la
      // recherche a écartés (inutile quand ils sont déjà inclus).
      const unverified = req.query.include_unverified ? undefined : await controller.countUnverified(req.query);
      res.json({ places, count: places.length, unverified_count: unverified });
    }));

  router.get('/public-places/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
    const place = await controller.getById(id);
    if (!place) throw new NotFoundError('Terrain introuvable');
    place.upcoming = await controller.getUpcomingAnnouncements(id);
    res.json({ place });
  }));

  router.post('/public-places/:id/confirm', requireAuth, writeLimiter,
    validate(schemas.publicPlaceConfirm),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
      const result = await controller.confirm(id, req.user.id, req.body || {});
      if (!result) throw new NotFoundError('Terrain introuvable');
      // Une confirmation n'a de valeur que de quelqu'un qui y a joué ou qui y est.
      if (result.notEligible) {
        return res.status(403).json({
          error: 'Pour confirmer ce terrain, sois sur place (active ta position) ou participe à une partie qui s’y joue.',
        });
      }
      track(db, 'place_confirmed', {
        userId: req.user.id, placeId: id,
        payload: { confirmations: result.confirmations_count, status: result.verification_status },
      });
      res.json({ success: true, ...result });
    }));

  router.post('/public-places/:id/report',
    requireAuth, writeLimiter,
    validate(schemas.publicPlaceReport),
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
      const result = await controller.report(id, req.user.id, req.body);
      if (!result) throw new NotFoundError('Terrain introuvable');
      // Suivi de la qualité du référentiel : un pic de signalements sur une
      // ville signale un import à revoir, pas seulement un terrain.
      track(db, 'place_reported', {
        userId: req.user.id, placeId: id,
        payload: { kind: req.body.kind, reports: result.reports_count, status: result.verification_status },
      });
      res.status(201).json({ success: true, ...result });
    }));

  router.post('/public-places',
    requireAuth, writeLimiter,
    validate(schemas.publicPlaceCreate),
    asyncHandler(async (req, res) => {
      const place = await controller.createFromUser(req.body, req.user.id);
      res.status(201).json({ success: true, place });
    }));

  return router;
};
