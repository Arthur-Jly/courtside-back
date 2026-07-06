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
    console.log('🚀 Démarrage des tâches automatiques (cron jobs)...');

    // Job 1: Vérifier les annonces expirées toutes les heures
    const expirationCheckJob = cron.schedule('0 * * * *', async () => {
      try {
        console.log('⏰ [CRON] Vérification des annonces expirées...');
        const result = await this.controller.checkAndCancelExpiredAnnouncements();
        console.log(`✅ [CRON] Vérification terminée: ${result.cancelled} annoncées annulées, ${result.kept} conservées`);
      } catch (error) {
        console.error('❌ [CRON] Erreur lors de la vérification des annonces expirées:', error);
      }
    });

    this.jobs.push({
      name: 'expiration-check',
      schedule: '0 * * * *', // Toutes les heures
      description: 'Vérifie et annule les annonces expirées sans participants minimum',
      job: expirationCheckJob
    });

    // Job 2: Vérifier les annonces expirées toutes les 15 minutes (pour réactivité)
    const quickCheckJob = cron.schedule('*/15 * * * *', async () => {
      try {
        console.log('⏰ [CRON-QUICK] Vérification rapide des annonces expirées...');
        const result = await this.controller.checkAndCancelExpiredAnnouncements();
        if (result.cancelled > 0) {
          console.log(`✅ [CRON-QUICK] ${result.cancelled} annonces annulées`);
        }
      } catch (error) {
        console.error('❌ [CRON-QUICK] Erreur:', error);
      }
    });

    this.jobs.push({
      name: 'quick-expiration-check',
      schedule: '*/15 * * * *', // Toutes les 15 minutes
      description: 'Vérification rapide des annonces expirées',
      job: quickCheckJob
    });

    // Job 3: Rappel J-1 des réservations, tous les jours à 09:00
    const reminderJob = cron.schedule('0 9 * * *', () => this.sendReservationReminders());

    this.jobs.push({
      name: 'reservation-reminders',
      schedule: '0 9 * * *',
      description: 'Envoie le rappel email J-1 pour les réservations de demain',
      job: reminderJob
    });

    console.log(`✅ ${this.jobs.length} tâches automatiques démarrées:`);
    this.jobs.forEach(({ name, schedule, description }) => {
      console.log(`   - ${name} (${schedule}): ${description}`);
    });
  }

  /**
   * Rappel J-1 : réservations confirmées de demain, jamais rappelées.
   */
  sendReservationReminders() {
    return new Promise((resolve) => {
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
      this.db.query(sql, [], async (err, rows) => {
        if (err) {
          console.error('❌ [CRON] Rappels J-1 — requête échouée:', err.message);
          return resolve({ sent: 0 });
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
            console.error(`❌ [CRON] Rappel résa ${r.id} échoué:`, e.message);
            continue;
          }
          this.db.query('UPDATE reservations SET reminder_sent_at = NOW() WHERE id = ?', [r.id], () => {});
          sent++;
        }
        if (sent > 0) console.log(`✅ [CRON] ${sent} rappel(s) J-1 envoyé(s)`);
        resolve({ sent });
      });
    });
  }

  /**
   * Arrête tous les cron jobs
   */
  stop() {
    console.log('⏸️ Arrêt des tâches automatiques...');
    this.jobs.forEach(({ name, job }) => {
      job.stop();
      console.log(`   - ${name} arrêté`);
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
    throw new Error(`Job inconnu: ${jobName}`);
  }
}

module.exports = CronService;
