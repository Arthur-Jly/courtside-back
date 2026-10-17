/**
 * Data ES (ministère des Sports) — filtres, mapping et écriture des terrains.
 *
 * Partagé par deux appelants qui doivent appliquer EXACTEMENT les mêmes règles :
 *   - scripts/import-public-places.js  (import massif par département)
 *   - services/placeCoverage.js        (remplissage à la demande, par zone)
 *
 * Un référentiel national contient des équipements détruits, fermés ou fantômes.
 * Les filtres de `rejectReason` (couche 1) sont donc volontairement stricts,
 * quitte à écarter des lieux valides.
 */

const API = 'https://equipements.sports.gouv.fr/api/explore/v2.1/catalog/datasets/data-es/records';
const PAGE_SIZE = 100;

// Liste blanche établie sur les facettes réelles de l'API (accès libre, foot ou
// basket). C'est CE filtre qui écarte les boucles de randonnée, plans d'eau,
// pumptracks et autres « terrains vagues ».
const TYPES_AUTORISES = new Set([
  'Multisports/City-stades',
  'Terrain de football',
  'Terrain de foot 5x5',
  'Terrain de futsal extérieur',
  'Terrain de soccer',
  'Terrain de basket-ball',
  'Terrain de basket-ball 3x3',
  'Terrain mixte',
  // Pas de « Salle multisports (gymnase) » : même marquée « accès libre », une
  // salle est fermée à clé hors créneaux — on ne peut pas y organiser une partie.
]);

// aps_name (Data ES) -> clés internes (src/data/courts.js)
// Un équipement sans aucun sport ciblé est rejeté (cf. rejectReason).
const SPORTS_MAP = [
  [/football|futsal|soccer/i, 'foot'],
  [/basket/i, 'basket'],
];

// Statuts posés par un humain (curation, communauté, signalement) : un réimport
// ne les réécrit jamais. Liste partagée : services/placeStatus.
const { PROTECTED_STATUSES } = require('./placeStatus');

// L'API Data ES renvoie ses booléens tantôt en booléens, tantôt en chaînes
// ("true"/"false", et "Oui"/"Non" pour `inst_hs_bool`) selon le champ. On normalise.
function bool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === 'oui') return true;
    if (t === 'false' || t === 'non') return false;
  }
  return null;
}
const tri = (v) => { const b = bool(v); return b === null ? null : (b ? 1 : 0); };

/**
 * Le terrain est-il ouvert aux particuliers ?
 * `equip_utilisateur` liste les publics admis : individus/familles, clubs,
 * scolaires, associations. Un équipement réservé aux seuls clubs ou scolaires
 * n'est pas exploitable pour une partie ouverte.
 */
function usableByIndividuals(utilisateur) {
  const raw = Array.isArray(utilisateur) ? utilisateur.join(' ') : String(utilisateur || '');
  return /individuel/i.test(raw);
}

/** Sports internes praticables sur cet équipement (d'après aps_name). */
function mapSports(apsName) {
  const list = Array.isArray(apsName) ? apsName : [];
  const set = new Set();
  for (const aps of list) {
    for (const [re, key] of SPORTS_MAP) if (re.test(aps)) set.add(key);
  }
  return [...set];
}

/**
 * Couche 1 : filtres durs. Retourne null si le lieu est retenu, sinon le motif
 * de rejet (pour pouvoir ajuster les filtres au vu des statistiques).
 *
 * Pas de filtre sur `equip_maj_date` : c'est la date de l'export, pas celle de
 * la fiche (93 % des équipements portent le même 2025-03-31). Un plancher
 * d'ancienneté ne filtrait rien, puis aurait rejeté tout le référentiel d'un
 * coup. L'existence réelle se vérifie par recoupement (BD TOPO, OSM).
 */
function rejectReason(r) {
  // `equip_ouv_public_bool` n'est PAS un signal d'usage : c'est une notion
  // administrative (classement ERP). Des terrains de proximité municipaux
  // ouverts à tous y sont à "false". Le signal réel est `equip_utilisateur` :
  // on garde ce qui est ouvert aux individus, on écarte ce qui est réservé
  // aux clubs ou aux scolaires.
  if (!usableByIndividuals(r.equip_utilisateur)) return 'reserve_clubs_ou_scolaires';
  // `inst_hs_bool` est le seul indicateur « hors service » du jeu de données.
  if (bool(r.inst_hs_bool) === true) return 'hors_service';
  if (!TYPES_AUTORISES.has(r.equip_type_name)) return 'type_hors_liste_blanche';
  if (!r.equip_coordonnees || r.equip_coordonnees.lat == null) return 'sans_coordonnees';
  if (!r.inst_adresse) return 'sans_adresse';
  if (!r.new_name) return 'sans_commune';
  if (mapSports(r.aps_name).length === 0) return 'sport_hors_cible';
  return null;
}

