const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runMigrations, splitStatements } = require('../src/services/migrationRunner');

// Régression du bug de juillet 2026 : un bloc de commentaires en tête de
// fichier (sans point-virgule) se collait à la première instruction et le
// filtre startsWith('--') jetait le tout — les migrations 003-010 perdaient
// silencieusement leur première instruction.
test('splitStatements keeps a statement preceded by a comment block', () => {
  const sql = [
    '-- Commentaire de tête sur',
    '-- plusieurs lignes, sans point-virgule.',
    '',
    'ALTER TABLE reservations ADD COLUMN reminder_sent_at DATETIME NULL;',
    '',
    'ALTER TABLE chats ADD UNIQUE INDEX uq (announcement_id);',
  ].join('\n');
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].startsWith('ALTER TABLE reservations'));
  assert.ok(stmts[1].startsWith('ALTER TABLE chats'));
});

test('splitStatements handles multi-line statements and interleaved comments', () => {
  const sql = [
    'CREATE TABLE t (',
    '  id INT,',
    '  name VARCHAR(10)',
    ');',
    '-- commentaire au milieu',
    'INSERT INTO t VALUES (1, "a");',
  ].join('\n');
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 2);
  assert.ok(stmts[0].includes('VARCHAR(10)'));
  assert.ok(stmts[1].startsWith('INSERT INTO t'));
});

test('fresh database is provisioned from baseline.sql and migrations are recorded', async () => {
  const baselinePath = path.join(__dirname, '..', 'src', 'migrations', 'baseline.sql');
  assert.ok(fs.existsSync(baselinePath), 'baseline.sql must exist (npm run schema:baseline)');
  const baselineStatementCount = splitStatements(fs.readFileSync(baselinePath, 'utf8')).length;
  const migrationFiles = fs.readdirSync(path.join(__dirname, '..', 'src', 'migrations'))
    .filter(f => /^\d+_.+\.sql$/.test(f));

  const executed = [];
  const recorded = [];
  const fakeDb = {
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (/information_schema\.TABLES/.test(sql)) return cb(null, [{ n: 0 }]);
      if (/^INSERT INTO schema_migrations/.test(sql)) { recorded.push(params[0]); return cb(null, {}); }
      if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return cb(null, {});
      executed.push(sql);
      return cb(null, []);
    },
  };

  const ran = await runMigrations(fakeDb);
  assert.equal(ran, migrationFiles.length);
  assert.equal(recorded.length, migrationFiles.length);
  assert.deepEqual([...recorded].sort(), [...migrationFiles].sort());
  assert.equal(executed.length, baselineStatementCount);
  assert.ok(executed.some(s => /CREATE TABLE `users`/.test(s)), 'baseline must create users');
});

test('existing database keeps the incremental path (nothing to apply)', async () => {
  const fakeDb = {
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (/information_schema\.TABLES/.test(sql)) return cb(null, [{ n: 36 }]);
      if (/^SELECT filename FROM schema_migrations/.test(sql)) {
        const files = fs.readdirSync(path.join(__dirname, '..', 'src', 'migrations'))
          .filter(f => /^\d+_.+\.sql$/.test(f))
          .map(f => ({ filename: f }));
        return cb(null, files);
      }
      return cb(null, []);
    },
  };
  const ran = await runMigrations(fakeDb);
  assert.equal(ran, 0);
});
