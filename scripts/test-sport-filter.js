/**
 * Diagnostic: vérifie les vraies valeurs aps_name et equip_type_name dans l'API
 * Usage: node scripts/test-sport-filter.js
 */

const axios = require('axios');

const BASE = 'https://equipements.sports.gouv.fr/api/explore/v2.1/catalog/datasets/data-es';

async function getFacetValues(facetName, limit = 20) {
  const url = `${BASE}/facets?facet_name=${facetName}&refine=dep_code:38&limit=${limit}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data.facets?.[0]?.facets?.map(f => f.name) || [];
}

async function testWithFilter(aps_name, equip_type_name) {
  const params = new URLSearchParams();
  params.append('refine', 'dep_code:38');
  params.append('refine', 'equip_acc_libre:true');
  if (aps_name) params.append('refine', `aps_name:${aps_name}`);
  if (equip_type_name) params.append('refine', `equip_type_name:${equip_type_name}`);
  params.append('limit', '5');
  params.append('select', 'inst_nom,equip_type_name,aps_name');

  const url = `${BASE}/records?${params.toString()}`;
  const res = await axios.get(url, { timeout: 10000 });
  return { total: res.data.total_count, results: res.data.results };
}

async function main() {
  console.log('\n=== DIAGNOSTIC FILTRE SPORT DATA.GOUV ===\n');

  console.log('1. Vraies valeurs aps_name (dep 38, basket):');
  const apsValues = await getFacetValues('aps_name', 100);
  const basketValues = apsValues.filter(v => v.toLowerCase().includes('basket'));
  console.log('   Valeurs contenant "basket":', basketValues.length ? basketValues : '(aucune)');
  console.log('   Valeurs contenant "pétanque":', apsValues.filter(v => v.toLowerCase().includes('p'+'étanque')));

  console.log('\n2. Vraies valeurs equip_type_name (dep 38):');
  const typeValues = await getFacetValues('equip_type_name', 50);
  const basketTypes = typeValues.filter(v => v.toLowerCase().includes('basket'));
  console.log('   Types basket:', basketTypes.length ? basketTypes : '(aucun)');

  console.log('\n3. Test filtre actuel (aps_name:"Basket-Ball" + equip_type_name:"Terrain de basket-ball"):');
  const r1 = await testWithFilter('Basket-Ball', 'Terrain de basket-ball');
  console.log(`   → ${r1.total} résultats`);
  if (r1.results.length) {
    r1.results.forEach(r => console.log(`   - ${r.inst_nom} | ${r.equip_type_name} | ${JSON.stringify(r.aps_name)}`));
  }

  console.log('\n4. Test avec seulement aps_name:');
  const apsExact = basketValues[0] || 'Basket-Ball';
  const r2 = await testWithFilter(apsExact, null);
  console.log(`   aps_name="${apsExact}" → ${r2.total} résultats`);

  console.log('\n5. Test SANS filtre sport (tout accès libre dep 38):');
  const r3 = await testWithFilter(null, null);
  console.log(`   → ${r3.total} résultats total`);
  if (r3.results.length) {
    r3.results.slice(0, 3).forEach(r => console.log(`   - ${r.inst_nom} | ${r.equip_type_name}`));
  }
}

main().catch(console.error);
