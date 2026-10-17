#!/usr/bin/env node
/**
 * Import des terrains publics depuis Data ES (ministère des Sports).
 *
 *   node scripts/import-public-places.js --dep 38,69      # Isère + Rhône
 *   node scripts/import-public-places.js --city Grenoble
 *   node scripts/import-public-places.js --all            # France entière
 *   node scripts/import-public-places.js --dep 38 --dry   # simulation
 *   node scripts/import-public-places.js --dep 38 --no-verify   # sans recoupement IGN
 *
 * Ce script n'est plus indispensable : une recherche sur une zone jamais vue
 * charge ses terrains à la demande (src/services/placeCoverage.js). Il reste
 * utile pour préchauffer une région, ou avec --prune pour retirer les lieux qui
 * ne sont plus éligibles.
 *
 * Les filtres (couche 1) sont dans src/services/dataEs.js, partagés avec le
 * chargement à la demande. Ils sont volontairement stricts : une partie
 * organisée sur un terrain inexistant fait perdre l'utilisateur définitivement.
 *
 * Le script est rejouable : upsert sur external_ref, et il n'écrase JAMAIS un
 * statut de vérification humain (manually_curated / community_verified).
 */
require('dotenv').config();
const mysql = require('mysql2');
const dataEs = require('../src/services/dataEs');
const verify = require('./verify-places');

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--prune') out.prune = true;
    else if (a === '--no-verify') out.noVerify = true;
    else if (a === '--dep') out.dep = argv[++i];
    else if (a === '--city') out.city = argv[++i];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  const where = dataEs.buildAdminWhere(args);

  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sport',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    connectionLimit: 4,
  });
  const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  console.log(`Filtre : ${where}\n`);

  const rejects = {};
  const seenRefs = new Set();          // pour --prune
  const seenDepartments = new Set();   // périmètre de la purge
  let read = 0, kept = 0, inserted = 0, updated = 0, skippedCurated = 0;
  let offset = 0, total = null;

  try {
    while (total === null || offset < total) {
      const page = await dataEs.fetchPage(where, offset);
      if (total === null) {
        total = page.total_count;
        console.log(`${total} équipements en accès libre à examiner…\n`);
        if (total === 0) break;
      }
      // L'API Explore plafonne offset+limit à 10 000.
      if (offset + dataEs.PAGE_SIZE > 10000) {
        console.warn('\n⚠️  Plafond API atteint (10 000). Relancer département par département.');
        break;
      }

      const rows = [];
      for (const r of page.results) {
        read++;
        if (r.dep_nom) seenDepartments.add(r.dep_nom);
        const reason = dataEs.rejectReason(r);
        if (reason) { rejects[reason] = (rejects[reason] || 0) + 1; continue; }
        kept++;
        seenRefs.add(r.equip_numero);
        rows.push(dataEs.toRow(r));
      }

      if (!args.dry) {
        const counts = await dataEs.upsertPlaces(q, rows);
        inserted += counts.inserted;
        updated += counts.updated;
        skippedCurated += counts.skippedCurated;
      }

      offset += dataEs.PAGE_SIZE;
      if (offset % 1000 === 0) process.stdout.write(`  …${offset}/${total}\n`);
    }

    // Purge : masque les lieux du périmètre importé qui ne ressortent plus de
    // l'API (équipement retiré, ou devenu non éligible après correction d'un
    // filtre) — `source_missing_at`, comme le rafraîchissement à la demande.
    // Jamais de DELETE : des parties et des signalements s'y rattachent. On ne
    // touche ni à un lieu vérifié par un humain ou confirmé par des joueurs, ni
    // à un lieu ajouté par un utilisateur.
    let pruned = 0;
    if (args.prune && !args.dry && seenRefs.size > 0 && seenDepartments.size > 0) {
      // Périmètre STRICT : uniquement les départements réellement parcourus.
      // Sans ça, importer l'Isère masquerait les terrains de toutes les
      // autres régions déjà en base.
      const deps = [...seenDepartments];
      const placeholders = deps.map(() => '?').join(',');
      const candidates = await q(
        `SELECT id, external_ref FROM public_places
         WHERE source = 'data_es' AND source_missing_at IS NULL
           AND verification_status NOT IN ('manually_curated', 'community_verified')
           AND department IN (${placeholders})`,
        deps
      );
      const stale = candidates.filter(c => !seenRefs.has(c.external_ref));
      for (const s of stale) {
        await q('UPDATE public_places SET source_missing_at = NOW() WHERE id = ?', [s.id]);
        pruned++;
      }
    }

    // Recoupement IGN des départements importés : sans preuve d'existence, un
    // terrain n'est pas montré par défaut (services/placeStatus).
    if (!args.dry && !args.noVerify && seenDepartments.size > 0) {
      console.log('\n── Recoupement BD TOPO (IGN) ─────────────');
      await verify.run(db, { departments: [...seenDepartments] });
    }

    console.log('\n── Résultat ──────────────────────────────');
    console.log(`Lus            : ${read}`);
    console.log(`Retenus        : ${kept}${args.dry ? '  (simulation)' : ''}`);
    if (!args.dry) {
      console.log(`  insérés      : ${inserted}`);
      console.log(`  mis à jour   : ${updated}`);
      console.log(`  curés (gardés intacts) : ${skippedCurated}`);
      if (args.prune) console.log(`  masqués (plus dans Data ES): ${pruned}`);
    }
    console.log(`Rejetés        : ${read - kept}`);
    Object.entries(rejects).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${k.padEnd(26)} ${v}`));
  } finally {
    db.end();
  }
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
