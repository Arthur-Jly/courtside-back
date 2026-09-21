/**
 * Accès DB — une seule porte d'entrée pour tout le back.
 *
 * Le pool est créé en style callback dans `index.js` (mysql2 non-promise) parce
 * que quelques appels bas niveau en ont besoin ; `poolOf()` en dérive le pool
 * promise de mysql2 et c'est lui qu'on utilise partout ailleurs. Les tests
 * injectent un faux `db` qui expose la même paire (`query` + `promise()`).
 *
 * Règle : dans le code métier, jamais de `db.query(sql, params, cb)` — on passe
 * par `queryPromise` / `queryOne` / `insert`.
 */

/** Pool promise de mysql2, qu'on reçoive le pool callback ou déjà le promise. */
const poolOf = (db) => (db && typeof db.promise === 'function' ? db.promise() : db);

/** Lignes d'un SELECT (ou l'objet résultat d'un INSERT/UPDATE/DELETE). */
const queryPromise = async (db, sql, params = []) => {
  const [rows] = await poolOf(db).query(sql, params);
  return rows;
};

/** Première ligne d'un SELECT, ou `null`. */
const queryOne = async (db, sql, params = []) => {
  const rows = await queryPromise(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
};

/** INSERT — renvoie l'id généré. */
const insert = async (db, sql, params = []) => {
  const result = await queryPromise(db, sql, params);
  return result.insertId;
};

/** Récupère le club_id à partir du nom du club. */
const getClubIdByName = async (db, clubName) => {
  const sql = 'SELECT id FROM clubs WHERE name = ? LIMIT 1';
  const club = await queryOne(db, sql, [clubName]);
  return club ? club.id : null;
};

module.exports = {
  poolOf,
  queryPromise,
  queryOne,
  insert,
  getClubIdByName,
};
