/**
 * Service de tâches automatiques (Cron Jobs)
 * 
 * Ce service gère l'exécution périodique de tâches comme :
 * - L'annulation automatique des annonces expirées
 * - Le nettoyage des données obsolètes
 */

const cron = require('node-cron');
const AnnouncementsController = require('../controllers/announcements.controller');
const emailService = require('./emailService');
const { queryPromise } = require('../utils/dbHelpers');
const { logger } = require('../utils/logger');
const config = require('../config');

class CronService {
  constructor(db) {
    this.db = db;
    this.controller = new AnnouncementsController(db);
    this.jobs = [];
  }

  /**
   * Démarre tous les cron jobs
   */
  start() {
    logger.info('Démarrage des tâches automatiques (cron jobs)...');

    const expirationCheckJob = cron.schedule(config.cron.expirationCheckSchedule, async () => {
      try {
        const result = await this.controller.checkAndCancelExpiredAnnouncements();
        logger.info(`[CRON expiration-check] ${result.cancelled} annulées, ${result.kept} conservées`);
      } catch (error) {
        logger.error(`[CRON expiration-check] ${error.message}`);
      }
    });

    this.jobs.push({
      name: 'expiration-check',
      schedule: config.cron.expirationCheckSchedule,
      description: 'Vérifie et annule les annonces expirées sans participants minimum',
      job: expirationCheckJob,
    });

    const quickCheckJob = cron.schedule(config.cron.quickExpirationSchedule, async () => {
      try {
        const result = await this.controller.checkAndCancelExpiredAnnouncements();
        if (result.cancelled > 0) {
          logger.info(`[CRON quick] ${result.cancelled} annonces annulées`);
        }
      } catch (error) {
        logger.error(`[CRON quick] ${error.message}`);
      }
    });

    this.jobs.push({
      name: 'quick-expiration-check',
      schedule: config.cron.quickExpirationSchedule,
      description: 'Vérification rapide des annonces expirées',
      job: quickCheckJob,
    });

    const reminderJob = cron.schedule(config.cron.reminderSchedule, () => this.sendReservationReminders());
    this.jobs.push({
      name: 'reservation-reminders',
      schedule: config.cron.reminderSchedule,
      description: 'Envoie le rappel email J-1 pour les réservations de demain',
      job: reminderJob,
    });

    const cleanupJob = cron.schedule(config.cron.cleanupSchedule, () => this.cleanupDatabase());
    this.jobs.push({
      name: 'db-cleanup',
      schedule: config.cron.cleanupSchedule,
      description: 'Purge les créneaux libres passés et les tokens de reset expirés',
      job: cleanupJob,
    });

    logger.info(`${this.jobs.length} tâches automatiques démarrées`);
    this.jobs.forEach(({ name, schedule, description }) => {
      logger.debug(`  cron ${name} (${schedule}): ${description}`);
    });
  }

  /**
   * Rappel J-1 : réservations confirmées de demain, jamais rappelées.
   */
  async sendReservationReminders() {
    const sql = `
        SELECT r.id, r.start_time, r.end_time, u.email, u.name AS user_name,
               t.name AS terrain_name, c.name AS club_name
        FROM reservations r
        JOIN users u ON u.id = r.user_id
        LEFT JOIN terrains t ON t.id = r.terrain_id
        LEFT JOIN clubs c ON c.id = t.club_id
        WHERE r.status = 'confirmed'
          AND r.reminder_sent_at IS NULL
          AND DATE(r.start_time) = DATE(DATE_ADD(NOW(), INTERVAL 1 DAY))
          AND u.email NOT LIKE 'deleted-%@deleted.invalid'
        LIMIT 500
      `;

    let rows;
    try {
      rows = await queryPromise(this.db, sql, []);
    } catch (err) {
      logger.error(`[CRON] Rappels J-1 requête échouée: ${err.message}`);
      return { sent: 0 };
    }

    let sent = 0;
    for (const r of rows || []) {
      const start = new Date(r.start_time);
      const end = new Date(r.end_time);
      const pad = (n) => String(n).padStart(2, '0');
      const slot = `${pad(start.getHours())}:${pad(start.getMinutes())} - ${pad(end.getHours())}:${pad(end.getMinutes())}`;
      const dateStr = start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
      const courtName = [r.club_name, r.terrain_name].filter(Boolean).join(' · ') || 'ton terrain';
      try {
        await emailService.sendReservationReminder(r.email, { courtName, date: dateStr, slot });
      } catch (e) {
        logger.error(`[CRON] Rappel résa ${r.id} échoué: ${e.message}`);
        continue;
      }
      await queryPromise(this.db, 'UPDATE reservations SET reminder_sent_at = NOW() WHERE id = ?', [r.id])
        .catch((e) => logger.error(`[CRON] Marquage rappel ${r.id} échoué: ${e.message}`));
      sent++;
    }
    if (sent > 0) logger.info(`[CRON] ${sent} rappel(s) J-1 envoyé(s)`);
    return { sent };
  }

  /**
   * Nettoyage quotidien : créneaux libres passés (la table slots croît sans
   * limite sinon — les créneaux réservés sont conservés pour l'historique)
   * et tokens de réinitialisation expirés depuis plus de 7 jours.
   */
  cleanupDatabase() {
    const run = async (sql, label) => {
      try {
        const result = await queryPromise(this.db, sql, []);
        if (result.affectedRows > 0) logger.info(`[CRON] Nettoyage: ${result.affectedRows} ${label} supprimé(s)`);
        return result.affectedRows;
      } catch (err) {
        logger.error(`[CRON] Nettoyage ${label} échoué: ${err.message}`);
        return 0;
      }
    };
    return Promise.all([
      run("DELETE FROM slots WHERE status = 'free' AND date < CURDATE()", 'créneau(x) libre(s) passé(s)'),
      run('DELETE FROM password_resets WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)', 'token(s) de reset expiré(s)'),
    ]).then(([slots, tokens]) => ({ slots, tokens }));
  }

  /**
   * Arrête tous les cron jobs
   */
  stop() {
    logger.info('Arrêt des tâches automatiques...');
    this.jobs.forEach(({ name, job }) => {
      job.stop();
      logger.debug(`  cron ${name} arrêté`);
    });
  }

  /**
   * Liste tous les jobs actifs
   */
  listJobs() {
    return this.jobs.map(({ name, schedule, description }) => ({
      name,
      schedule,
      description
    }));
  }

  /**
   * Exécute manuellement un job spécifique
   */
  async runJobManually(jobName) {
    if (jobName === 'expiration-check' || jobName === 'quick-expiration-check') {
      return await this.controller.checkAndCancelExpiredAnnouncements();
    }
    if (jobName === 'reservation-reminders') {
      return await this.sendReservationReminders();
    }
    if (jobName === 'db-cleanup') {
      return await this.cleanupDatabase();
    }
    throw new Error(`Job inconnu: ${jobName}`);
  }
}

module.exports = CronService;
