/**
 * Fake db pour les tests : dispatch par motif SQL, dans l'ordre de déclaration.
 *   const db = fakeDb([[/SELECT .* FROM users/, (params, sql) => [row]], ...]);
 * - handler jette -> cb(err) (simule une erreur MySQL : e.errno/e.code respectés)
 * - db.calls = [{ sql, params }] pour asserter sur les requêtes émises
 * - supporte les signatures (sql, cb) et (sql, params, cb), + db.promise()
 */
function fakeDb(handlers) {
  const calls = [];
  const db = {
    calls,
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      calls.push({ sql, params });
      for (const [re, respond] of handlers) {
        if (re.test(sql)) {
          try {
            const out = respond(params, sql);
            // support [rows, fields] attendu par l'API promise de mysql2
            return process.nextTick(() => cb(null, out));
          } catch (e) {
            return process.nextTick(() => cb(e));
          }
        }
      }
      process.nextTick(() => cb(new Error('Unexpected SQL in test: ' + String(sql).slice(0, 100))));
    },
    promise() {
      return {
        query: (sql, params = []) => new Promise((resolve, reject) => {
          db.query(sql, params, (err, rows) => (err ? reject(err) : resolve([rows, []])));
        }),
      };
    },
  };
  return db;
}

/** Erreur MySQL simulée (ex: dupEntry() pour ER_DUP_ENTRY). */
function mysqlError(errno, code, message = code) {
  const e = new Error(message);
  e.errno = errno;
  e.code = code;
  return e;
}
const dupEntry = (msg = 'Duplicate entry') => mysqlError(1062, 'ER_DUP_ENTRY', msg);

module.exports = { fakeDb, mysqlError, dupEntry };
