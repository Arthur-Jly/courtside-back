/**
 * Anonymisation d'un compte (RGPD) — une seule implémentation pour la
 * suppression par l'utilisateur (`DELETE /users/me`) et par un admin
 * (`DELETE /admin/users/:id`). Avant, la version admin oubliait les push,
 * notifications, messages, profil et notes : le compte « supprimé » gardait
 * des données personnelles et continuait de recevoir des notifications.
 *
 * On ne supprime jamais la ligne `users` : les FK (réservations, avis, messages)
 * la référencent. On tue le login et on retire toute donnée personnelle.
 */
const { queryPromise } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const { revokeUser } = require('./tokenRevocation');

async function anonymizeAccount(db, userId) {
  const purge = async (sql, params) => {
    try {
      await queryPromise(db, sql, params);
    } catch (e) {
      // Une table absente est tolérée, mais un échec de purge RGPD doit laisser une trace.
      logger.warn(`Anonymisation user=${userId}: étape ignorée (${e.code || e.message}) — ${sql.slice(0, 60)}`);
    }
  };

  // 1. Relations personnelles et invitations en cours.
  await purge('DELETE FROM favorites WHERE user_id = ?', [userId]);
  await purge('DELETE FROM amis WHERE user_id_1 = ? OR user_id_2 = ?', [userId, userId]);
  await purge('DELETE FROM annonce_invitations WHERE user_id = ? OR invited_by = ?', [userId, userId]);
  await purge('DELETE FROM password_resets WHERE user_id = ?', [userId]);
  await purge('DELETE FROM annonce_participants WHERE user_id = ?', [userId]);
  await purge('DELETE FROM notifications WHERE user_id = ?', [userId]);
  await purge('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
  await purge('DELETE FROM user_profiles WHERE user_id = ?', [userId]);
  await purge('DELETE FROM player_ratings WHERE rater_id = ? OR rated_user_id = ?', [userId, userId]);

  // 2. Réservations futures annulées, créneaux rendus au club.
  await purge(
    "UPDATE slots SET status = 'free', reservation_id = NULL WHERE reservation_id IN (SELECT id FROM reservations WHERE user_id = ? AND (status = 'confirmed' OR status = 'active') AND start_time > NOW())",
    [userId]
  );
  await purge(
    "UPDATE reservations SET status = 'cancelled' WHERE user_id = ? AND (status = 'confirmed' OR status = 'active') AND start_time > NOW()",
    [userId]
  );

  // 3. Messages : l'historique reste lisible pour les autres, sans donnée personnelle.
  await purge(
    "UPDATE messages SET content = 'Message supprimé (compte anonymisé)' WHERE sender_id = ?",
    [userId]
  );

  // 4. Sessions organisées : pas de parties publiques orphelines.
  await purge(
    "UPDATE announcements SET status = 'cancelled' WHERE created_by = ? AND status IN ('active', 'confirmed')",
    [userId]
  );

  // 5. Le compte : intégrité des FK conservée, login et données personnelles supprimés.
  await queryPromise(db, `
    UPDATE users SET
      name = 'Utilisateur supprimé',
      email = CONCAT('deleted-', id, '@deleted.invalid'),
      username = NULL,
      password_hash = 'account-deleted',
      avatar = NULL,
      club_id = NULL
    WHERE id = ?
  `, [userId]);

  // Le jeton encore valide ne doit plus rien autoriser.
  revokeUser(userId);
}

module.exports = { anonymizeAccount };
