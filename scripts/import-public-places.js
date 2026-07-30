#!/usr/bin/env node
/**
 * Import des terrains publics depuis Data ES (ministère des Sports).
 *
 *   node scripts/import-public-places.js --dep 38,69      # Isère + Rhône
 *   node scripts/import-public-places.js --city Grenoble
 *   node scripts/import-public-places.js --all            # France entière
 *   node scripts/import-public-places.js --dep 38 --dry   # simulation
 *
 * Un référentiel national contient des équipements détruits, fermés ou fantômes.
 * Une partie organisée sur un terrain inexistant fait perdre l'utilisateur
 * définitivement : les filtres ci-dessous (couche 1) sont donc volontairement
 * stricts, quitte à écarter des lieux valides.
 *
 * Le script est rejouable : upsert sur external_ref, et il n'écrase JAMAIS un
 * statut de vérification humain (manually_curated / community_verified).
 */
require('dotenv').config();
const mysql = require('mysql2');

const API = 'https://equipements.sports.gouv.fr/api/explore/v2.1/catalog/datasets/data-es/records';
const PAGE_SIZE = 100;
const MAX_AGE_YEARS = 3;

// ── Liste blanche des types d'équipement ────────────────────────────────────
// Établie sur les facettes réelles de l'API (accès libre, foot ou basket).
// C'est CE filtre qui écarte les boucles de randonnée, plans d'eau, pumptracks
// et autres « terrains vagues ».
const TYPES_AUTORISES = new Set([
  'Multisports/City-stades',
  'Terrain de football',
  'Terrain de foot 5x5',
  'Terrain de futsal extérieur',
  'Terrain de soccer',
  'Terrain de basket-ball',
  'Terrain de basket-ball 3x3',
  'Terrain mixte',
  'Salle multisports (gymnase)',
]);

// aps_name (Data ES) -> clés internes (src/data/courts.js)
// Un équipement sans aucun sport ciblé est rejeté (cf. rejectReason).
const SPORTS_MAP = [
  [/football|futsal|soccer/i, 'foot'],
  [/basket/i, 'basket'],
];

// L'API Data ES renvoie ses booléens tantôt en booléens, tantôt en chaînes
// ("true"/"false") selon le champ et l'endpoint. On normalise.
function bool(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() === 'false') return false;
  }
  return null;
}
const tri = (v) => { const b = bool(v); return b === null ? null : (b ? 1 : 0); };

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--prune') out.prune = true;
    else if (a === '--dep') out.dep = argv[++i];
    else if (a === '--city') out.city = argv[++i];
  }
  return out;
}

function buildWhere({ dep, city, all }) {
  const clauses = ['equip_acc_libre="true"'];
  if (dep) {
    const list = dep.split(',').map(d => `"${d.trim()}"`).join(',');
    clauses.push(`dep_code in (${list})`);
  }
  if (city) clauses.push(`new_name="${city.replace(/"/g, '')}"`);
  if (!dep && !city && !all) throw new Error('Préciser --dep, --city ou --all');
  return clauses.join(' and ');
}

/**
 * Le terrain est-il ouvert aux particuliers ?
 * `equip_utilisateur` liste les publics admis : individus/familles, clubs,
 * scolaires, associations. Un équipement réservé aux seuls clubs ou scolaires
 * n'est pas exploitable pour une partie ouverte.
 */
function usableByIndividuals(utilisateur) {
  const raw = Array.isArray(utilisateur) ? utilisateur.join(' ') : String(utilisateur || '');
  return /individuel/i.test(raw);
}

/** Sports internes praticables sur cet équipement (d'après aps_name). */
function mapSports(apsName) {
  const list = Array.isArray(apsName) ? apsName : [];
  const set = new Set();
  for (const aps of list) {
    for (const [re, key] of SPORTS_MAP) if (re.test(aps)) set.add(key);
  }
  return [...set];
}

/**
 * Couche 1 : filtres durs. Retourne null si le lieu est retenu, sinon le motif
 * de rejet (pour pouvoir ajuster les filtres au vu des statistiques).
 */
function rejectReason(r, minDate) {
  // `equip_ouv_public_bool` n'est PAS un signal d'usage : c'est une notion
  // administrative (classement ERP). Des terrains de proximité municipaux
  // ouverts à tous y sont à "false". Le signal réel est `equip_utilisateur` :
  // on garde ce qui est ouvert aux individus, on écarte ce qui est réservé
  // aux clubs ou aux scolaires.
  if (!usableByIndividuals(r.equip_utilisateur)) return 'reserve_clubs_ou_scolaires';
  if (bool(r.inst_hs_bool) === true || bool(r.equip_hs_bool) === true) return 'hors_service';
  if (!TYPES_AUTORISES.has(r.equip_type_name)) return 'type_hors_liste_blanche';
  if (!r.equip_coordonnees || r.equip_coordonnees.lat == null) return 'sans_coordonnees';
  if (!r.inst_adresse) return 'sans_adresse';
  if (!r.new_name) return 'sans_commune';
  if (!r.equip_maj_date || r.equip_maj_date < minDate) return 'fiche_perimee';
  if (mapSports(r.aps_name).length === 0) return 'sport_hors_cible';
  return null;
}

