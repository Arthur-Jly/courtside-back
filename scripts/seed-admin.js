#!/usr/bin/env node
/**
 * Crée (ou met à jour) le compte super-admin plateforme.
 *
 * Usage :
 *   node scripts/seed-admin.js <email> <password> [name]
 *
 * Idempotent : si l'email existe déjà, il est promu en role='admin' et son
 * mot de passe est réinitialisé à celui fourni. Sinon un nouveau compte
 * admin est créé. Le username est dérivé de l'email (partie locale).
 */
require('dotenv').config();
const mysql = require('mysql2');
const bcrypt = require('bcrypt');

const [, , email, password, nameArg] = process.argv;

if (!email || !password) {
  console.error('Usage: node scripts/seed-admin.js <email> <password> [name]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Le mot de passe doit faire au moins 8 caractères.');
  process.exit(1);
}

const name = nameArg || 'Admin Courtside';
const username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) || 'admin';
const rounds = Number(process.env.BCRYPT_ROUNDS) || 12;

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  connectionLimit: 2,
});

const q = (sql, params = []) => new Promise((resolve, reject) =>
  db.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));

(async () => {
  const hash = await bcrypt.hash(password, rounds);
  const existing = await q('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    await q("UPDATE users SET role = 'admin', password_hash = ?, club_id = NULL WHERE email = ?", [hash, email]);
    console.log(`✅ Compte existant promu admin : ${email} (id=${existing[0].id})`);
  } else {
    // Assure l'unicité du username (collision possible avec un compte existant).
    let uname = username;
    while ((await q('SELECT id FROM users WHERE username = ?', [uname])).length > 0) {
      uname = `${username}${Math.floor(Math.random() * 10000)}`.slice(0, 30);
    }
    const r = await q(
      "INSERT INTO users (name, email, password_hash, role, username, created_at) VALUES (?, ?, ?, 'admin', ?, NOW())",
      [name, email, hash, uname]);
    console.log(`✅ Compte admin créé : ${email} (id=${r.insertId}, username=${uname})`);
  }
})()
  .then(() => db.end(() => process.exit(0)))
  .catch((e) => { console.error('❌ ' + e.message); db.end(() => process.exit(1)); });
