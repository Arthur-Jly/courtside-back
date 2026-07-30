#!/usr/bin/env node
/**
 * Recoupement OpenStreetMap des terrains publics (couche 2).
 *
 *   node scripts/crosscheck-osm.js --city Grenoble
 *   node scripts/crosscheck-osm.js --dep 38,69
 *   node scripts/crosscheck-osm.js --all --dry
 *
 * Deux sources indépendantes qui concordent, ça ne coûte rien : un équipement
 * présent à la fois dans Data ES et dans OSM existe très probablement. Les lieux
 * absents d'OSM ne sont PAS invalidés — ils restent simplement en `auto`, donc à
 * vérifier à la main (couche 4). C'est ce tri qui réduit le travail humain.
 *
 * Méthode : une requête Overpass par zone (pas une par terrain), puis
 * appariement local par distance. Overpass est un service public gratuit —
 * on le sollicite le moins possible et on attend entre deux requêtes.
 */
require('dotenv').config({ quiet: true });
const mysql = require('mysql2');

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const MATCH_RADIUS_M = 50;       // 50 m : la précision usuelle des deux référentiels
// Tuiles larges : l'instance publique Overpass limite le NOMBRE de requêtes, pas
// leur taille. 0,4° ≈ 45 km — une agglomération entière en une requête.
const TILE_DEG = 0.4;
const PAUSE_MS = 6000;           // courtoisie envers un service public gratuit
const MAX_RETRIES = 3;           // 429/504 sont transitoires : on réessaie en reculant
const TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--city') out.city = argv[++i];
    else if (a === '--dep') out.dep = argv[++i];
    else if (a === '--radius') out.radius = Number(argv[++i]);
  }
  return out;
}

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  connectionLimit: 2,
});
const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Distance haversine en mètres. */
function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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

/**
 * Terrains de sport OSM dans une bbox.
 * `leisure=pitch` est le tag standard ; `leisure=sports_centre` attrape les
 * plateaux et city-stades cartographiés plus grossièrement.
 */
async function fetchOsmPitches([s, w, n, e]) {
  const query = `[out:json][timeout:60];
(
  nwr["leisure"="pitch"](${s},${w},${n},${e});
  nwr["leisure"="sports_centre"](${s},${w},${n},${e});
);
out center tags;`;

  // 429 (trop de requêtes) et 504 (serveur saturé) sont la norme sur l'instance
  // publique : on recule et on réessaie plutôt que d'abandonner la tuile.
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'courtside-crosscheck/1.0 (contact: contact@courtside.fr)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if ((res.status === 429 || res.status === 504) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 15_000 * (attempt + 1);
        console.log(`    Overpass ${res.status} — nouvelle tentative dans ${Math.round(waitMs / 1000)}s`);
        clearTimeout(timer);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) throw new Error(`Overpass ${res.status}`);

      const json = await res.json();
      return (json.elements || [])
        .map(el => ({
          lat: el.lat ?? el.center?.lat,
          lng: el.lon ?? el.center?.lon,
          sport: el.tags?.sport || '',
        }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    } catch (e) {
      if (attempt >= MAX_RETRIES) throw e;
      await sleep(15_000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const radius = Number.isFinite(args.radius) ? args.radius : MATCH_RADIUS_M;

  const where = ["verification_status = 'auto'"];
  const params = [];
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

  const places = await q(
    `SELECT id, name, city, lat, lng FROM public_places WHERE ${where.join(' AND ')}`,
    params,
  );
  if (places.length === 0) {
    console.log("Aucun lieu en statut 'auto' pour ce périmètre — rien à recouper.");
    return;
  }

  const tiles = tile(places.map(p => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) })));
  console.log(`${places.length} lieux à recouper · ${tiles.length} requête(s) Overpass\n`);

  let confirmed = 0, unmatched = 0, failedTiles = 0;
  for (let i = 0; i < tiles.length; i++) {
    const group = tiles[i];
    let pitches;
    try {
      pitches = await fetchOsmPitches(bbox(group));
    } catch (e) {
      // Overpass sature régulièrement : une tuile ratée ne doit pas perdre le reste.
      failedTiles++;
      console.log(`  tuile ${i + 1}/${tiles.length} : échec Overpass (${e.message}) — ignorée`);
      if (i < tiles.length - 1) await sleep(PAUSE_MS);
      continue;
    }

    let tileConfirmed = 0;
    for (const place of group) {
      const near = pitches.some(p => distanceM(place.lat, place.lng, p.lat, p.lng) <= radius);
      if (!near) { unmatched++; continue; }
      tileConfirmed++;
      confirmed++;
      if (!args.dry) {
        // Garde-fou : on ne touche qu'aux lieux encore en `auto`, jamais à un
        // arbitrage humain rendu entre-temps.
        await q(
          "UPDATE public_places SET verification_status = 'osm_confirmed' WHERE id = ? AND verification_status = 'auto'",
          [place.id],
        );
      }
    }
    console.log(`  tuile ${i + 1}/${tiles.length} : ${group.length} lieux, ${pitches.length} terrains OSM → ${tileConfirmed} confirmés`);
    if (i < tiles.length - 1) await sleep(PAUSE_MS);
  }

  console.log('\n── Recoupement OSM ───────────────────────');
  console.log(`Confirmés (osm_confirmed) : ${confirmed}${args.dry ? ' (simulation)' : ''}`);
  console.log(`Sans correspondance OSM   : ${unmatched}  → à vérifier à la main (curate-places.js)`);
  if (failedTiles) console.log(`Tuiles en échec           : ${failedTiles} — relancer plus tard`);
}

if (require.main === module) {
  main()
    .then(() => db.end(() => process.exit(0)))
    .catch(e => { console.error('❌ ' + e.message); db.end(() => process.exit(1)); });
}

// Exportés pour les tests : ce sont eux qui décident si un terrain est confirmé.
module.exports = { distanceM, tile, bbox, MATCH_RADIUS_M, TILE_DEG };
