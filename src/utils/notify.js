const { logger } = require('./logger');
const sseHub = require('../services/sseHub');

/**
 * Fire-and-forget in-app notification.
 * Never throws: a failed notification must not break the calling flow.
 *
 * Types used so far: friend_request, friend_accept, invitation,
 * session_join, session_cancelled, reservation_confirmed.
 */
function notify(db, userId, type, payload = {}) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;
  db.query(
    'INSERT INTO notifications (user_id, type, payload, created_at) VALUES (?, ?, ?, NOW())',
    [uid, String(type).slice(0, 40), JSON.stringify(payload).slice(0, 2000)],
    (err) => {
      if (err) logger.error(`notify(${type}) failed for user ${uid}: ${err.message}`);
      else sseHub.push(uid, 'notification', { type, payload });
    }
  );
}

module.exports = { notify };
