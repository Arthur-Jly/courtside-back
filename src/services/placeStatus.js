/**
 * Statut de vérification d'un terrain public — une seule source de vérité.
 *
 * On stocke des PREUVES (ign_ref, osm_ref…) et le statut en découle. Ordre de
 * confiance : décision humaine > communauté > IGN > OSM > rien.
 *
 *   manually_curated   — vérifié par Courtside (curation CSV)
 *   community_verified — confirmé par des joueurs qui y ont joué
 *   ign_confirmed      — terrain « En service » dans la BD TOPO de l'IGN
 *   osm_confirmed      — terrain du bon sport dans OpenStreetMap
 *   auto               — aucune preuve : pas montré par défaut (« À confirmer »)
 *   reported_invalid   — signalé inexistant : jamais montré
 */

// Posés par un humain : aucun recoupement automatique ne les réécrit.
const PROTECTED_STATUSES = ['manually_curated', 'community_verified', 'reported_invalid'];

// Montrés par défaut dans la recherche et le choix du lieu d'une partie.
const VERIFIED_STATUSES = ['manually_curated', 'community_verified', 'ign_confirmed', 'osm_confirmed'];

/**
 * Statut qui découle des preuves d'une ligne `public_places`.
 * Un `osm_confirmed` hérité de l'ancien recoupement (règles plus lâches, sans
 * `osm_ref`) est conservé tant que le recoupement durci n'est pas repassé.
 */
function deriveStatus(place) {
  const current = place.verification_status || 'auto';
  if (PROTECTED_STATUSES.includes(current)) return current;
  if (place.ign_ref) return 'ign_confirmed';
  if (place.osm_ref) return 'osm_confirmed';
  if (current === 'osm_confirmed' && !place.osm_checked_at) return 'osm_confirmed';
  return 'auto';
}

module.exports = { PROTECTED_STATUSES, VERIFIED_STATUSES, deriveStatus };
