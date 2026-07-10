/**
 * Base MySQL jetable pour les tests d'intégration.
 * - Droppe puis recrée `courtside_test` (jamais la base de dev).
 * - Provisionne le schéma via le vrai runner (chemin baseline: base vide).
 * - Sème des fixtures minimales : 1 club confirmé, 1 terrain, 3 users, 2 slots.
 *
 * Credentials : .env local en dev ; en CI, DB_HOST/DB_USER/DB_PASSWORD/DB_PORT
 * pointent sur le service container.
 */
require('dotenv').config();
const mysql = require('mysql2');
const { runMigrations } = require('../../../src/services/migrationRunner');

const TEST_DB = 'courtside_test';

const baseConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
};

function q(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function createTestDb() {
  const root = mysql.createConnection(baseConfig);
  await q(root, `DROP DATABASE IF EXISTS ${TEST_DB}`);
  await q(root, `CREATE DATABASE ${TEST_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  root.end();

  const pool = mysql.createPool({ ...baseConfig, database: TEST_DB, connectionLimit: 5 });
  await runMigrations(pool); // base vide -> baseline.sql
  return {
    pool,
    query: (sql, params) => q(pool, sql, params),
    async destroy() {
      await q(pool, `DROP DATABASE ${TEST_DB}`).catch(() => {});
      await new Promise(res => pool.end(res));
    },
  };
}

/** Fixtures minimales ; renvoie les ids créés. */
async function seed(db) {
  await db.query(`INSERT INTO clubs (id, name, city, status) VALUES (1, 'Club Test', 'Lyon', 'confirme')`);
  await db.query(`INSERT INTO terrains (id, club_id, name, sport_type, price_per_hour, slot_duration)
                  VALUES (2, 1, 'Padel 1', 'padel', 20, 90)`);
  await db.query(`INSERT INTO users (id, name, email, password_hash, role, username) VALUES
    (7,  'Paul Joueur', 'paul@test.dev',  'x', 'player', 'paul'),
    (8,  'Léa Marchand','lea@test.dev',   'x', 'player', 'lea'),
    (20, 'Ad Min',      'admin@test.dev', 'x', 'club_admin', 'admin20')`);
  await db.query(`UPDATE users SET club_id = 1 WHERE id = 20`);
  await db.query(`INSERT INTO slots (id, club_id, terrain_id, date, start_time, end_time, status) VALUES
    (42, 1, 2, '2030-06-15', '10:00:00', '11:30:00', 'free'),
    (43, 1, 2, '2030-06-15', '11:30:00', '13:00:00', 'free')`);
  return { clubId: 1, terrainId: 2, playerId: 7, otherPlayerId: 8, adminId: 20, slotId: 42, slot2Id: 43 };
}

module.exports = { createTestDb, seed, TEST_DB };
