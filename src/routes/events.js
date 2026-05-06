module.exports = function(db) {
  const express = require('express');
  const router = express.Router();

  // GET /api/events - Récupérer tous les événements
  router.get('/events', (req, res) => {
    const sql = `
      SELECT e.id, e.club_id, e.terrain_id, e.title, e.description, 
             e.event_type, e.start_time, e.end_time, e.external_link, e.created_at,
             c.name AS club_name, c.city AS club_city,
             GROUP_CONCAT(DISTINCT ei.image_url) AS images
      FROM events e
      LEFT JOIN clubs c ON e.club_id = c.id AND c.status = 'confirme'
      LEFT JOIN event_images ei ON e.id = ei.event_id
      GROUP BY e.id
      ORDER BY e.start_time ASC
    `;
    
    db.query(sql, (err, events) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur events', details: err });
      }
      
      // Transforme la chaîne images en tableau et ajoute la localisation
      const eventsWithImages = events.map(event => ({
        ...event,
        images: event.images ? event.images.split(',') : [],
        location: event.club_city ? `${event.club_name}, ${event.club_city}` : 'France'
      }));
      
      res.json({ events: eventsWithImages });
    });
  });

  // GET /api/events/upcoming - Récupérer les événements à venir
  router.get('/events/upcoming', (req, res) => {
    const sql = `
      SELECT e.id, e.club_id, e.terrain_id, e.title, e.description, 
             e.event_type, e.start_time, e.end_time, e.external_link, e.created_at,
             c.name AS club_name, c.city AS club_city,
             GROUP_CONCAT(DISTINCT ei.image_url) AS images
      FROM events e
      LEFT JOIN clubs c ON e.club_id = c.id AND c.status = 'confirme'
      LEFT JOIN event_images ei ON e.id = ei.event_id
      WHERE e.start_time >= NOW()
      GROUP BY e.id
      ORDER BY e.start_time ASC
    `;
    
    db.query(sql, (err, events) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur events', details: err });
      }
      
      const eventsWithImages = events.map(event => ({
        ...event,
        images: event.images ? event.images.split(',') : [],
        location: event.club_city ? `${event.club_name}, ${event.club_city}` : 'France'
      }));
      
      res.json({ events: eventsWithImages });
    });
  });

  // GET /api/events/:id - Récupérer un événement par son ID
  router.get('/events/:id', (req, res) => {
    const { id } = req.params;
    
    const sql = `
      SELECT e.id, e.club_id, e.terrain_id, e.title, e.description, 
             e.event_type, e.start_time, e.end_time, e.external_link, e.created_at,
             c.name AS club_name, c.city AS club_city,
             GROUP_CONCAT(DISTINCT ei.image_url) AS images
      FROM events e
      LEFT JOIN clubs c ON e.club_id = c.id AND c.status = 'confirme'
      LEFT JOIN event_images ei ON e.id = ei.event_id
      WHERE e.id = ?
      GROUP BY e.id
    `;
    
    db.query(sql, [id], (err, results) => {
      if (err) {
        return res.status(500).json({ error: 'Erreur event', details: err });
      }
      
      if (results.length === 0) {
        return res.status(404).json({ error: 'Événement non trouvé' });
      }
      
      const event = results[0];
      res.json({
        ...event,
        images: event.images ? event.images.split(',') : [],
        location: event.club_city ? `${event.club_name}, ${event.club_city}` : 'France'
      });
    });
  });

  return router;
};