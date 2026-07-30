/**
 * Terrains publics (phase 1).
 *
 * Le référentiel vient de Data ES (import: scripts/import-public-places.js). Un
 * référentiel national contient forcément des équipements détruits, murés ou
 * fantômes : la qualité prime sur la couverture. D'où deux règles appliquées ici
 * et nulle part ailleurs :
 *
 *   1. un lieu `reported_invalid` n'est JAMAIS renvoyé, même en recherche directe ;
 *   2. le tri met devant ce qui est vérifié (curation humaine > communauté > OSM > auto).
 */
const { queryPromise, queryOne } = require('../utils/dbHelpers');

// Passages de statut automatiques (couche 3, validation communautaire).
const CONFIRMATIONS_FOR_VERIFIED = 3;
const REPORTS_FOR_INVALID = 3;

// Un statut posé par un humain (curation) ne doit pas être écrasé par la communauté.
const HUMAN_STATUSES = ['manually_curated', 'reported_invalid'];

const SEARCH_LIMIT_DEFAULT = 30;
const SEARCH_LIMIT_MAX = 100;
const RADIUS_DEFAULT_KM = 15;

// Rang d'affichage : plus le lieu est vérifié, plus il remonte.
const STATUS_RANK_SQL = `
  CASE p.verification_status
    WHEN 'manually_curated'   THEN 0
    WHEN 'community_verified' THEN 1
    WHEN 'osm_confirmed'      THEN 2
    ELSE 3
  END`;

// Haversine en SQL. LEAST(1, …) évite un NaN sur les arrondis flottants.
const DISTANCE_SQL = `
  6371 * ACOS(LEAST(1,
    COS(RADIANS(?)) * COS(RADIANS(p.lat)) * COS(RADIANS(p.lng) - RADIANS(?))
    + SIN(RADIANS(?)) * SIN(RADIANS(p.lat))
  ))`;

const BASE_COLUMNS = `
  p.id, p.external_ref, p.name, p.equip_type, p.sports, p.address, p.postal_code,
  p.city, p.department, p.lat, p.lng, p.free_access, p.lighting, p.seasonal,
  p.accessible_pmr, p.source, p.verification_status, p.confirmations_count,
  p.reports_count, p.last_played_at, p.photo_url`;

