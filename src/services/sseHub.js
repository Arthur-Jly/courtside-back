/**
 * In-memory SSE hub: one long-lived response per connected client,
 * indexed by user id. Single-instance only (fine for the current
 * deployment); swap for Redis pub/sub if the API is ever scaled out.
 */
const { logger } = require('../utils/logger');

const clients = new Map(); // userId -> Set<res>

function addClient(userId, res) {
  const uid = Number(userId);
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
}

function removeClient(userId, res) {
  const uid = Number(userId);
  const set = clients.get(uid);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(uid);
}

/** Pushes an SSE event to every open connection of a user. No-op if offline. */
function push(userId, event, data) {
  const set = clients.get(Number(userId));
  if (!set || set.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch (e) {
      logger.warn('SSE write failed: ' + e.message);
    }
  }
}

function connectedCount() {
  return clients.size;
}

module.exports = { addClient, removeClient, push, connectedCount };
