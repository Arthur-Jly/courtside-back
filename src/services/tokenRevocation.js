/**
 * Révocation des JWT par utilisateur.
 *
 * Un JWT est valide jusqu'à son expiration : après un reset de mot de passe,
 * une suppression de compte ou un changement de rôle, les jetons déjà émis
 * continuaient donc de fonctionner. On retient l'instant de révocation par
 * utilisateur et `requireAuth` refuse tout jeton émis avant.
 *
 * En mémoire, comme sseHub : suffisant en instance unique (les entrées
 * expirent avec la durée de vie maximale d'un jeton). Passer sur Redis ou une
 * colonne `users.tokens_valid_after` si l'on scale horizontalement.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const revokedAt = new Map();

function prune(now) {
  for (const [userId, at] of revokedAt) {
    if (now - at > RETENTION_MS) revokedAt.delete(userId);
  }
}

function revokeUser(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return;
  const now = Date.now();
  revokedAt.set(id, now);
  prune(now);
}

/** `iat` est en secondes : un jeton émis dans la même seconde que la révocation reste valide. */
function isRevoked(userId, iat) {
  const at = revokedAt.get(Number(userId));
  if (at === undefined) return false;
  return Number(iat) < Math.floor(at / 1000);
}

function reset() {
  revokedAt.clear();
}

module.exports = { revokeUser, isRevoked, reset };
