/**
 * Minimal SQL migration runner (no extra dependency).
 *
 * - Files live in src/migrations/*.sql, applied in filename order.
 * - Applied filenames are recorded in schema_migrations.
 * - Statements are separated by a semicolon at end of line.
 * - "Already exists" errors (table 1050, column 1060, index 1061) and
 *   "already dropped" errors (index/column 1091, check constraint 3821)
 *   are tolerated so migrations can run on legacy databases in any state.
 * - FRESH database (no tables): baseline.sql (full schema, regenerated via
 *   `npm run schema:baseline`) is executed instead, and every numbered
 *   migration is recorded as applied — they are already folded into it.
 *
 * Used at server boot and via `npm run migrate`.
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const TOLERATED_ERRNOS = new Set([1050, 1060, 1061, 1091, 3821]);
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function splitStatements(sql) {
  // Strip full-line "--" comments first, otherwise a leading comment block
  // (no trailing semicolon) glues onto the next statement and the whole
  // chunk gets dropped by the startsWith('--') filter below.
  const stripped = sql
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  return stripped
    .split(/;\s*(?:\r?\n|$)/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--'));
}

async function runMigrations(db) {
  // Fresh database? (checked before creating schema_migrations)
  const tableCount = (await query(db,
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'))[0].n;

  await query(db, `CREATE TABLE IF NOT EXISTS schema_migrations (
    filename VARCHAR(255) PRIMARY KEY,
    applied_at DATETIME NOT NULL
  )`);

  // Only numbered migrations (NNN_name.sql) — legacy ad-hoc .sql files
  // in this directory are ignored.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.+\.sql$/.test(f))
    .sort();

  const baselinePath = path.join(MIGRATIONS_DIR, 'baseline.sql');
  if (tableCount === 0 && fs.existsSync(baselinePath)) {
    logger.info('Fresh database: provisioning full schema from baseline.sql');
    for (const statement of splitStatements(fs.readFileSync(baselinePath, 'utf8'))) {
      await query(db, statement);
    }
    for (const file of files) {
      await query(db, 'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, NOW())', [file]);
    }
    logger.info(`Baseline applied — ${files.length} migrations recorded as included`);
    return files.length;
  }

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
