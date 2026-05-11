const express = require('express');
const { asyncHandler, NotFoundError } = require('../middleware/errorHandler');
const { queryPromise, queryOne } = require('../utils/dbHelpers');

const EVENT_SQL = `
  SELECT e.id, e.club_id, e.terrain_id, e.title, e.description,
         e.event_type, e.start_time, e.end_time, e.external_link, e.created_at,
         c.name AS club_name, c.city AS club_city,
         GROUP_CONCAT(DISTINCT ei.image_url) AS images
  FROM events e
  LEFT JOIN clubs c ON e.club_id = c.id AND c.status = 'confirme'
  LEFT JOIN event_images ei ON e.id = ei.event_id
`;

function shapeEvent(event) {
  return {
    ...event,
    images: event.images ? event.images.split(',') : [],
    location: event.club_city ? `${event.club_name}, ${event.club_city}` : 'France',
  };
}

module.exports = function(db) {
  const router = express.Router();

  router.get('/events', asyncHandler(async (req, res) => {
    const events = await queryPromise(db, EVENT_SQL + ' GROUP BY e.id ORDER BY e.start_time ASC');
    res.json({ events: events.map(shapeEvent) });
  }));

  router.get('/events/upcoming', asyncHandler(async (req, res) => {
    const events = await queryPromise(db, EVENT_SQL + ' WHERE e.start_time >= NOW() GROUP BY e.id ORDER BY e.start_time ASC');
    res.json({ events: events.map(shapeEvent) });
  }));

  router.get('/events/:id', asyncHandler(async (req, res) => {
    const event = await queryOne(db, EVENT_SQL + ' WHERE e.id = ? GROUP BY e.id', [req.params.id]);
    if (!event) throw new NotFoundError('Événement non trouvé');
    res.json(shapeEvent(event));
  }));

  return router;
};
