/**
 * Règle d'affichage des terrains publics — BK-PP-29 et 30.
 * Par défaut, seuls les terrains avec une preuve d'existence sortent ; les autres
 * sont comptés pour la rubrique « À confirmer (n) » et servis sur demande.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');

function makeApp(db) {
  const app = express();
  app.use('/api', publicPlacesRouter(db));
  app.use(errorHandler);
  return app;
}

test('BK-PP-29 recherche : vérifiés seulement + compteur « À confirmer » ; include_unverified ajoute les sans preuve', async () => {
  let db = fakeDb([
    [/SELECT COUNT\(\*\) AS n FROM \(/, () => [{ n: 4 }]],
    [/FROM public_places p/, () => []],
  ]);
  let { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/public-places?lat=45.2&lng=5.83&radius=5`);
    const body = await res.json();
    assert.equal(body.unverified_count, 4);
    const [search, count] = db.calls;
    assert.deepEqual(
      search.params.filter(p => typeof p === 'string'),
      ['manually_curated', 'community_verified', 'ign_confirmed', 'osm_confirmed'],
    );
    assert.match(count.sql, /p\.verification_status = 'auto' AND p\.osm_disused = 0/);
    assert.match(count.sql, /HAVING distance_km <= \?/);
  } finally { server.close(); }

  db = fakeDb([[/FROM public_places p/, () => []]]);
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await fetch(`${url}/api/public-places?lat=45.2&lng=5.83&include_unverified=1`);
    const body = await res.json();
    assert.equal(body.unverified_count, undefined, 'déjà inclus : pas de compteur');
    assert.equal(db.calls.length, 1);
    const { sql, params } = db.calls[0];
    assert.ok(params.includes('auto'));
    assert.ok(!params.includes('reported_invalid'));
    assert.match(sql, /NOT \(p\.verification_status = 'auto' AND p\.osm_disused = 1\)/, 'désaffecté dans OSM : jamais montré');
  } finally { server.close(); }
});

test('BK-PP-30 fiche d’un terrain disparu de Data ES : 404 ; terrain sans preuve : servi (lien direct)', async () => {
  const db = fakeDb([[/FROM public_places p\s+WHERE p\.id = \?/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/public-places/12`);
    assert.equal(res.status, 404);
    assert.match(db.calls[0].sql, /p\.source_missing_at IS NULL/);
    assert.doesNotMatch(db.calls[0].sql, /verification_status IN/, 'un terrain « À confirmer » garde sa fiche');
  } finally { server.close(); }
});