function toRow(r) {
  return {
    external_ref: r.equip_numero,
    name: (r.equip_nom || r.inst_nom || 'Terrain').slice(0, 200),
    equip_type: r.equip_type_name,
    sports: JSON.stringify(mapSports(r.aps_name)),
    address: r.inst_adresse ? String(r.inst_adresse).slice(0, 255) : null,
    postal_code: r.inst_cp ? String(r.inst_cp).slice(0, 10) : null,
    city: String(r.new_name).slice(0, 120),
    department: r.dep_nom ? String(r.dep_nom).slice(0, 120) : null,
    lat: r.equip_coordonnees.lat,
    lng: r.equip_coordonnees.lon,
    free_access: 1,
    lighting: tri(r.equip_eclair),
    seasonal: tri(r.equip_saison),
    accessible_pmr: tri(r.equip_pmr_aire),
    data_updated_at: r.equip_maj_date || null,
  };
}

// ── Requêtes API ────────────────────────────────────────────────────────────

/** Filtre « accès libre » + départements et/ou commune (import par département). */
function buildAdminWhere({ dep, city, all }) {
  const clauses = ['equip_acc_libre="true"'];
  if (dep) {
    const list = dep.split(',').map(d => `"${d.trim()}"`).join(',');
    clauses.push(`dep_code in (${list})`);
  }
  if (city) clauses.push(`new_name="${city.replace(/"/g, '')}"`);
  if (!dep && !city && !all) throw new Error('Préciser --dep, --city ou --all');
  return clauses.join(' and ');
}

/**
 * Filtre « accès libre » + types de la liste blanche + rayon autour d'un point.
 * Le filtre de type est fait côté API : à Paris il divise le volume par deux.
 * lat/lng sont forcés en nombres — jamais de texte libre dans la requête.
 */
function buildGeoWhere(lat, lng, radiusKm) {
  const la = Number(lat);
  const ln = Number(lng);
  const km = Number(radiusKm);
  if (![la, ln, km].every(Number.isFinite)) throw new Error('coordonnées ou rayon invalides');
  const types = [...TYPES_AUTORISES].map(t => `"${t}"`).join(',');
  return `equip_acc_libre="true" and equip_type_name in (${types})`
    + ` and within_distance(equip_coordonnees, geom'POINT(${ln} ${la})', ${km}km)`;
}

async function fetchPage(where, offset, { timeoutMs = 10000 } = {}) {
  const url = `${API}?where=${encodeURIComponent(where)}&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`API Data ES ${res.status} — ${await res.text()}`);
  return res.json();
}

// ── Écriture ────────────────────────────────────────────────────────────────

/**
 * Upsert de lignes `toRow` sur external_ref. `q(sql, params)` renvoie une
 * promesse de lignes : le script d'import (pool callback) et le service (pool
 * promise) passent chacun leur adaptateur.
 * Le travail humain prime : un lieu vérifié, confirmé ou signalé n'est pas touché.
 */
async function upsertPlaces(q, rows) {
  const counts = { inserted: 0, updated: 0, skippedCurated: 0 };
  if (rows.length === 0) return counts;

  const found = await q(
    'SELECT id, external_ref, verification_status, lat, lng, original_lat, original_lng FROM public_places WHERE external_ref IN (?)',
    [rows.map(r => r.external_ref)]
  );
  const existing = new Map(found.map(f => [f.external_ref, f]));

  for (const row of rows) {
    const known = existing.get(row.external_ref);
    if (!known) {
      await q(
        `INSERT INTO public_places
         (external_ref, name, equip_type, sports, address, postal_code, city, department,
          lat, lng, free_access, lighting, seasonal, accessible_pmr, data_updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.external_ref, row.name, row.equip_type, row.sports, row.address, row.postal_code,
          row.city, row.department, row.lat, row.lng, row.free_access, row.lighting,
          row.seasonal, row.accessible_pmr, row.data_updated_at]
      );
      counts.inserted++;
    } else if (PROTECTED_STATUSES.includes(known.verification_status)) {
      counts.skippedCurated++;
    } else {
      // Le point a pu être recalé sur le terrain IGN (original_* = point Data ES) :
      // tant que Data ES ne déplace pas l'équipement, on garde le point recalé.
      // S'il le déplace, on reprend son point et on revérifie (IGN, OSM).
      const sourceLat = Number(known.original_lat != null ? known.original_lat : known.lat);
      const sourceLng = Number(known.original_lng != null ? known.original_lng : known.lng);
      const moved = Math.abs(sourceLat - row.lat) > 1e-5 || Math.abs(sourceLng - row.lng) > 1e-5;
      const coordsSql = moved
        ? ', lat=?, lng=?, original_lat=NULL, original_lng=NULL, ign_checked_at=NULL, osm_checked_at=NULL'
        : '';
      await q(
        `UPDATE public_places SET name=?, equip_type=?, sports=?, address=?, postal_code=?,
           city=?, department=?, lighting=?, seasonal=?, accessible_pmr=?,
           data_updated_at=?, source_missing_at=NULL${coordsSql} WHERE id=?`,
        [row.name, row.equip_type, row.sports, row.address, row.postal_code, row.city,
          row.department, row.lighting, row.seasonal, row.accessible_pmr, row.data_updated_at,
          ...(moved ? [row.lat, row.lng] : []), known.id]
      );
      counts.updated++;
    }
  }
  return counts;
}

module.exports = {
  API,
  PAGE_SIZE,
  TYPES_AUTORISES,
  bool,
  mapSports,
  rejectReason,
  toRow,
  buildAdminWhere,
  buildGeoWhere,
  fetchPage,
  upsertPlaces,
};
