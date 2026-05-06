/**
 * Route pour le géocodage Google Maps
 * Sécurise la clé API côté serveur
 */

const express = require('express');
const axios = require('axios');

module.exports = function(db) {
  const router = express.Router();

  /**
   * GET /api/geocode?address=Paris
   * Géocode une adresse vers des coordonnées
   */
  router.get('/geocode', async (req, res) => {
    const { address } = req.query;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    try {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      
      if (!GOOGLE_MAPS_API_KEY) {
        return res.status(500).json({ error: 'Google Maps API key not configured' });
      }

      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
      
      const response = await axios.get(url);
      const data = response.data;

      if (data.status === 'OK' && data.results && data.results.length > 0) {
        const coords = data.results[0].geometry.location;
        return res.json({
          success: true,
          lat: coords.lat,
          lng: coords.lng,
          formattedAddress: data.results[0].formatted_address
        });
      } else {
        return res.status(404).json({
          success: false,
          error: 'Address not found',
          status: data.status
        });
      }
    } catch (error) {
      console.error('Geocoding error:', error);
      return res.status(500).json({
        success: false,
        error: 'Geocoding service error'
      });
    }
  });

  /**
   * GET /api/autocomplete?input=Par
   * Suggestions de lieux via Google Places API
   */
  router.get('/autocomplete', async (req, res) => {
    const { input } = req.query;

    if (!input || input.length < 3) {
      return res.status(400).json({ error: 'Input must be at least 3 characters' });
    }

    try {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      
      if (!GOOGLE_MAPS_API_KEY) {
        return res.status(500).json({ error: 'Google Maps API key not configured' });
      }

      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:fr&key=${GOOGLE_MAPS_API_KEY}`;
      
      const response = await axios.get(url);
      const data = response.data;

      if (data.status === 'OK' && data.predictions) {
        const suggestions = data.predictions.slice(0, 8).map(p => ({
          description: p.description,
          placeId: p.place_id,
          mainText: p.structured_formatting?.main_text || p.description,
          secondaryText: p.structured_formatting?.secondary_text || '',
        }));
        
        return res.json({
          success: true,
          suggestions
        });
      } else {
        return res.json({
          success: true,
          suggestions: []
        });
      }
    } catch (error) {
      console.error('Autocomplete error:', error);
      return res.status(500).json({
        success: false,
        error: 'Autocomplete service error'
      });
    }
  });

  /**
   * GET /api/geocode/place?placeId=ChIJ...
   * Géocode un placeId Google vers des coordonnées
   */
  router.get('/geocode/place', async (req, res) => {
    const { placeId } = req.query;

    if (!placeId) {
      return res.status(400).json({ error: 'placeId is required' });
    }

    try {
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

      if (!GOOGLE_MAPS_API_KEY) {
        return res.status(500).json({ error: 'Google Maps API key not configured' });
      }

      const url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${GOOGLE_MAPS_API_KEY}`;
      const response = await axios.get(url);
      const data = response.data;

      if (data.status === 'OK' && data.results?.length > 0) {
        const coords = data.results[0].geometry.location;
        return res.json({
          success: true,
          lat: coords.lat,
          lng: coords.lng,
          formattedAddress: data.results[0].formatted_address,
        });
      }
      return res.status(404).json({ success: false, error: 'Place not found' });
    } catch (error) {
      console.error('Place geocoding error:', error);
      return res.status(500).json({ success: false, error: 'Geocoding service error' });
    }
  });

  /**
   * GET /api/sports
   * Liste des sports disponibles
   */
  router.get('/sports', (req, res) => {
    const sql = 'SELECT DISTINCT sport FROM `terrains` ORDER BY sport';
    
    db.query(sql, (err, results) => {
      if (err) {
        console.error('Error fetching sports:', err);
        // Fallback sur une liste par défaut
        return res.json({
          success: true,
          sports: [
            "Football", "Basketball", "Tennis", "Natation", 
            "Volleyball", "Badminton", "Course à pied", 
            "Cyclisme", "Escalade", "Fitness", "Padel"
          ]
        });
      }

      const sports = results.map(r => r.sport).filter(Boolean);
      
      res.json({
        success: true,
        sports: sports.length > 0 ? sports : [
          "Football", "Basketball", "Tennis", "Natation", 
          "Volleyball", "Badminton", "Course à pied", 
          "Cyclisme", "Escalade", "Fitness", "Padel"
        ]
      });
    });
  });

  return router;
};
