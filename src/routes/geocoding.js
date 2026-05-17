const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate, schemas } = require('../middleware/validation');
const { optionalAuth } = require('../middleware/auth');
const { logger } = require('../utils/logger');

const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const axiosClient = axios.create({
  timeout: 5000,
  maxRedirects: 0,
  maxContentLength: 1024 * 1024,
});

module.exports = function (db) {
  const router = express.Router();
  const pool = (db && typeof db.promise === 'function') ? db.promise() : db;

  router.get('/geocode', optionalAuth, geocodeLimiter, validate(schemas.geocodeQuery, 'query'), asyncHandler(async (req, res) => {
    const { address } = req.query;
    const KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!KEY) return res.status(503).json({ error: 'Service indisponible' });

    try {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json';
      const { data } = await axiosClient.get(url, { params: { address, key: KEY } });
      if (data.status === 'OK' && data.results?.length > 0) {
        const coords = data.results[0].geometry.location;
        return res.json({ success: true, lat: coords.lat, lng: coords.lng, formattedAddress: data.results[0].formatted_address });
      }
      return res.status(404).json({ success: false, error: 'Address not found', status: data.status });
    } catch (e) {
      logger.error('Geocoding error: ' + e.message);
      return res.status(502).json({ success: false, error: 'Geocoding service error' });
    }
  }));

  router.get('/autocomplete', optionalAuth, geocodeLimiter, validate(schemas.autocompleteQuery, 'query'), asyncHandler(async (req, res) => {
    const { input } = req.query;
    const KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!KEY) return res.status(503).json({ error: 'Service indisponible' });
    try {
      const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
      const { data } = await axiosClient.get(url, { params: { input, components: 'country:fr', key: KEY } });
      if (data.status === 'OK' && data.predictions) {
        const suggestions = data.predictions.slice(0, 8).map(p => ({
          description: p.description,
          placeId: p.place_id,
          mainText: p.structured_formatting?.main_text || p.description,
          secondaryText: p.structured_formatting?.secondary_text || '',
        }));
        return res.json({ success: true, suggestions });
      }
      return res.json({ success: true, suggestions: [] });
    } catch (e) {
      logger.error('Autocomplete error: ' + e.message);
      return res.status(502).json({ success: false, error: 'Autocomplete service error' });
    }
  }));

  router.get('/geocode/place', optionalAuth, geocodeLimiter, asyncHandler(async (req, res) => {
    const placeId = String(req.query.placeId || '').slice(0, 255);
    if (!placeId) return res.status(400).json({ error: 'placeId is required' });
    const KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!KEY) return res.status(503).json({ error: 'Service indisponible' });
    try {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json';
      const { data } = await axiosClient.get(url, { params: { place_id: placeId, key: KEY } });
      if (data.status === 'OK' && data.results?.length > 0) {
        const coords = data.results[0].geometry.location;
        return res.json({ success: true, lat: coords.lat, lng: coords.lng, formattedAddress: data.results[0].formatted_address });
      }
      return res.status(404).json({ success: false, error: 'Place not found' });
    } catch (e) {
      logger.error('Place geocoding error: ' + e.message);
      return res.status(502).json({ success: false, error: 'Geocoding service error' });
    }
  }));

  router.get('/sports', asyncHandler(async (_req, res) => {
    const FALLBACK = ['Football', 'Basketball', 'Tennis', 'Natation', 'Volleyball', 'Badminton', 'Course à pied', 'Cyclisme', 'Escalade', 'Fitness', 'Padel'];
    try {
      const [results] = await pool.query('SELECT DISTINCT sport FROM `terrains` ORDER BY sport');
      const sports = results.map(r => r.sport).filter(Boolean);
      res.json({ success: true, sports: sports.length > 0 ? sports : FALLBACK });
    } catch (e) {
      logger.error('Sports fetch: ' + e.message);
      res.json({ success: true, sports: FALLBACK });
    }
  }));

  return router;
};
