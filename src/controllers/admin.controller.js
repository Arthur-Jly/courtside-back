/**
 * Contrôleur de l'espace super-admin plateforme (Courtside Admin).
 *
 * Distinct du club_admin : l'admin voit toute la plateforme, valide les
 * demandes de clubs (attente -> confirme/rejete) et consulte les KPIs globaux.
 *
 * Le flow d'invitation (confirmClub) génère un jeton, l'enregistre hashé dans
 * club_invitations et envoie un email au gérant pour qu'il crée son compte
 * relié au club. Même mécanique que password_resets.
 */
const crypto = require('crypto');
const { queryPromise, queryOne } = require('../utils/dbHelpers');
const emailService = require('../services/emailService');
const { logger } = require('../utils/logger');

const INVITE_TTL_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class AdminController {
  constructor(db) {
    this.db = db;
  }

  /**
   * Liste des clubs, filtrable par statut (attente/confirme/rejete).
   * Renvoie toutes les infos utiles à la revue + nb de terrains.
   */
  async listClubs({ status } = {}) {
    let sql = `
      SELECT c.id, c.name, c.city, c.address, c.postal_code, c.phone, c.email,
             c.description, c.status, c.created_at, c.reviewed_at, c.reject_reason,
             (SELECT COUNT(*) FROM terrains t WHERE t.club_id = c.id) AS terrains_count
      FROM clubs c
    `;
    const params = [];
    if (status) {
      sql += ' WHERE c.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY c.created_at DESC';
    return queryPromise(this.db, sql, params);
  }

  async getClubDetail(id) {
    const club = await queryOne(this.db, `
      SELECT c.*,
             (SELECT COUNT(*) FROM terrains t WHERE t.club_id = c.id) AS terrains_count,
             (SELECT COUNT(*) FROM users u WHERE u.club_id = c.id) AS managers_count
      FROM clubs c WHERE c.id = ?`, [id]);
    return club;
  }

  /** Détail club enrichi : terrains, gérants, revenu, réservations, avis. */
  async getClubDetailFull(id) {
    const club = await this.getClubDetail(id);
    if (!club) return null;

    const terrains = await queryPromise(this.db,
      'SELECT id, name, sport_type, price_per_hour, slot_duration FROM terrains WHERE club_id = ? ORDER BY name', [id]);
    const managers = await queryPromise(this.db,
      'SELECT id, name, email, created_at FROM users WHERE club_id = ? ORDER BY created_at', [id]);
    const [res] = await queryPromise(this.db, `
      SELECT COUNT(*) AS count, COALESCE(SUM(r.price), 0) AS revenue
      FROM reservations r JOIN terrains t ON r.terrain_id = t.id
      WHERE t.club_id = ? AND r.status IN ('confirmed', 'paid')`, [id]);
    const [rev] = await queryPromise(this.db,
      'SELECT COUNT(*) AS count, AVG(rating) AS avg FROM reviews WHERE club_id = ?', [id]);
    const [last] = await queryPromise(this.db, `
      SELECT MAX(r.created_at) AS last_reservation
      FROM reservations r JOIN terrains t ON r.terrain_id = t.id WHERE t.club_id = ?`, [id]);

    return {
      ...club,
      terrains,
      managers,
      reservations: { count: Number(res.count), revenue: Number(res.revenue) },
      reviews: { count: Number(rev.count), avg: rev.avg != null ? Number(Number(rev.avg).toFixed(2)) : null },
      last_activity: last.last_reservation || null,
    };
  }

  /**
   * Suspend un club confirmé (retiré des listings publics, qui filtrent tous
   * `status = 'confirme'`) ou le réactive.
   */
  async setClubSuspension(id, suspended, adminId, reason) {
    const club = await queryOne(this.db, 'SELECT id, status FROM clubs WHERE id = ?', [id]);
    if (!club) return { notFound: true };
    if (suspended && club.status !== 'confirme') return { invalid: 'Seul un club confirmé peut être suspendu.' };
    if (!suspended && club.status !== 'suspendu') return { invalid: 'Ce club n\'est pas suspendu.' };

    if (suspended) {
      await queryPromise(this.db,
        "UPDATE clubs SET status = 'suspendu', reviewed_by = ?, reviewed_at = NOW(), reject_reason = ? WHERE id = ?",
        [adminId, reason || null, id]);
    } else {
      await queryPromise(this.db,
        "UPDATE clubs SET status = 'confirme', reviewed_by = ?, reviewed_at = NOW(), reject_reason = NULL WHERE id = ?",
        [adminId, id]);
    }
    return { club: await this.getClubDetailFull(id) };
  }

  // ── Modération : sessions publiques (annonces) ────────────────────────────

  async listAnnouncements({ status, sport, page = 1, limit = 25 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const where = [];
    const params = [];
    if (status && ['active', 'expired', 'cancelled', 'validated'].includes(status)) {
      where.push('a.status = ?'); params.push(status);
    }
    if (sport) { where.push('LOWER(a.sport_type) = ?'); params.push(String(sport).toLowerCase()); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ total }] = await queryPromise(this.db,
      `SELECT COUNT(*) AS total FROM announcements a ${whereSql}`, params);

    const rows = await queryPromise(this.db, `
      SELECT a.id, a.sport_type, a.status, a.slot_start, a.slot_end, a.places_total,
             a.places_disponibles, a.description, a.created_at, a.visibility,
             a.manual_city, a.manual_address,
             u.id AS creator_id, u.name AS creator_name, u.email AS creator_email,
             c.name AS club_name,
             (SELECT COUNT(*) FROM annonce_participants ap WHERE ap.annonce_id = a.id) AS participants_count
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN terrains t ON a.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id
      ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?`, [...params, lim, off]);

    return { announcements: rows, total: Number(total), page: Number(page) || 1, limit: lim };
  }

  /** Force l'annulation d'une session (modération). Libère le créneau si lié. */
  async cancelAnnouncement(id) {
    const a = await queryOne(this.db, 'SELECT id, status, slot_id FROM announcements WHERE id = ?', [id]);
    if (!a) return { notFound: true };
    if (a.status === 'cancelled') return { invalid: 'Session déjà annulée.' };
    await queryPromise(this.db, "UPDATE announcements SET status = 'cancelled' WHERE id = ?", [id]);
    if (a.slot_id) {
      await queryPromise(this.db, "UPDATE slots SET status = 'free' WHERE id = ?", [a.slot_id]).catch(() => {});
    }
    return { cancelled: true };
  }

  // ── Modération : avis ─────────────────────────────────────────────────────

  async listReviews({ page = 1, limit = 25 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const [{ total }] = await queryPromise(this.db, 'SELECT COUNT(*) AS total FROM reviews');
    const rows = await queryPromise(this.db, `
      SELECT r.id, r.rating, r.comment, r.response, r.created_at,
             r.club_id, r.public_place_id,
             c.name AS club_name,
             u.id AS user_id, u.name AS user_name, u.email AS user_email
      FROM reviews r
      LEFT JOIN clubs c ON r.club_id = c.id
      LEFT JOIN users u ON r.user_id = u.id
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?`, [lim, off]);
    return { reviews: rows, total: Number(total), page: Number(page) || 1, limit: lim };
  }

  async deleteReview(id) {
    const review = await queryOne(this.db, 'SELECT id FROM reviews WHERE id = ?', [id]);
    if (!review) return { notFound: true };
    await queryPromise(this.db, 'DELETE FROM reviews WHERE id = ?', [id]);
    return { deleted: true };
  }

  // ── Activité (messagerie) ─────────────────────────────────────────────────

  /**
   * Métriques de volumétrie de la messagerie.
   *
   * PRIVACY : uniquement des COUNT/agrégats. Aucun contenu de message, aucun
   * expéditeur, aucun participant n'est exposé — l'admin n'a pas à lire les
   * conversations des utilisateurs.
   */
  async getActivityMetrics() {
    const [chats] = await queryPromise(this.db, `
      SELECT
        COUNT(*) AS total,
        SUM(type = 'private') AS private_chats,
        SUM(type = 'group') AS group_chats,
        SUM(type = 'annonce') AS session_chats
      FROM chats`);

    const [messages] = await queryPromise(this.db, `
      SELECT
        COUNT(*) AS total,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last_7d,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS last_30d
      FROM messages`);

    const [active] = await queryPromise(this.db, `
      SELECT COUNT(DISTINCT chat_id) AS active_7d
      FROM messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`);

    const [notifs] = await queryPromise(this.db, `
      SELECT COUNT(*) AS total, SUM(read_at IS NULL) AS unread
      FROM notifications`);

    const n = (v) => Number(v || 0);
    const chatTotal = n(chats.total);
    return {
      chats: {
        total: chatTotal,
        private: n(chats.private_chats),
        group: n(chats.group_chats),
        session: n(chats.session_chats),
        active_7d: n(active.active_7d),
      },
      messages: {
        total: n(messages.total),
        last_7d: n(messages.last_7d),
        last_30d: n(messages.last_30d),
        avg_per_chat: chatTotal > 0 ? Number((n(messages.total) / chatTotal).toFixed(1)) : 0,
      },
      notifications: { total: n(notifs.total), unread: n(notifs.unread) },
    };
  }

  /** Messages par jour sur N jours (volumétrie, pas de contenu). */
  async getMessagesTimeseries(days = 30) {
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    const rows = await queryPromise(this.db, `
      SELECT DATE(created_at) AS d, COUNT(*) AS v
      FROM messages
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)`, [n]);
    const byDate = {};
    for (const r of rows) {
      const key = r.d instanceof Date
        ? `${r.d.getFullYear()}-${String(r.d.getMonth() + 1).padStart(2, '0')}-${String(r.d.getDate()).padStart(2, '0')}`
        : String(r.d).slice(0, 10);
      byDate[key] = Number(r.v);
    }
    const out = [];
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({ date: key, value: byDate[key] || 0 });
    }
    return out;
  }

  /**
   * Confirme un club (attente -> confirme), enregistre la décision, puis
   * génère + envoie une invitation au gérant (email du club).
   * @returns {Promise<{club, invitationSent:boolean}>}
   */
  async confirmClub(id, adminId) {
    const club = await queryOne(this.db, 'SELECT id, name, email, status FROM clubs WHERE id = ?', [id]);
    if (!club) return { notFound: true };

    await queryPromise(this.db,
      "UPDATE clubs SET status = 'confirme', reviewed_by = ?, reviewed_at = NOW(), reject_reason = NULL WHERE id = ?",
      [adminId, id]);

    let invitationSent = false;
    if (club.email) {
      invitationSent = await this.sendInvitation(id, club.email, club.name).catch((e) => {
        logger.error('sendInvitation failed: ' + e.message);
        return false;
      });
    }

    const updated = await this.getClubDetail(id);
    return { club: updated, invitationSent };
  }

  /** Rejette un club (attente -> rejete) avec raison optionnelle. */
  async rejectClub(id, adminId, reason) {
    const club = await queryOne(this.db, 'SELECT id FROM clubs WHERE id = ?', [id]);
    if (!club) return { notFound: true };
    await queryPromise(this.db,
      "UPDATE clubs SET status = 'rejete', reviewed_by = ?, reviewed_at = NOW(), reject_reason = ? WHERE id = ?",
      [adminId, reason || null, id]);
    return { club: await this.getClubDetail(id) };
  }

  /**
   * Génère un jeton d'invitation, l'enregistre hashé, envoie l'email.
   * Invalide les invitations précédentes non utilisées pour ce club.
   */
  async sendInvitation(clubId, email, clubName) {
    await queryPromise(this.db,
      'UPDATE club_invitations SET used_at = NOW() WHERE club_id = ? AND used_at IS NULL', [clubId]);

    const token = crypto.randomBytes(32).toString('hex');
    await queryPromise(this.db,
      `INSERT INTO club_invitations (club_id, email, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW())`,
      [clubId, email, hashToken(token), INVITE_TTL_DAYS]);

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const inviteUrl = `${baseUrl}/rejoindre-club?token=${token}`;
    await emailService.sendClubInvitation(email, { inviteUrl, clubName });
    logger.info(`Club invitation sent club=${clubId}`);
    return true;
  }

  /** KPIs plateforme (agrégats globaux, toutes clubs confondus). */
  async getPlatformStats() {
    const [users] = await queryPromise(this.db, `
      SELECT
        COUNT(*) AS total,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new_7d,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_30d,
        SUM(role = 'club_admin') AS club_admins,
        SUM(role = 'player') AS players
      FROM users`);

    const [clubs] = await queryPromise(this.db, `
      SELECT
        SUM(status = 'attente') AS attente,
        SUM(status = 'confirme') AS confirme,
        SUM(status = 'rejete') AS rejete,
        COUNT(*) AS total
      FROM clubs`);

    const [reservations] = await queryPromise(this.db, `
      SELECT
        COUNT(*) AS total,
        SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS last_7d
      FROM reservations
      WHERE status IN ('confirmed', 'paid')`);

    // Revenu depuis reservations.price (status confirmed/paid), pas depuis la table
    // payments (sous-remplie : le webhook Stripe écrit directement dans reservations).
    const [revenue] = await queryPromise(this.db, `
      SELECT
        COALESCE(SUM(price), 0) AS total,
        COALESCE(SUM(CASE WHEN start_time >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN price ELSE 0 END), 0) AS last_7d
      FROM reservations
      WHERE status IN ('confirmed', 'paid')`);

    const [announcements] = await queryPromise(this.db, `
      SELECT
        COUNT(*) AS total,
        SUM(status = 'active') AS open
      FROM announcements`);

    const n = (v) => Number(v || 0);
    return {
      users: { total: n(users.total), new_7d: n(users.new_7d), new_30d: n(users.new_30d), club_admins: n(users.club_admins), players: n(users.players) },
      clubs: { attente: n(clubs.attente), confirme: n(clubs.confirme), rejete: n(clubs.rejete), total: n(clubs.total) },
      reservations: { total: n(reservations.total), last_7d: n(reservations.last_7d) },
      revenue: { total: n(revenue.total), last_7d: n(revenue.last_7d) },
      announcements: { total: n(announcements.total), open: n(announcements.open) },
    };
  }

  /**
   * Séries temporelles quotidiennes pour les graphiques de la vue d'ensemble.
   * @param {string} metric - revenue | reservations | users
   * @param {number} days   - fenêtre (défaut 30, max 365)
   * Renvoie [{ date: 'YYYY-MM-DD', value }] avec les jours vides à 0.
   */
  async getTimeseries(metric, days = 30) {
    const n = Math.min(Math.max(Number(days) || 30, 1), 365);
    let rows;
    if (metric === 'revenue') {
      rows = await queryPromise(this.db, `
        SELECT DATE(r.start_time) AS d, COALESCE(SUM(r.price), 0) AS v
        FROM reservations r
        WHERE r.status IN ('confirmed', 'paid') AND r.start_time >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(r.start_time)`, [n]);
    } else if (metric === 'users') {
      rows = await queryPromise(this.db, `
        SELECT DATE(created_at) AS d, COUNT(*) AS v
        FROM users
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)`, [n]);
    } else { // reservations
      rows = await queryPromise(this.db, `
        SELECT DATE(created_at) AS d, COUNT(*) AS v
        FROM reservations
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY DATE(created_at)`, [n]);
    }
    // Remplir les jours manquants à 0.
    const byDate = {};
    for (const r of rows) {
      const key = r.d instanceof Date
        ? `${r.d.getFullYear()}-${String(r.d.getMonth() + 1).padStart(2, '0')}-${String(r.d.getDate()).padStart(2, '0')}`
        : String(r.d).slice(0, 10);
      byDate[key] = Number(r.v);
    }
    const out = [];
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({ date: key, value: byDate[key] || 0 });
    }
    return out;
  }

  // ── Utilisateurs ──────────────────────────────────────────────────────────

  /** Liste paginée + recherche (nom/email/pseudo) + filtre rôle. */
  async listUsers({ query, role, page = 1, limit = 25 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const where = [];
    const params = [];
    if (query && query.trim()) {
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)');
      const p = `%${query.trim().toLowerCase()}%`;
      params.push(p, p, p);
    }
    if (role && ['player', 'club_admin', 'admin'].includes(role)) {
      where.push('u.role = ?');
      params.push(role);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ total }] = await queryPromise(this.db,
      `SELECT COUNT(*) AS total FROM users u ${whereSql}`, params);

    const rows = await queryPromise(this.db, `
      SELECT u.id, u.name, u.email, u.username, u.role, u.club_id, u.created_at,
             c.name AS club_name,
             (SELECT COUNT(*) FROM reservations r WHERE r.user_id = u.id) AS reservations_count
      FROM users u
      LEFT JOIN clubs c ON u.club_id = c.id
      ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`, [...params, lim, off]);

    return { users: rows, total: Number(total), page: Number(page) || 1, limit: lim };
  }

  async getUserDetail(id) {
    const user = await queryOne(this.db, `
      SELECT u.id, u.name, u.email, u.username, u.role, u.club_id, u.created_at, c.name AS club_name
      FROM users u LEFT JOIN clubs c ON u.club_id = c.id WHERE u.id = ?`, [id]);
    if (!user) return null;

    const profile = await queryOne(this.db,
      'SELECT bio, city, birthdate, sports, is_public FROM user_profiles WHERE user_id = ?', [id]);
    const [counts] = await queryPromise(this.db, `
      SELECT
        (SELECT COUNT(*) FROM reservations WHERE user_id = ?) AS reservations,
        (SELECT COUNT(*) FROM announcements WHERE created_by = ?) AS announcements,
        (SELECT COUNT(*) FROM reviews WHERE user_id = ?) AS reviews,
        (SELECT COUNT(*) FROM amis WHERE (user_id_1 = ? OR user_id_2 = ?) AND status = 'accepted') AS friends`,
      [id, id, id, id, id]);
    const [fairplay] = await queryPromise(this.db,
      'SELECT AVG(rating) AS avg, COUNT(*) AS count FROM player_ratings WHERE rated_user_id = ?', [id]);

    return {
      ...user,
      profile: profile || null,
      counts: {
        reservations: Number(counts.reservations), announcements: Number(counts.announcements),
        reviews: Number(counts.reviews), friends: Number(counts.friends),
      },
      fairplay: { avg: fairplay.avg != null ? Number(Number(fairplay.avg).toFixed(2)) : null, count: Number(fairplay.count) },
    };
  }

  /** Change le rôle d'un user. Si le nouveau rôle n'est pas club_admin, délie le club. */
  async setUserRole(id, role) {
    if (!['player', 'club_admin', 'admin'].includes(role)) return { invalid: true };
    const user = await queryOne(this.db, 'SELECT id FROM users WHERE id = ?', [id]);
    if (!user) return { notFound: true };
    if (role === 'club_admin') {
      await queryPromise(this.db, 'UPDATE users SET role = ? WHERE id = ?', [role, id]);
    } else {
      await queryPromise(this.db, 'UPDATE users SET role = ?, club_id = NULL WHERE id = ?', [role, id]);
    }
    return { user: await this.getUserDetail(id) };
  }

  /** Export RGPD d'un user (même contenu que l'export self). */
  async exportUser(id) {
    const grab = async (sql, params) => { try { return await queryPromise(this.db, sql, params); } catch { return []; } };
    const [user] = await grab('SELECT id, name, email, username, role, created_at FROM users WHERE id = ?', [id]);
    if (!user) return null;
    const profile = await grab('SELECT bio, city, birthdate, sports, is_public FROM user_profiles WHERE user_id = ?', [id]);
    const reservations = await grab('SELECT id, terrain_id, start_time, end_time, price, status, created_at FROM reservations WHERE user_id = ?', [id]);
    const favorites = await grab('SELECT terrain_id, created_at FROM favorites WHERE user_id = ?', [id]);
    const friends = await grab('SELECT user_id_1, user_id_2, status FROM amis WHERE user_id_1 = ? OR user_id_2 = ?', [id, id]);
    const announcements = await grab('SELECT id, sport_type, places_total, status, created_at FROM announcements WHERE created_by = ?', [id]);
    const reviews = await grab('SELECT id, club_id, rating, comment, created_at FROM reviews WHERE user_id = ?', [id]);
    return {
      exported_at: new Date().toISOString(),
      user, profile: profile[0] || null,
      reservations, favorites, friends, announcements, reviews,
    };
  }

  /** Anonymise un user (même logique que la suppression RGPD self). */
  async deleteUser(id) {
    const user = await queryOne(this.db, 'SELECT id, role FROM users WHERE id = ?', [id]);
    if (!user) return { notFound: true };
    if (user.role === 'admin') return { forbidden: true }; // on ne supprime pas un admin par erreur

    const purge = async (sql, params) => { try { await queryPromise(this.db, sql, params); } catch { /* noop */ } };
    await purge('DELETE FROM favorites WHERE user_id = ?', [id]);
    await purge('DELETE FROM amis WHERE user_id_1 = ? OR user_id_2 = ?', [id, id]);
    await purge('DELETE FROM annonce_invitations WHERE user_id = ? OR invited_by = ?', [id, id]);
    await purge('DELETE FROM password_resets WHERE user_id = ?', [id]);
    await purge('DELETE FROM annonce_participants WHERE user_id = ?', [id]);
    await queryPromise(this.db, `
      UPDATE users SET name = 'Utilisateur supprimé',
        email = CONCAT('deleted-', id, '@deleted.invalid'),
        username = NULL, password_hash = 'account-deleted', avatar = NULL, club_id = NULL
      WHERE id = ?`, [id]);
    return { deleted: true };
  }

  // ── Réservations ──────────────────────────────────────────────────────────

  /** Liste plateforme paginée, filtres statut/club/période. */
  async listReservations({ status, clubId, from, to, page = 1, limit = 25 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
    const where = [];
    const params = [];
    if (status && ['pending', 'confirmed', 'cancelled', 'paid'].includes(status)) {
      where.push('r.status = ?'); params.push(status);
    }
    if (clubId) { where.push('t.club_id = ?'); params.push(Number(clubId)); }
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('DATE(r.start_time) >= ?'); params.push(from); }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('DATE(r.start_time) <= ?'); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [{ total }] = await queryPromise(this.db,
      `SELECT COUNT(*) AS total FROM reservations r JOIN terrains t ON r.terrain_id = t.id ${whereSql}`, params);

    const rows = await queryPromise(this.db, `
      SELECT r.id, r.status, r.price, r.created_at, r.split_total,
             r.start_time, r.end_time,
             t.id AS terrain_id, t.name AS terrain_name, t.sport_type,
             c.id AS club_id, c.name AS club_name, c.city,
             u.id AS user_id, u.name AS user_name, u.email AS user_email
      FROM reservations r
      JOIN terrains t ON r.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id
      LEFT JOIN users u ON r.user_id = u.id
      ${whereSql}
      ORDER BY r.start_time DESC
      LIMIT ? OFFSET ?`, [...params, lim, off]);

    return { reservations: rows, total: Number(total), page: Number(page) || 1, limit: lim };
  }

  // ── Finances ──────────────────────────────────────────────────────────────

  static periodRange(period, dateStr) {
    const target = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? new Date(dateStr) : new Date();
    let start, end;
    if (period === 'total') { start = new Date('2000-01-01'); end = new Date('2099-12-31'); }
    else if (period === 'day') { start = new Date(target.getFullYear(), target.getMonth(), target.getDate()); end = new Date(start.getTime() + 864e5); }
    else if (period === 'week') { const day = target.getDay(); const diff = target.getDate() - day + (day === 0 ? -6 : 1); start = new Date(target.getFullYear(), target.getMonth(), diff); end = new Date(start.getTime() + 7 * 864e5); }
    else if (period === 'year') { start = new Date(target.getFullYear(), 0, 1); end = new Date(target.getFullYear() + 1, 0, 1); }
    else { start = new Date(target.getFullYear(), target.getMonth(), 1); end = new Date(target.getFullYear(), target.getMonth() + 1, 1); }
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { start: fmt(start), end: fmt(end) };
  }

  /**
   * Finances plateforme. Revenu calculé depuis reservations.price (status confirmed/paid),
   * pas depuis la table payments (sous-remplie). Commission plateforme 10%.
   */
  async getPlatformFinances({ period = 'month', date } = {}) {
    const allowed = ['day', 'week', 'month', 'year', 'total'];
    const p = allowed.includes(period) ? period : 'month';
    const { start, end } = AdminController.periodRange(p, date);
    const COMMISSION = 0.10;

    const [agg] = await queryPromise(this.db, `
      SELECT COALESCE(SUM(r.price), 0) AS revenue, COUNT(*) AS count
      FROM reservations r
      WHERE r.status IN ('confirmed', 'paid') AND DATE(r.start_time) >= ? AND DATE(r.start_time) < ?`,
      [start, end]);

    const revenue = Number(agg.revenue);
    const count = Number(agg.count);
    return {
      period: p, start, end,
      totalRevenue: revenue,
      commissionRate: COMMISSION,
      commission: Number((revenue * COMMISSION).toFixed(2)),
      netRevenue: Number((revenue * (1 - COMMISSION)).toFixed(2)),
      reservationsCount: count,
      averageTransaction: count > 0 ? Number((revenue / count).toFixed(2)) : 0,
    };
  }

  /** Revenu par club sur la période, classé décroissant. */
  async getFinancesByClub({ period = 'month', date } = {}) {
    const allowed = ['day', 'week', 'month', 'year', 'total'];
    const p = allowed.includes(period) ? period : 'month';
    const { start, end } = AdminController.periodRange(p, date);
    const rows = await queryPromise(this.db, `
      SELECT c.id AS club_id, c.name AS club_name, c.city,
             COALESCE(SUM(r.price), 0) AS revenue, COUNT(r.id) AS reservations
      FROM clubs c
      JOIN terrains t ON t.club_id = c.id
      JOIN reservations r ON r.terrain_id = t.id
        AND r.status IN ('confirmed', 'paid') AND DATE(r.start_time) >= ? AND DATE(r.start_time) < ?
      GROUP BY c.id, c.name, c.city
      ORDER BY revenue DESC`, [start, end]);
    return rows.map(r => ({ ...r, revenue: Number(r.revenue), reservations: Number(r.reservations) }));
  }

  /** Lignes brutes pour l'export CSV finances plateforme. */
  async getFinancesRows({ from, to } = {}) {
    const where = ["r.status IN ('confirmed', 'paid')"];
    const params = [];
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('DATE(r.start_time) >= ?'); params.push(from); }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('DATE(r.start_time) <= ?'); params.push(to); }
    return queryPromise(this.db, `
      SELECT r.id, r.start_time, r.price, r.status, c.name AS club_name, t.name AS terrain_name, u.email AS user_email
      FROM reservations r
      JOIN terrains t ON r.terrain_id = t.id
      LEFT JOIN clubs c ON t.club_id = c.id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE ${where.join(' AND ')}
      ORDER BY r.start_time DESC`, params);
  }
}

module.exports = AdminController;
