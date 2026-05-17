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

  addFavorite: Joi.object({
    terrain_id: id.required(),
  }),

  removeFavorite: Joi.object({
    terrain_id: id.required(),
  }),

  sendFriendRequest: Joi.object({
    to_user_id: id.required(),
  }),

  bookSlot: Joi.object({
    price: Joi.number().min(0).max(10000).optional(),
  }),

  geocodeQuery: Joi.object({
    address: safeStr(3, 200).required(),
  }),

  autocompleteQuery: Joi.object({
    input: safeStr(3, 200).required(),
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
    email: Joi.string().email().max(254).optional(),
  }).min(1),
};

module.exports = { validate, schemas };
