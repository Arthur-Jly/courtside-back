/**
 * Minimal SQL migration runner (no extra dependency).
 *
 * - Files live in src/migrations/*.sql, applied in filename order.
 * - Applied filenames are recorded in schema_migrations.
 * - Statements are separated by a semicolon at end of line.
 * - "Already exists" errors (table 1050, column 1060, index 1061) are
 *   tolerated so baseline migrations can run on legacy databases.
 *
 * Used at server boot and via `npm run migrate`.
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const TOLERATED_ERRNOS = new Set([1050, 1060, 1061]);
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--'));
}

async function runMigrations(db) {
  await query(db, `CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at DATETIME NOT NULL
  )`);

  // Only numbered migrations (NNN_name.sql) — legacy ad-hoc .sql files
  // in this directory are ignored.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort();

  const appliedRows = await query(db, 'SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map(r => r.filename));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitStatements(sql)) {
      try {
        await query(db, statement);
      } catch (err) {
        if (TOLERATED_ERRNOS.has(err.errno)) {
          logger.warn(`Migration ${file}: skipped statement (already exists): ${err.message}`);
          continue;
        }
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    await query(db, 'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, NOW())', [file]);
    logger.info(`Migration applied: ${file}`);
    ran++;
  }
  if (ran === 0) logger.info('Migrations: nothing to apply');
  return ran;
}

module.exports = { runMigrations };
