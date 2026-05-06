/**
 * Utilitaires pour convertir callbacks en Promises
 * Évite le callback hell
 */

/**
 * Wrapper pour convertir db.query en Promise
 */
const queryPromise = (db, sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) {
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
};

/**
 * Wrapper pour des requêtes qui retournent un seul résultat
 */
const queryOne = async (db, sql, params = []) => {
  const results = await queryPromise(db, sql, params);
  return results.length > 0 ? results[0] : null;
};

/**
 * Wrapper pour INSERT qui retourne l'ID inséré
 */
const insert = async (db, sql, params = []) => {
  const result = await queryPromise(db, sql, params);
  return result.insertId;
};

/**
 * Transaction helper
 */
const transaction = async (db, callback) => {
  return new Promise((resolve, reject) => {
    db.beginTransaction(async (err) => {
      if (err) return reject(err);
      
      try {
        const result = await callback(db);
        db.commit((err) => {
          if (err) {
            return db.rollback(() => reject(err));
          }
          resolve(result);
        });
      } catch (error) {
        db.rollback(() => reject(error));
      }
    });
  });
};

/**
 * Récupère le club_id à partir du nom du club
 */
const getClubIdByName = async (db, clubName) => {
  const sql = 'SELECT id FROM clubs WHERE name = ? LIMIT 1';
  const club = await queryOne(db, sql, [clubName]);
  return club ? club.id : null;
};

module.exports = {
  queryPromise,
  queryOne,
  insert,
  transaction,
  getClubIdByName
};
