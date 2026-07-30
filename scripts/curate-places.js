#!/usr/bin/env node
/**
 * Curation manuelle des terrains publics (couche 4).
 *
 * Data ES contient des équipements détruits, murés ou inaccessibles. Sur les
 * villes de lancement, une vérification humaine évite qu'un utilisateur
 * organise sa première partie sur un terrain fantôme — et la perde définitivement.
 *
 * Aller-retour CSV :
 *
 *   0) node scripts/crosscheck-osm.js --city Grenoble
 *      → confirme automatiquement ce qu'OSM connaît : la pile à vérifier fond
 *
 *   1) node scripts/curate-places.js --export --city Grenoble
 *      (ou --dep 38,69 pour un département entier)
 *      → produit curation-grenoble.csv (un lien Street View par terrain)
 *
 *   2) Ouvrir le CSV, cliquer chaque lien, remplir la colonne `verdict` :
 *        ok   → le terrain existe et est jouable
 *        ko   → inexistant / muré / inaccessible
 *        (vide) → non traité, laissé en l'état
 *
 *   3) node scripts/curate-places.js --import curation-grenoble.csv
 *
 * Un lieu marqué ok/ko n'est plus jamais écrasé par les réimports Data ES.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

const SEP = ';';           // Excel FR
const COLS = ['id', 'verdict', 'note', 'nom', 'type', 'adresse', 'ville', 'sports', 'eclairage', 'streetview'];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') out.export = true;
    else if (a === '--import') out.import = argv[++i];
    else if (a === '--city') out.city = argv[++i];
    else if (a === '--dep') out.dep = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--stats') out.stats = true;
  }
  return out;
}

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Découpe une ligne CSV en respectant les guillemets. */
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === SEP) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const streetView = (lat, lng) =>
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'sport',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  connectionLimit: 2,
});
const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function doExport(args) {
  if (!args.city && !args.dep) throw new Error('--city ou --dep requis');

  // Seuls les lieux non encore arbitrés : on ne redemande pas le travail déjà
  // fait — ni celui qu'OpenStreetMap a déjà confirmé (crosscheck-osm.js).
  const where = ["verification_status = 'auto'"];
  const params = [];
  if (args.city) { where.push('city LIKE ?'); params.push(`${args.city}%`); }
  if (args.dep) {
    const list = args.dep.split(',').map(d => d.trim()).filter(Boolean);
    where.push(`(${list.map(() => 'postal_code LIKE ?').join(' OR ')})`);
    params.push(...list.map(d => `${d}%`));
  }

  const rows = await q(
    `SELECT id, name, equip_type, address, city, sports, lighting, lat, lng
     FROM public_places
     WHERE ${where.join(' AND ')}
     ORDER BY city, name`,
    params
  );
  const scope = args.city || `dep-${args.dep}`;
  if (rows.length === 0) {
    console.log(`Aucun lieu en statut 'auto' pour "${scope}" — rien à curer.`);
    return;
  }

  const file = args.out || `curation-${scope.toLowerCase().replace(/\W+/g, '-')}.csv`;
  const lines = [COLS.join(SEP)];
  for (const r of rows) {
    const sports = Array.isArray(r.sports) ? r.sports.join('+') : String(r.sports || '');
    lines.push([
      r.id, '', '', r.name, r.equip_type, r.address, r.city,
      sports, r.lighting === 1 ? 'oui' : (r.lighting === 0 ? 'non' : '?'),
      streetView(r.lat, r.lng),
    ].map(esc).join(SEP));
  }
  // BOM UTF-8 : sans lui Excel casse les accents.
  fs.writeFileSync(file, '\uFEFF' + lines.join('\r\n'), 'utf8');

  console.log(`✅ ${rows.length} lieux exportés → ${path.resolve(file)}`);
  console.log('\nRemplir la colonne `verdict` : ok (existe) / ko (inexistant) / vide (non traité)');
  console.log(`Puis : node scripts/curate-places.js --import ${file}`);
}

async function doImport(file) {
  if (!fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}`);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const iId = header.indexOf('id');
  const iVerdict = header.indexOf('verdict');
  const iNote = header.indexOf('note');
  if (iId === -1 || iVerdict === -1) throw new Error('Colonnes `id` et `verdict` requises');

  let ok = 0, ko = 0, skipped = 0, unknown = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const id = Number(cells[iId]);
    const verdict = (cells[iVerdict] || '').trim().toLowerCase();
    const note = iNote >= 0 ? (cells[iNote] || '').trim() : '';
    if (!Number.isFinite(id)) continue;
    if (!verdict) { skipped++; continue; }

    if (verdict === 'ok' || verdict === 'o' || verdict === 'x') {
      await q("UPDATE public_places SET verification_status = 'manually_curated' WHERE id = ?", [id]);
      ok++;
    } else if (verdict === 'ko' || verdict === 'n') {
      await q("UPDATE public_places SET verification_status = 'reported_invalid' WHERE id = ?", [id]);
      ko++;
      if (note) console.log(`  #${id} invalidé — ${note}`);
    } else {
      unknown++;
    }
  }

  console.log('\n── Curation importée ─────────────────────');
  console.log(`Validés (manually_curated)   : ${ok}`);
  console.log(`Invalidés (reported_invalid) : ${ko}`);
  console.log(`Non traités                  : ${skipped}`);
  if (unknown) console.log(`Verdicts non reconnus        : ${unknown}`);
}

async function doStats() {
  const rows = await q(
    `SELECT city, verification_status, COUNT(*) n
     FROM public_places GROUP BY city, verification_status
     ORDER BY city`
  );
  const byCity = {};
  for (const r of rows) {
    byCity[r.city] = byCity[r.city] || {};
    byCity[r.city][r.verification_status] = r.n;
  }
  // `auto` = reste à vérifier à la main ; `osm` = recoupé automatiquement
  // (crosscheck-osm.js), donc hors de la pile de curation.
  console.log('Ville'.padEnd(28), 'auto   osm  curé  commu  invalide');
  Object.entries(byCity)
    .sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0))
    .slice(0, 25)
    .forEach(([city, s]) => console.log(
      city.slice(0, 27).padEnd(28),
      String(s.auto || 0).padStart(4),
      String(s.osm_confirmed || 0).padStart(5),
      String(s.manually_curated || 0).padStart(5),
      String(s.community_verified || 0).padStart(6),
      String(s.reported_invalid || 0).padStart(8),
    ));
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.export) await doExport(args);
  else if (args.import) await doImport(args.import);
  else if (args.stats) await doStats();
  else {
    console.log('Usage :');
    console.log('  --export --city <ville> | --dep <38,69> [--out fichier.csv]');
    console.log('  --import <fichier.csv>');
    console.log('  --stats');
  }
})()
  .then(() => db.end(() => process.exit(0)))
  .catch(e => { console.error('❌ ' + e.message); db.end(() => process.exit(1)); });
