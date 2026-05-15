/**
 * Test du filtre qualité équipements data.gouv
 * Usage: node scripts/test-datagouv-filter.js
 */

const { isValidEquipement } = require('../src/services/datagouvApi');

// --- Cas de test unitaires ---

const TESTS = [
  // Vrais terrains → attendu: true
  { desc: 'Court de tennis', eq: { inst_nom: 'Stade municipal', equip_type_name: 'Court de tennis', equip_ouv_public_bool: 'true' }, expected: true },
  { desc: 'Terrain football', eq: { inst_nom: 'Complexe sportif Jean Moulin', equip_type_name: 'Terrain de football', equip_ouv_public_bool: 'true' }, expected: true },
  { desc: 'City stade', eq: { inst_nom: 'City stade quartier nord', equip_type_name: 'City Stade', equip_ouv_public_bool: 'true' }, expected: true },
  { desc: 'Gymnase', eq: { inst_nom: 'Gymnase Paul Bert', equip_type_name: 'Gymnase', equip_ouv_public_bool: 'true' }, expected: true },
  { desc: 'Terrain multisports', eq: { inst_nom: 'Espace sportif Bellevue', equip_type_name: 'Terrain multisports', equip_ouv_public_bool: 'true' }, expected: true },
  { desc: 'Padel', eq: { inst_nom: 'Club Padel 38', equip_type_name: 'Terrain de padel', equip_ouv_public_bool: 'true' }, expected: true },

  // Espaces vagues → attendu: false
  { desc: 'Terrain vague (type)', eq: { inst_nom: 'Espace nord', equip_type_name: 'Terrain vague', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Espace naturel', eq: { inst_nom: 'Forêt communale', equip_type_name: 'Espace naturel aménagé', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Piste cyclable', eq: { inst_nom: 'Voie verte', equip_type_name: 'Piste cyclable', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Terrain vague (nom)', eq: { inst_nom: 'Terrain vague rue des lilas', equip_type_name: 'Terrain de sport', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Pas de type', eq: { inst_nom: 'Installation quelconque', equip_type_name: '', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Pas de nom', eq: { inst_nom: '', equip_type_name: 'Court de tennis', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Fermé au public', eq: { inst_nom: 'Club privé', equip_type_name: 'Court de tennis', equip_ouv_public_bool: 'false' }, expected: false },
  { desc: 'Parcours de santé', eq: { inst_nom: 'Parc municipal', equip_type_name: 'Parcours de santé', equip_ouv_public_bool: 'true' }, expected: false },
  { desc: 'Aire de jeux', eq: { inst_nom: 'Square enfants', equip_type_name: 'Aire de jeux', equip_ouv_public_bool: 'true' }, expected: false },
];

// --- Runner ---

let passed = 0;
let failed = 0;

console.log('\n=== TEST FILTRE QUALITÉ DATA.GOUV ===\n');

TESTS.forEach(({ desc, eq, expected }) => {
  const result = isValidEquipement(eq);
  const ok = result === expected;
  const icon = ok ? '✓' : '✗';
  if (ok) passed++;
  else failed++;
  console.log(`${icon} ${desc}: attendu=${expected}, obtenu=${result}`);
});

console.log(`\n${passed}/${TESTS.length} tests passés${failed > 0 ? ` — ${failed} ÉCHECS` : ''}\n`);

// --- Test live API (optionnel, décommenter pour tester avec vraie API) ---

async function testLiveApi() {
  const { searchEquipements } = require('../src/services/datagouvApi');

  console.log('=== TEST API LIVE (Grenoble, tennis, 5km) ===\n');
  const results = await searchEquipements({
    lat: 45.1885,
    lon: 5.7245,
    sport: 'tennis',
    radius: 5,
    limit: 10,
  });

  console.log(`${results.length} résultats:\n`);
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.inst_nom} — ${r.equip_type_name} — ${r.new_name} (${r._distance_km}km)`);
  });
}

// testLiveApi().catch(console.error);