function toRow(r) {
  return {
    external_ref: r.equip_numero,
    name: (r.equip_nom || r.inst_nom || 'Terrain').slice(0, 200),
    equip_type: r.equip_type_name,
    sports: JSON.stringify(mapSports(r.aps_name)),
    address: r.inst_adresse ? String(r.inst_adresse).slice(0, 255) : null,
    postal_code: r.inst_cp ? String(r.inst_cp).slice(0, 10) : null,
    city: String(r.new_name).slice(0, 120),
    department: r.dep_nom ? String(r.dep_nom).slice(0, 120) : null,
    lat: r.equip_coordonnees.lat,
    lng: r.equip_coordonnees.lon,
    free_access: 1,
    lighting: tri(r.equip_eclair),
    seasonal: tri(r.equip_saison),
    accessible_pmr: tri(r.equip_pmr_aire),
    data_updated_at: r.equip_maj_date || null,
  };
}

async function fetchPage(where, offset) {
  const url = `${API}?where=${encodeURIComponent(where)}&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API Data ES ${res.status} — ${await res.text()}`);
  return res.json();
}

(async () => {
  const args = parseArgs(process.argv);
  const where = buildWhere(args);

  const minDate = new Date();
  minDate.setFullYear(minDate.getFullYear() - MAX_AGE_YEARS);
  const minDateStr = minDate.toISOString().slice(0, 10);

  const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sport',
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    connectionLimit: 4,
  });
  const q = (sql, p = []) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  console.log(`Filtre : ${where}`);
  console.log(`Fiches mises à jour depuis ${minDateStr}\n`);

  const rejects = {};
  const seenRefs = new Set();          // pour --prune
  const seenDepartments = new Set();   // périmètre de la purge
  let read = 0, kept = 0, inserted = 0, updated = 0, skippedCurated = 0;
  let offset = 0, total = null;

  try {
    while (total === null || offset < total) {
      const page = await fetchPage(where, offset);
      if (total === null) {
        total = page.total_count;
        console.log(`${total} équipements en accès libre à examiner…\n`);
        if (total === 0) break;
      }
      // L'API Explore plafonne offset+limit à 10 000.
      if (offset + PAGE_SIZE > 10000) {
        console.warn('\n⚠️  Plafond API atteint (10 000). Relancer département par département.');
        break;
      }

      for (const r of page.results) {
        read++;
        if (r.dep_nom) seenDepartments.add(r.dep_nom);
        const reason = rejectReason(r, minDateStr);
        if (reason) { rejects[reason] = (rejects[reason] || 0) + 1; continue; }
        kept++;
        seenRefs.add(r.equip_numero);
        if (args.dry) continue;

        const row = toRow(r);
        const existing = await q(
          'SELECT id, verification_status FROM public_places WHERE external_ref = ?',
          [row.external_ref]
        );

        if (existing.length === 0) {
          await q(
            `INSERT INTO public_places
             (external_ref, name, equip_type, sports, address, postal_code, city, department,
              lat, lng, free_access, lighting, seasonal, accessible_pmr, data_updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.external_ref, row.name, row.equip_type, row.sports, row.address, row.postal_code,
              row.city, row.department, row.lat, row.lng, row.free_access, row.lighting,
              row.seasonal, row.accessible_pmr, row.data_updated_at]
          );
          inserted++;
        } else {
          // Le travail humain prime sur le réimport : on ne réécrit jamais un lieu
          // vérifié à la main, par la communauté, ou signalé invalide.
          const status = existing[0].verification_status;
          if (['manually_curated', 'community_verified', 'reported_invalid'].includes(status)) {
            skippedCurated++;
            continue;
          }
          await q(
            `UPDATE public_places SET name=?, equip_type=?, sports=?, address=?, postal_code=?,
               city=?, department=?, lat=?, lng=?, lighting=?, seasonal=?, accessible_pmr=?,
               data_updated_at=? WHERE id=?`,
            [row.name, row.equip_type, row.sports, row.address, row.postal_code, row.city,
              row.department, row.lat, row.lng, row.lighting, row.seasonal, row.accessible_pmr,
              row.data_updated_at, existing[0].id]
          );
          updated++;
        }
      }

      offset += PAGE_SIZE;
      if (offset % 1000 === 0) process.stdout.write(`  …${offset}/${total}\n`);
    }

    // Purge : supprime les lieux du périmètre importé qui ne ressortent plus de
    // l'API (équipement retiré, ou devenu non éligible après correction d'un
    // filtre). On ne touche jamais à un lieu vérifié par un humain, ni à un
    // lieu ajouté par un utilisateur.
    let pruned = 0;
    if (args.prune && !args.dry && seenRefs.size > 0 && seenDepartments.size > 0) {
      // Périmètre STRICT : uniquement les départements réellement parcourus.
      // Sans ça, importer l'Isère supprimerait les terrains de toutes les
      // autres régions déjà en base.
      const deps = [...seenDepartments];
      const placeholders = deps.map(() => '?').join(',');
      const candidates = await q(
        `SELECT id, external_ref FROM public_places
         WHERE source = 'data_es' AND verification_status = 'auto'
           AND department IN (${placeholders})`,
        deps
      );
      const stale = candidates.filter(c => !seenRefs.has(c.external_ref));
      for (const s of stale) {
        await q('DELETE FROM public_places WHERE id = ?', [s.id]);
        pruned++;
      }
    }

    console.log('\n── Résultat ──────────────────────────────');
    console.log(`Lus            : ${read}`);
    console.log(`Retenus        : ${kept}${args.dry ? '  (simulation)' : ''}`);
    if (!args.dry) {
      console.log(`  insérés      : ${inserted}`);
      console.log(`  mis à jour   : ${updated}`);
      console.log(`  curés (gardés intacts) : ${skippedCurated}`);
      if (args.prune) console.log(`  purgés (plus éligibles): ${pruned}`);
    }
    console.log(`Rejetés        : ${read - kept}`);
    Object.entries(rejects).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${k.padEnd(26)} ${v}`));
  } finally {
    db.end();
  }
})().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
