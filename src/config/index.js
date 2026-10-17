/**
 * Configuration centralisée — remplace les magic numbers dispersés.
 * Les valeurs peuvent être surchargées via variables d'environnement.
 */

const num = (envKey, fallback) => {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '' || raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  slots: {
    // Durée par défaut d'un créneau si le terrain n'en définit pas.
    defaultDurationMinutes: num('SLOT_DEFAULT_DURATION_MIN', 60),
    // Horizon max de génération (semaines).
    defaultGenerationWeeks: num('SLOT_DEFAULT_GEN_WEEKS', 6),
    // Nettoyage — jours d'historique conservés.
    cleanupDefaultKeepDays: num('SLOT_CLEANUP_KEEP_DAYS', 30),
  },
  announcements: {
    // Ratio minimum de participants confirmant l'annonce (par sport).
    minRatio: {
      foot: 0.8,
      basket: 0.7,
    },
    minRatioDefault: 0.5,
    // Nombre minimum absolu.
    minParticipantsAbsolute: 2,
  },
  http: {
    // Timeout global d'une requête HTTP (ms).
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 30_000),
    // Rate limits (par IP).
    globalLimit: num('RATE_LIMIT_GLOBAL', 300),
    registerLimit: num('RATE_LIMIT_REGISTER', 5),
    loginLimit: num('RATE_LIMIT_LOGIN', 5),
    resetLimit: num('RATE_LIMIT_RESET', 5),
    writeLimit: num('RATE_LIMIT_WRITE', 30),
    geocodeLimit: num('RATE_LIMIT_GEOCODE', 60),
  },
  cron: {
    expirationCheckSchedule: process.env.CRON_EXPIRATION || '0 * * * *',
    quickExpirationSchedule: process.env.CRON_QUICK_EXPIRATION || '*/15 * * * *',
    reminderSchedule: process.env.CRON_REMINDER || '0 9 * * *',
    cleanupSchedule: process.env.CRON_CLEANUP || '0 4 * * *',
    // Terrains publics : « le terrain existait ? » après une partie, et expiration
    // des confirmations communautaires (services/placeCommunity).
    placeCheckSchedule: process.env.CRON_PLACE_CHECK || '20 * * * *',
    placeExpirySchedule: process.env.CRON_PLACE_EXPIRY || '30 4 * * *',
  },
  reservations: {
    // Fenêtre max (jours) à laquelle une reservation peut être créée.
    maxAdvanceDays: num('RESERVATION_MAX_ADVANCE_DAYS', 90),
    // Frais de service ajoutés au tarif horaire (€) — doit rester aligné avec le front.
    serviceFee: num('RESERVATION_SERVICE_FEE', 1.5),
    // Durée max d'une réservation payée en ligne (heures).
    maxDurationHours: num('RESERVATION_MAX_HOURS', 4),
    // Nombre de parts d'une réservation en paiement partagé.
    splitParts: 4,
  },
  // Autorise POST /slots/:id/book (réservation SANS paiement). À laisser à
  // false en production : le paiement passe par Stripe Checkout.
  get allowDirectBooking() { return process.env.ALLOW_DIRECT_BOOKING === 'true'; },
};
