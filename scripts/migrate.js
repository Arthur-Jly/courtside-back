#!/usr/bin/env node
/** Applies pending SQL migrations. Usage: npm run migrate */
require('dotenv').config();
const mysql = require('mysql2');
const { runMigrations } = require('../src/services/migrationRunner');

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  connectionLimit: 2,
});

runMigrations(db)
  .then((n) => {
    console.log(`Done. ${n} migration(s) applied.`);
    db.end(() => process.exit(0));
  })
  .catch((e) => {
    console.error(e.message);
    db.end(() => process.exit(1));
  });
