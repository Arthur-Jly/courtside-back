/**
 * Centralized input validation (Joi).
 */
const Joi = require('joi');

const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = error.details.map(d => ({ field: d.path.join('.'), message: d.message }));
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    req[source] = value;
    next();
  };
};

const id = Joi.number().integer().positive();
const safeStr = (min, max) => Joi.string().trim().min(min).max(max);

// At least 8 chars, with a letter and a digit. Disallow common-leak placeholders.
const password = Joi.string()
  .min(8)
  .max(128)
  .pattern(/[A-Za-z]/, 'letter')
  .pattern(/\d/, 'digit')
  .required();

const schemas = {
  register: Joi.object({
    first_name: safeStr(2, 50).required(),
    last_name: safeStr(2, 50).required(),
    email: Joi.string().email().max(254).lowercase().required(),
    password,
    role: Joi.string().valid('player', 'club_admin').required(),
    club_name: safeStr(2, 200).optional(),
    username: Joi.string().alphanum().min(3).max(30).required(),
  }),

  login: Joi.object({
    email: Joi.string().email().max(254).lowercase().required(),
    password: Joi.string().min(1).max(128).required(),
  }),

  forgotPassword: Joi.object({
    email: Joi.string().email().max(254).lowercase().required(),
  }),

  resetPassword: Joi.object({
    token: Joi.string().hex().length(64).required(),
    password,
  }),

  acceptClubInvitation: Joi.object({
    token: Joi.string().hex().length(64).required(),
    first_name: safeStr(2, 50).required(),
    last_name: safeStr(2, 50).required(),
    password,
    username: Joi.string().alphanum().min(3).max(30).required(),
  }),

  addFavorite: Joi.object({
    terrain_id: id.required(),
  }),

  removeFavorite: Joi.object({
    terrain_id: id.required(),
  }),

  sendFriendRequest: Joi.object({
    to_user_id: id.required(),
  }),

  // Le prix n'est jamais lu du client : il vient du tarif du terrain.
  bookSlot: Joi.object({}),

  geocodeQuery: Joi.object({
    address: safeStr(3, 200).required(),
  }),

  autocompleteQuery: Joi.object({
    input: safeStr(3, 200).required(),
  }),

  placeQuery: Joi.object({
    placeId: safeStr(1, 255).required(),
  }),

  slotListQuery: Joi.object({
    date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: Joi.string().valid('free', 'booked', 'blocked', 'reserved_announcement', 'all').optional(),
  }),

  generateSlots: Joi.object({
    days: Joi.number().integer().min(1).max(365).optional(),
    weeks: Joi.number().integer().min(1).max(52).optional(),
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),

  generateSlotsForTerrain: Joi.object({
    terrain_id: id.required(),
    weeks: Joi.number().integer().min(1).max(52).optional(),
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),

  generateSlotsForClub: Joi.object({
    club_id: id.required(),
    weeks: Joi.number().integer().min(1).max(52).optional(),
    fromDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),

  cleanupSlots: Joi.object({
    keepDays: Joi.number().integer().min(1).max(3650).optional(),
  }),

  blockSlot: Joi.object({
    terrain_id: id.required(),
    date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
    start_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?$/).required(),
    end_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?$/).optional().allow(null, ''),
  }),

  clubAvailability: Joi.object({
    club_ids: Joi.array().items(id).min(1).max(60).required(),
    date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),

  clubListQuery: Joi.object({
    lat: Joi.number().min(-90).max(90).optional(),
    lon: Joi.number().min(-180).max(180).optional(),
    lng: Joi.number().min(-180).max(180).optional(),
    sport: Joi.string().max(50).optional(),
    sport_type: Joi.string().max(50).optional(),
    radius: Joi.number().min(0.5).max(500).optional(),
    limit: Joi.number().integer().min(1).max(200).optional(),
    city: safeStr(1, 120).optional(),
  }),

  metricsPhase1Query: Joi.object({
    from: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    city: safeStr(1, 120).optional(),
    days: Joi.number().integer().min(1).max(3650).optional(),
  }),

  reviewCreate: Joi.object({
    club_id: id.optional(),
    public_place_id: Joi.string().max(255).optional(),
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: safeStr(1, 2000).required(),
  }).or('club_id', 'public_place_id'),

  reviewUpdate: Joi.object({
    rating: Joi.number().integer().min(1).max(5).optional(),
    comment: safeStr(1, 2000).optional(),
  }).or('rating', 'comment'),

  reviewResponse: Joi.object({
    response: safeStr(1, 2000).required(),
  }),

  clubRequest: Joi.object({
    name: safeStr(2, 200).required(),
    city: safeStr(1, 100).required(),
    phone: safeStr(5, 30).required(),
    email: Joi.string().email().max(254).required(),
    address: safeStr(1, 300).optional().allow(''),
    postal_code: safeStr(1, 20).optional().allow(''),
    description: safeStr(1, 2000).optional().allow(''),
  }),

  profileUpdate: Joi.object({
    bio: safeStr(0, 1000).allow('').optional(),
    city: safeStr(0, 100).allow('').optional(),
    birthdate: Joi.date().iso().optional().allow(null, ''),
    sports: Joi.alternatives().try(
      Joi.string().max(500).allow(''),
      Joi.array().items(Joi.string().max(50)).max(20),
    ).optional(),
    is_public: Joi.boolean().optional(),
  }),

  userUpdate: Joi.object({
    name: safeStr(2, 100).optional(),
    // Minuscules : le login normalise l'email de la même façon, sinon le compte devient inaccessible.
    email: Joi.string().email().max(254).lowercase().optional(),
  }).min(1),

  terrainUpsert: Joi.object({
    name: safeStr(1, 100).required(),
    sport_type: safeStr(1, 50).required(),
    price_per_hour: Joi.number().min(0).max(10000).required(),
    slot_duration: Joi.number().integer().min(10).max(480).required(),
    recurring_availabilities: Joi.array().items(Joi.object({
      day_of_week: Joi.number().integer().min(0).max(6).required(),
      start_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?$/).required(),
      end_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?$/).required(),
      is_closed: Joi.alternatives(Joi.boolean(), Joi.number().valid(0, 1)).optional(),
    })).max(50).optional(),
  }),

  clubInfoUpdate: Joi.object({
    name: safeStr(2, 200).optional(),
    description: Joi.string().max(2000).allow('', null).optional(),
    address: Joi.string().max(300).allow('', null).optional(),
    city: safeStr(1, 100).optional(),
    postal_code: Joi.string().max(20).allow('', null).optional(),
    phone: Joi.string().max(30).allow('', null).optional(),
    email: Joi.string().email().max(254).allow('', null).optional(),
    // Rendu en <a href> côté front : pas de schéma javascript:/data:.
    website: Joi.string().max(300).pattern(/^\s*(javascript|data|vbscript):/i, { invert: true }).allow('', null).optional(),
  }).min(1),

  // ── Terrains publics (phase 1) ───────────────────────────────────────────
  publicPlaceQuery: Joi.object({
    city: safeStr(1, 120).optional(),
    sport: Joi.string().valid('foot', 'basket', 'hand', 'volley', 'ping', 'all').optional(),
    q: safeStr(2, 120).optional(),
    lat: Joi.number().min(-90).max(90).optional(),
    lng: Joi.number().min(-180).max(180).optional(),
    radius: Joi.number().min(0.5).max(100).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
  }).and('lat', 'lng'),

  publicPlaceReport: Joi.object({
    kind: Joi.string().valid('inexistant', 'inaccessible', 'ferme', 'mauvais_etat', 'autre').required(),
    comment: safeStr(1, 500).optional().allow(''),
  }),

  publicPlaceCreate: Joi.object({
    name: safeStr(2, 200).required(),
    equip_type: safeStr(2, 120).optional(),
    sports: Joi.array().items(Joi.string().valid('foot', 'basket', 'hand', 'volley', 'ping')).min(1).max(5).required(),
    address: safeStr(1, 255).optional().allow(''),
    postal_code: safeStr(1, 10).optional().allow(''),
    city: safeStr(1, 120).required(),
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
    lighting: Joi.boolean().optional(),
  }),

  announcementListQuery: Joi.object({
    sport_type: Joi.string().max(30).optional(),
    status: Joi.string().max(30).optional(),
    club_id: id.optional(),
    user_id: id.optional(),
    public_place_id: Joi.string().max(255).optional(),
    public_place_ref: id.optional(),
    city: safeStr(1, 120).optional(),
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    lat: Joi.number().min(-90).max(90).optional(),
    lng: Joi.number().min(-180).max(180).optional(),
    radius: Joi.number().min(0.5).max(200).optional(),
  }).and('lat', 'lng'),
};

module.exports = { validate, schemas };
