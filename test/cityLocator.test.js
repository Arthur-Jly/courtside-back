/**
 * Centre d'une commune pour la recherche par ville seule — BK-PC-12 à 14.
 * Aucun appel réseau : geo.api.gouv.fr est simulé.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { createCityLocator, normalizeCity, radiusFromSurface } = require('../src/services/cityLocator');

const commune = (nom, lng, lat, surface = 1817) => ({ nom, centre: { type: 'Point', coordinates: [lng, lat] }, surface });

test('BK-PC-12 la commune doit porter le nom demandé (accents, casse et tirets ignorés)', async () => {
  const locator = createCityLocator({
    fetchCommune: async () => [commune('Saint-Martin-d’Hères', 5.76, 45.17), commune('Saint-Étienne', 4.39, 45.43, 7997)],
  });
  const found = await locator.locate('saint etienne');
  assert.deepEqual({ lat: found.lat, lng: found.lng }, { lat: 45.43, lng: 4.39 });
  assert.equal(normalizeCity('Saint-Étienne'), 'saint etienne');

  // Recherche floue : « Grenob » ne doit pas charger la zone de Grenoble.
  const fuzzy = createCityLocator({ fetchCommune: async () => [commune('Grenoble', 5.72, 45.18)] });
  assert.equal(await fuzzy.locate('Grenob'), null);
});

test('BK-PC-13 rayon tiré de la surface, borné à 3–15 km', () => {
  assert.equal(radiusFromSurface(1817), 3.6);     // Grenoble : 18 km²
  assert.equal(radiusFromSurface(10540), 8.7);    // Paris : 105 km²
  assert.equal(radiusFromSurface(50), 3);         // petite commune
  assert.equal(radiusFromSurface(500000), 15);    // Arles et consorts
  assert.equal(radiusFromSurface(undefined), 3);
});

test('BK-PC-14 cache (même les villes inconnues), un seul appel en vol ; une panne n’est pas mise en cache', async () => {
  let calls = 0;
  const locator = createCityLocator({
    fetchCommune: async (name) => { calls++; return name === 'Lyon' ? [commune('Lyon', 4.83, 45.76, 4787)] : []; },
  });
  const [a, b] = await Promise.all([locator.locate('Lyon'), locator.locate('lyon')]);
  assert.deepEqual(a, b);
  await locator.locate('LYON');
  assert.equal(calls, 1);

  assert.equal(await locator.locate('Atlantide'), null);
  assert.equal(await locator.locate('Atlantide'), null);
  assert.equal(calls, 2);

  let fail = true;
  const flaky = createCityLocator({
    fetchCommune: async () => { if (fail) throw new Error('timeout'); return [commune('Nantes', -1.55, 47.22)]; },
  });
  assert.equal(await flaky.locate('Nantes'), null);
  fail = false;
  assert.equal((await flaky.locate('Nantes')).lat, 47.22);
  assert.equal(await createCityLocator({ fetchCommune: async () => [] }).locate('  '), null);
});
