const express = require('express');
const jwt = require('jsonwebtoken');
const sseHub = require('../services/sseHub');
const { logger } = require('../utils/logger');

module.exports = () => {
  const router = express.Router();

  /**
   * SSE stream. EventSource cannot send an Authorization header, so the
   * JWT travels as a query param — standard for SSE; keep tokens short-lived
   * and make sure access logs redact query strings in production.
   */
  router.get('/realtime/stream', (req, res) => {
    const token = req.query.token;
    let user;
    try {
      user = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token invalide' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: disable proxy buffering
    });
    res.write(': connected\n\n');

    sseHub.addClient(user.id, res);
    logger.debug(`SSE connect user=${user.id} (${sseHub.connectedCount()} online)`);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseHub.removeClient(user.id, res);
      logger.debug(`SSE disconnect user=${user.id}`);
    });
  });

  return router;
};
