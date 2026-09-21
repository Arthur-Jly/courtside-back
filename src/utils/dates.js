/**
 * Utilitaires date/heure partagés.
 *
 * Le back évite ISO/UTC pour l'affichage : le front réutilise la chaîne telle
 * quelle. Toute conversion timezone doit passer par les helpers ci-dessous.
 */

const pad = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' en fuseau local (évite le décalage UTC). */
function formatLocalYmd(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** DATETIME MySQL → 'YYYY-MM-DD HH:mm:ss' fuseau serveur. */
function formatDateTime(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 'HH:mm' ou 'HH:mm:ss' → minutes depuis minuit. */
function timeToMinutes(t) {
  const parts = String(t || '').split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return h * 60 + m;
}

/** Minutes depuis minuit → 'HH:mm'. */
function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad(h)}:${pad(m)}`;
}

/** 'YYYY-MM-DD' aujourd'hui (fuseau local). */
function todayLocalYmd() {
  return formatLocalYmd(new Date());
}

/** Ajoute N jours à une date YYYY-MM-DD (renvoie YYYY-MM-DD). */
function addDaysYmd(ymd, days) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return formatLocalYmd(d);
}

module.exports = {
  formatLocalYmd,
  formatDateTime,
  timeToMinutes,
  minutesToTime,
  todayLocalYmd,
  addDaysYmd,
};