/** `sports` est une colonne JSON : mysql2 la renvoie parfois en texte. */
function parseSports(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function shapePlace(row) {
  if (!row) return null;
  return {
    ...row,
    sports: parseSports(row.sports),
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    free_access: !!row.free_access,
    lighting: row.lighting == null ? null : !!row.lighting,
    seasonal: row.seasonal == null ? null : !!row.seasonal,
    accessible_pmr: row.accessible_pmr == null ? null : !!row.accessible_pmr,
    confirmations_count: Number(row.confirmations_count) || 0,
    reports_count: Number(row.reports_count) || 0,
    distance_km: row.distance_km != null ? Math.round(Number(row.distance_km) * 10) / 10 : null,
    upcoming_count: row.upcoming_count != null ? Number(row.upcoming_count) : undefined,
  };
}

class PublicPlacesController {
  constructor(db) {
    this.db = db;
  }

  /**
   * Recherche de lieux. Trois modes cumulables : par ville, par proximité
   * (lat/lng/radius) et par texte libre.
   */
  async search(filters = {}) {
    const { city, sport, q } = filters;
    const lat = Number(filters.lat);
    const lng = Number(filters.lng);
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
    const radius = Number.isFinite(Number(filters.radius)) ? Number(filters.radius) : RADIUS_DEFAULT_KM;
    const limit = Math.min(Math.max(parseInt(filters.limit, 10) || SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);

    const select = [BASE_COLUMNS];
    const params = [];

    if (hasGeo) {
      select.push(`${DISTANCE_SQL} AS distance_km`);
      params.push(lat, lng, lat);
    }

    let sql = `SELECT ${select.join(',\n')}
      FROM public_places p
      WHERE p.verification_status <> 'reported_invalid'`;

    if (city) {
      sql += ' AND LOWER(p.city) = LOWER(?)';
      params.push(String(city).trim());
    }
    if (sport && sport !== 'all') {
      sql += ' AND JSON_CONTAINS(p.sports, ?)';
      params.push(JSON.stringify(String(sport).toLowerCase()));
    }
    if (q) {
      sql += ' AND (p.name LIKE ? OR p.address LIKE ? OR p.city LIKE ?)';
      const like = `%${String(q).trim()}%`;
      params.push(like, like, like);
    }
    if (hasGeo) {
      // Pré-filtre en boîte englobante : il utilise l'index (lat, lng), là où
      // la haversine seule forcerait un scan complet.
      const latDelta = radius / 111;
      const lngDelta = radius / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
      sql += ' AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?';
      params.push(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta);
      sql += ` HAVING distance_km <= ?`;
      params.push(radius);
      sql += ` ORDER BY distance_km ASC, ${STATUS_RANK_SQL} ASC`;
    } else {
      sql += ` ORDER BY ${STATUS_RANK_SQL} ASC, p.confirmations_count DESC, p.name ASC`;
    }

    sql += ' LIMIT ?';
    params.push(limit);

    const rows = await queryPromise(this.db, sql, params);
    return rows.map(shapePlace);
  }

  /** Détail d'un lieu. Renvoie null si inconnu ou signalé invalide. */
  async getById(id) {
    const row = await queryOne(this.db, `
      SELECT ${BASE_COLUMNS}
      FROM public_places p
      WHERE p.id = ? AND p.verification_status <> 'reported_invalid'
    `, [id]);
    return shapePlace(row);
  }

  /** Parties à venir sur ce lieu — l'intérêt principal d'une fiche lieu. */
  async getUpcomingAnnouncements(placeId, limit = 20) {
    const rows = await queryPromise(this.db, `
      SELECT a.id, a.sport_type, a.slot_start, a.slot_end, a.places_total,
             a.places_disponibles, a.min_participants, a.description, a.status,
             u.name AS creator_name
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.public_place_ref = ?
        AND a.status = 'active'
        AND a.visibility = 'public'
        AND a.slot_start >= NOW()
      ORDER BY a.slot_start ASC
      LIMIT ?
    `, [placeId, limit]);
    return rows;
  }

  /**
   * « J'ai joué ici » — couche 3. Idempotent : une confirmation par utilisateur.
   * Au seuil, le lieu bascule en `community_verified`, sauf si un humain a déjà
   * tranché (curation ou signalement).
   */
  async confirm(placeId, userId) {
    const place = await queryOne(this.db,
      'SELECT id, verification_status FROM public_places WHERE id = ?', [placeId]);
    if (!place) return null;

    await queryPromise(this.db,
      'INSERT IGNORE INTO place_confirmations (place_id, user_id, created_at) VALUES (?, ?, NOW())',
      [placeId, userId]);

    const { count } = await queryOne(this.db,
      'SELECT COUNT(*) AS count FROM place_confirmations WHERE place_id = ?', [placeId]);
    const confirmations = Number(count) || 0;

    const promote = confirmations >= CONFIRMATIONS_FOR_VERIFIED
      && !HUMAN_STATUSES.includes(place.verification_status)
      && place.verification_status !== 'community_verified';

    await queryPromise(this.db, `
      UPDATE public_places
      SET confirmations_count = ?, last_played_at = NOW()
          ${promote ? ", verification_status = 'community_verified'" : ''}
      WHERE id = ?
    `, [confirmations, placeId]);

    return {
      confirmations_count: confirmations,
      verification_status: promote ? 'community_verified' : place.verification_status,
    };
  }

  /**
   * Signalement — couche 3. Trois « inexistant » suffisent à retirer le lieu de
   * la recherche : mieux vaut perdre un terrain valide que d'envoyer un joueur
   * sur un terrain fantôme.
   */
  async report(placeId, userId, { kind, comment }) {
    const place = await queryOne(this.db,
      'SELECT id, verification_status FROM public_places WHERE id = ?', [placeId]);
    if (!place) return null;

    await queryPromise(this.db, `
      INSERT INTO place_reports (place_id, user_id, kind, comment, created_at)
      VALUES (?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE kind = VALUES(kind), comment = VALUES(comment), created_at = NOW()
    `, [placeId, userId, kind, comment || null]);

    const counts = await queryOne(this.db, `
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN kind = 'inexistant' THEN 1 ELSE 0 END) AS missing
      FROM place_reports WHERE place_id = ?
    `, [placeId]);
    const total = Number(counts?.total) || 0;
    const missing = Number(counts?.missing) || 0;

    // La curation manuelle fait foi : elle n'est pas annulée par des signalements.
    const invalidate = missing >= REPORTS_FOR_INVALID
      && place.verification_status !== 'manually_curated'
      && place.verification_status !== 'reported_invalid';

    await queryPromise(this.db, `
      UPDATE public_places
      SET reports_count = ?
          ${invalidate ? ", verification_status = 'reported_invalid'" : ''}
      WHERE id = ?
    `, [total, placeId]);

    return {
      reports_count: total,
      verification_status: invalidate ? 'reported_invalid' : place.verification_status,
    };
  }

  /**
   * Lieu ajouté par un utilisateur (le référentiel a des trous). Statut `auto` :
   * il attend les confirmations de la communauté comme n'importe quel import.
   */
  async createFromUser(data, userId) {
    const externalRef = `user-${userId}-${Date.now()}`;
    const sports = [...new Set(data.sports.map(s => String(s).toLowerCase()))];

    const result = await queryPromise(this.db, `
      INSERT INTO public_places
        (external_ref, name, equip_type, sports, address, postal_code, city,
         lat, lng, free_access, lighting, source, verification_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'user', 'auto', NOW())
    `, [
      externalRef,
      data.name,
      data.equip_type || 'Ajouté par un joueur',
      JSON.stringify(sports),
      data.address || null,
      data.postal_code || null,
      data.city,
      data.lat,
      data.lng,
      data.lighting == null ? null : (data.lighting ? 1 : 0),
    ]);

    return this.getById(result.insertId);
  }
}

module.exports = PublicPlacesController;
module.exports.shapePlace = shapePlace;
module.exports.parseSports = parseSports;
module.exports.CONFIRMATIONS_FOR_VERIFIED = CONFIRMATIONS_FOR_VERIFIED;
module.exports.REPORTS_FOR_INVALID = REPORTS_FOR_INVALID;
