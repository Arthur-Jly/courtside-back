/**
 * Service de tâches automatiques (Cron Jobs)
 * 
 * Ce service gère l'exécution périodique de tâches comme :
 * - L'annulation automatique des annonces expirées
 * - Le nettoyage des données obsolètes
 */

const cron = require('node-cron');
const AnnouncementsController = require('../controllers/announcements.controller');

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

    console.log(`✅ ${this.jobs.length} tâches automatiques démarrées:`);
    this.jobs.forEach(({ name, schedule, description }) => {
      console.log(`   - ${name} (${schedule}): ${description}`);
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
    throw new Error(`Job inconnu: ${jobName}`);
  }
}

module.exports = CronService;
