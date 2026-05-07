/**
 * Middleware de validation des inputs
 * Centralise la validation pour éviter la duplication
 */

const Joi = require('joi');

/**
 * Validation middleware factory
 */
const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }
    
    next();
  };
};

/**
 * Validation schemas
 */
const schemas = {
  register: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(6).max(100).required(),
    role: Joi.string().valid('player', 'club_admin').required(),
    club_name: Joi.string().max(200).optional()
  }),

  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().required()
  }),

  addFavorite: Joi.object({
    user_id: Joi.number().integer().positive().required(),
    terrain_id: Joi.number().integer().positive().required()
  }),

  removeFavorite: Joi.object({
    user_id: Joi.number().integer().positive().required(),
    terrain_id: Joi.number().integer().positive().required()
  }),

  sendFriendRequest: Joi.object({
    from_user_id: Joi.number().integer().positive().required(),
    to_user_id: Joi.number().integer().positive().required()
  }),

  bookSlot: Joi.object({
    user_id: Joi.number().integer().positive().required(),
    price: Joi.number().positive().optional()
  }),

  geocodeQuery: Joi.object({
    address: Joi.string().min(3).max(200).required()
  }),

  autocompleteQuery: Joi.object({
    input: Joi.string().min(3).max(200).required()
  })
};

module.exports = {
  validate,
  schemas
};
