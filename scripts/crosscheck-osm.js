#!/usr/bin/env node
/**
 * Recoupement OpenStreetMap des terrains publics, en masse.
 *
 *   node scripts/crosscheck-osm.js --city Grenoble
 *   node scripts/crosscheck-osm.js --dep 38,69
 *   node scripts/crosscheck-osm.js --all --dry
 *   node scripts/crosscheck-osm.js --all --force     # même les terrains déjà recoupés
 *
 * La recherche dépose déjà ses zones dans une file d'attente (services/osmQueue) :
 * ce script sert à traiter une région d'un coup, ou à tout repasser avec les
 * règles durcies (services/osmCheck : terrain du bon sport, accès non privé,
 * ≤ 30 m ; un complexe sportif seul ne confirme plus rien).
 *
 * Un terrain absent d'OSM n'est pas invalidé : il garde sa preuve IGN s'il en a
 * une, sinon il reste sans preuve (« À confirmer »).
 *
 * Méthode : une requête Overpass par tuile (pas une par terrain), puis
 * appariement local. Overpass est un service public gratuit — on attend entre
 * deux requêtes.
 */
require('dotenv').config({ quiet: true });
const mysql = require('mysql2');
const { distanceM } = require('../src/utils/geo');
const osmCheck = require('../src/services/osmCheck');
const { OSM_COLUMNS, RECHECK_DAYS } = require('../src/services/osmQueue');

const MATCH_RADIUS_M = osmCheck.MATCH_M;
// Tuiles larges : l'instance publique Overpass limite le NOMBRE de requêtes, pas
// leur taille. 0,4° ≈ 45 km — une agglomération entière en une requête.
const TILE_DEG = 0.4;
const PAUSE_MS = 6000;           // courtoisie envers un service public gratuit

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--force') out.force = true;
    else if (a === '--city') out.city = argv[++i];
    else if (a === '--dep') out.dep = argv[++i];
  }
  return out;
}

/** Découpe les lieux en tuiles géographiques : une requête Overpass par tuile. */
function tile(places) {
  const tiles = new Map();
  for (const p of places) {
    const key = `${Math.floor(p.lat / TILE_DEG)}_${Math.floor(p.lng / TILE_DEG)}`;
    const t = tiles.get(key) || [];
    t.push(p);
    tiles.set(key, t);
  }
  return [...tiles.values()];
}

function bbox(places, marginDeg = 0.01) {
  const lats = places.map(p => p.lat), lngs = places.map(p => p.lng);
  return [
    Math.min(...lats) - marginDeg, Math.min(...lngs) - marginDeg,
    Math.max(...lats) + marginDeg, Math.max(...lngs) + marginDeg,
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sport',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    connectionLimit: 4,
  });
  const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  try {
    const where = ["verification_status <> 'reported_invalid'", 'source_missing_at IS NULL'];
    const params = [];
    if (!args.force) {
      where.push('(osm_checked_at IS NULL OR osm_checked_at < DATE_SUB(NOW(), INTERVAL ? DAY))');
      params.push(RECHECK_DAYS);
    }
    if (args.city) { where.push('city LIKE ?'); params.push(`${args.city}%`); }
    if (args.dep) {
      const list = args.dep.split(',').map(d => d.trim()).filter(Boolean);
      where.push(`(${list.map(() => 'postal_code LIKE ?').join(' OR ')})`);
      params.push(...list.map(d => `${d}%`));
    }
    if (!args.city && !args.dep && !args.all) {
      console.log('Préciser --city, --dep ou --all.');
      return;
    }

    const places = await q(`SELECT ${OSM_COLUMNS} FROM public_places WHERE ${where.join(' AND ')}`, params);
    if (places.length === 0) {
      console.log('Aucun lieu à recouper pour ce périmètre.');
      return;
    }

    const tiles = tile(places.map(p => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) })));
    console.log(`${places.length} lieux à recouper · ${tiles.length} requête(s) Overpass\n`);

    const total = { confirmed: 0, disused: 0, unmatched: 0 };
    let failedTiles = 0;
    for (let i = 0; i < tiles.length; i++) {
      const group = tiles[i];
      const [s, w, n, e] = bbox(group, 0.001);
      let elements;
      try {
        elements = await osmCheck.fetchPitches({ south: s, west: w, north: n, east: e }, { log: m => console.log(`    ${m}`) });
      } catch (err) {
        // Overpass sature régulièrement : une tuile ratée ne doit pas perdre le reste.
        failedTiles++;
        console.log(`  tuile ${i + 1}/${tiles.length} : échec Overpass (${err.message}) — ignorée`);
        if (i < tiles.length - 1) await sleep(PAUSE_MS);
        continue;
      }

      let counts;
      if (args.dry) {
        counts = { confirmed: 0, disused: 0, unmatched: 0 };
        for (const p of group) {
          const m = osmCheck.matchPlace(p, elements);
          if (m.ref) counts.confirmed++; else if (m.disused) counts.disused++; else counts.unmatched++;
        }
      } else {
        counts = await osmCheck.apply(q, group, elements);
      }
      for (const k of Object.keys(total)) total[k] += counts[k];
      console.log(`  tuile ${i + 1}/${tiles.length} : ${group.length} lieux, ${elements.length} terrains OSM → ${counts.confirmed} confirmés, ${counts.disused} désaffectés`);
      if (i < tiles.length - 1) await sleep(PAUSE_MS);
    }

    console.log('\n── Recoupement OSM ───────────────────────');
    console.log(`Confirmés OSM        : ${total.confirmed}${args.dry ? ' (simulation)' : ''}`);
    console.log(`Désaffectés repérés  : ${total.disused}`);
    console.log(`Sans terrain OSM     : ${total.unmatched}  → statut selon la preuve IGN, sinon « À confirmer »`);
    if (failedTiles) console.log(`Tuiles en échec      : ${failedTiles} — relancer plus tard`);
  } finally {
    db.end();
  }
}

if (require.main === module) {
  main().catch(e => { console.error('❌ ' + e.message); process.exitCode = 1; });
}

// Exportés pour les tests.
module.exports = { distanceM, tile, bbox, MATCH_RADIUS_M, TILE_DEG };
