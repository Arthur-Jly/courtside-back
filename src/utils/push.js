/**
 * Web Push (VAPID).
 *
 * Sans push, une partie publiée le matin pour le soir ne se remplit pas : le SSE
 * ne vit que pendant qu'un onglet est ouvert. C'est donc une brique de la
 * phase 1, pas un confort.
 *
 * Configuration : `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
 * (mailto:… ou URL). Générer une paire :  npx web-push generate-vapid-keys
 * Sans clés, le module est inerte — l'app tourne normalement, sans push.
 *
 * iOS : la notification n'arrive que si l'app a été ajoutée à l'écran d'accueil.
 */
const webpush = require('web-push');
const { logger } = require('./logger');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@courtside.fr';

let enabled = false;
if (PUBLIC_KEY && PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    enabled = true;
  } catch (e) {
    logger.error(`Web Push: clés VAPID invalides — push désactivé (${e.message})`);
  }
} else {
  logger.info('Web Push: VAPID_PUBLIC_KEY/PRIVATE_KEY absents — push désactivé');
}

/** Libellés poussés à l'appareil. Courts : une notification se lit d'un œil. */
const MESSAGES = {
  session_join:      (p) => ({ title: 'Un joueur a rejoint', body: `${p.from_name || 'Un joueur'} rejoint ta partie.`, url: '/matchs' }),
  invitation:        (p) => ({ title: 'Invitation à une partie', body: `${p.from_name || 'Un joueur'} t'invite à jouer.`, url: '/matchs' }),
  waitlist_spot:     () => ({ title: 'Une place s\'est libérée', body: 'Une place vient de se libérer sur une partie.', url: '/matchs' }),
  session_cancelled: () => ({ title: 'Partie annulée', body: 'Une partie à laquelle tu participais est annulée.', url: '/matchs' }),
  new_game_nearby:   (p) => ({ title: 'Nouvelle partie près de chez toi', body: p.summary || 'Une partie vient d\'être publiée dans ta ville.', url: '/matchs' }),
  friend_request:    (p) => ({ title: 'Demande d\'ami', body: `${p.from_name || 'Un joueur'} veut être ton ami.`, url: '/profil' }),
  reservation_confirmed: () => ({ title: 'Réservation confirmée', body: 'Ta réservation est confirmée.', url: '/profil' }),
};

function describe(type, payload = {}) {
  const build = MESSAGES[type];
  return build ? build(payload) : null;
}

/**
 * Envoi à tous les appareils d'un utilisateur. Fire-and-forget : un push raté ne
 * doit jamais casser l'action qui l'a déclenché. Les endpoints morts (404/410)
 * sont supprimés — sinon la table se remplit d'abonnements fantômes.
 */
function pushToUser(db, userId, type, payload = {}) {
  if (!enabled) return;
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return;

  const message = describe(type, payload);
  if (!message) return;

  db.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    [uid],
    (err, rows) => {
      if (err) { logger.error(`push: lecture des abonnements échouée (${err.message})`); return; }
      for (const row of rows || []) {
        const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
        webpush.sendNotification(subscription, JSON.stringify({ ...message, type }))
          .then(() => {
            db.query('UPDATE push_subscriptions SET last_success_at = NOW(), failure_count = 0 WHERE id = ?', [row.id], () => {});
          })
          .catch((e) => {
            const gone = e.statusCode === 404 || e.statusCode === 410;
            if (gone) {
              db.query('DELETE FROM push_subscriptions WHERE id = ?', [row.id], () => {});
            } else {
              db.query('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?', [row.id], () => {});
              logger.error(`push: envoi échoué (${e.statusCode || '?'}) pour l'abonnement ${row.id}`);
            }
          });
      }
    },
  );
}

function pushToUsers(db, userIds, type, payload = {}) {
  for (const id of userIds || []) pushToUser(db, id, type, payload);
}

module.exports = {
  pushToUser,
  pushToUsers,
  describe,
  publicKey: PUBLIC_KEY,
  isEnabled: () => enabled,
};
