#!/usr/bin/env node
/**
 * Recoupement en masse des terrains publics avec la BD TOPO de l'IGN.
 *
 *   node scripts/verify-places.js --dep 38,69        # départements
 *   node scripts/verify-places.js --city Montpellier
 *   node scripts/verify-places.js --all              # toute la base
 *   node scripts/verify-places.js --all --force      # même les terrains déjà vérifiés
 *
 * La recherche vérifie déjà les zones à la volée (services/placeVerification) :
 * ce script sert à préchauffer une région, ou à tout revérifier après une
 * nouvelle édition de la BD TOPO. Une requête WFS par cellule de ~11 km, avec
 * une pause entre deux : l'IGN est un service public.
 *
 * Ne touche jamais un statut posé par un humain (curation, communauté, signalement).
 */
require('dotenv').config();
const mysql = require('mysql2');
const { queryPromise } = require('../src/utils/dbHelpers');
const { createPlaceVerification, PLACE_COLUMNS, RECHECK_DAYS } = require('../src/services/placeVerification');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dep') out.dep = argv[++i];
    else if (a === '--city') out.city = argv[++i];
  }
  return out;
}

/** Sélection des terrains à vérifier. Exportée pour l'import par département. */
function selectionSql({ dep, city, all, force, departments }) {
  const where = ["verification_status <> 'reported_invalid'", 'source_missing_at IS NULL'];
  const params = [];
  if (!force) {
    where.push('(ign_checked_at IS NULL OR ign_checked_at < DATE_SUB(NOW(), INTERVAL ? DAY))');
    params.push(RECHECK_DAYS);
  }
  if (departments && departments.length) {
    where.push(`department IN (${departments.map(() => '?').join(',')})`);
    params.push(...departments);
  } else if (dep) {
    // --dep prend des codes (38) : la colonne stocke le nom ; on passe par le code postal.
    const codes = dep.split(',').map(d => d.trim()).filter(Boolean);
    where.push(`(${codes.map(() => 'postal_code LIKE ?').join(' OR ')})`);
    params.push(...codes.map(c => `${c}%`));
  } else if (city) {
    where.push('LOWER(city) = LOWER(?)');
    params.push(city);
  } else if (!all) {
    throw new Error('Préciser --dep, --city ou --all');
  }
  return { sql: `SELECT ${PLACE_COLUMNS} FROM public_places WHERE ${where.join(' AND ')}`, params };
}

/** Vérifie la sélection et affiche la progression. */
async function run(db, selection, log = console.log) {
  const { sql, params } = selectionSql(selection);
  const places = await queryPromise(db, sql, params);
  log(`${places.length} terrains à recouper avec la BD TOPO…`);
  if (places.length === 0) return { confirmed: 0, recentered: 0, unmatched: 0 };
  const verification = createPlaceVerification(db);
  const total = await verification.verifyPlaces(places, {
    onTile: (i, n, c) => log(`  cellule ${i}/${n} : ${c.confirmed} confirmés, ${c.recentered} recalés, ${c.unmatched} sans terrain IGN`),
  });
  log(`\nConfirmés IGN : ${total.confirmed} · recalés : ${total.recentered} · sans terrain IGN : ${total.unmatched}`);
  return total;
}

module.exports = { selectionSql, run };

if (require.main === module) {
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sport',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    connectionLimit: 4,
  });
  run(db, parseArgs(process.argv))
    .catch((e) => { console.error('❌ ' + e.message); process.exitCode = 1; })
    .finally(() => db.end());
}
