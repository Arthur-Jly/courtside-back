/**
 * Routes d'authentification - Version refactorisée
 * 
 * Améliorations :
 * - Utilise Promises au lieu de callbacks (plus de callback hell)
 * - Validation des inputs avec Joi
 * - Gestion d'erreurs centralisée
 * - Logging structuré
 * - Code plus lisible et maintenable
 * 
 * ⚠️ Les routes restent IDENTIQUES (pas de breaking changes)
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { queryPromise, queryOne, insert } = require('../utils/dbHelpers');
const { validate, schemas } = require('../middleware/validation');
const { 
  asyncHandler, 
  ConflictError, 
  UnauthorizedError 
} = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

module.exports = (db, jwtSecret) => {
  const router = express.Router();

  /**
   * POST /api/register
   * Inscription d'un nouvel utilisateur
   */
  router.post('/register', validate(schemas.register), asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;

    // Vérifier si l'email existe déjà
    const existingUser = await queryOne(
      db, 
      'SELECT id FROM users WHERE email = ?', 
      [email]
    );

    if (existingUser) {
      throw new ConflictError('Cet email est déjà utilisé.');
    }

    // Hasher le mot de passe
    const hash = await bcrypt.hash(password, 10);

    // Insérer le nouvel utilisateur
    const userId = await insert(
      db,
      'INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, NOW())',
      [name, email, hash, role]
    );

    // Récupérer l'utilisateur créé
    const user = await queryOne(
      db,
      'SELECT id, name, email, role FROM users WHERE id = ?',
      [userId]
    );

    // Générer le token JWT
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      jwtSecret,
      { expiresIn: '2h' }
    );

    logger.info(`Nouvel utilisateur inscrit: ${email}`);

    res.json({ ...user, token });
  }));

  /**
   * POST /api/login
   * Connexion d'un utilisateur
   */
  router.post('/login', validate(schemas.login), asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Récupérer l'utilisateur
    const user = await queryOne(
      db,
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (!user) {
      throw new UnauthorizedError('Email ou mot de passe incorrect.');
    }

    // Vérifier le mot de passe
    const match = await bcrypt.compare(password, user.password_hash);
    
    if (!match) {
      throw new UnauthorizedError('Email ou mot de passe incorrect.');
    }

    // Générer le token JWT
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      jwtSecret,
      { expiresIn: '2h' }
    );

    logger.info(`Utilisateur connecté: ${email}`);

    res.json({ 
      id: user.id, 
      name: user.name, 
      email: user.email, 
      role: user.role, 
      token 
    });
  }));

  return router;
};
