/**
 * Recoupement OSM durci + file d'attente — BK-PP-23 à 28.
 * Chaque règle répond à un faux positif réel de l'ancien recoupement : complexe
 * sportif à 58 m d'un parking, chantier « confirmé », plateau scolaire privé.
 * Aucun appel réseau : Overpass est simulé.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const osmCheck = require('../src/services/osmCheck');
const { createOsmQueue, HOURLY_BUDGET } = require('../src/services/osmQueue');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');

const LAT = 45.2;
const LNG = 5.83;
const M = 1 / 111320; // 1 m en degrés de latitude

const place = (over = {}) => ({
  id: 1, lat: LAT, lng: LNG, sports: '["foot"]', verification_status: 'auto',
  ign_ref: null, osm_ref: null, osm_checked_at: null, ...over,
});
/** Terrain OSM (way) centré à `dy` m au nord, avec ses tags. */
const pitch = (tags, { dy = 0, id = 1, half = 10 } = {}) => osmCheck.normalize({
  type: 'way', id, tags,
  bounds: { minlat: LAT + (dy - half) * M, maxlat: LAT + (dy + half) * M, minlon: LNG - 0.0001, maxlon: LNG + 0.0001 },
});

test('BK-PP-23 la requête ne demande que des terrains (et les désaffectés) — plus de sports_centre', () => {
  const qs = osmCheck.buildQuery({ south: 45, west: 5, north: 46, east: 6 });
  assert.match(qs, /"leisure"="pitch"/);
  assert.match(qs, /"disused:leisure"="pitch"/);
  assert.match(qs, /"abandoned:leisure"="pitch"/);
  assert.doesNotMatch(qs, /sports_centre/);
  assert.match(qs, /out tags bb;/, 'emprise demandée pour tester « dans le terrain »');
});

test('BK-PP-24 sport compatible exigé ; accès privé / clients refusé ; > 30 m refusé', () => {
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'soccer' })]).ref, 'way/1');
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'multi' })]).ref, 'way/1');
  assert.equal(osmCheck.matchPlace(place({ sports: '["basket"]' }), [pitch({ leisure: 'pitch', sport: 'soccer' })]).ref, null);
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'tennis' })]).ref, null);
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch' })]).ref, null, 'pas de sport : pas de preuve');
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'soccer', access: 'private' })]).ref, null);
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'soccer', access: 'customers' })]).ref, null);
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'soccer' }, { dy: 60, half: 5 })]).ref, null);
  assert.equal(osmCheck.matchPlace(place(), [pitch({ leisure: 'pitch', sport: 'soccer' }, { dy: 20, half: 5 })]).ref, 'way/1');
});

test('BK-PP-25 terrain désaffecté au même endroit : signal négatif, pas de confirmation', () => {
  const res = osmCheck.matchPlace(place(), [pitch({ 'disused:leisure': 'pitch', sport: 'soccer' })]);
  assert.deepEqual(res, { ref: null, disused: true });
  // un terrain actif à côté l'emporte
  const both = osmCheck.matchPlace(place(), [
    pitch({ 'disused:leisure': 'pitch' }, { id: 1 }),
    pitch({ leisure: 'pitch', sport: 'soccer' }, { id: 2 }),
  ]);
  assert.deepEqual(both, { ref: 'way/2', disused: false });
});

test('BK-PP-26 statut après recoupement : ancien osm_confirmed sans terrain → auto ; preuve IGN gardée', async () => {
  const db = fakeDb([[/UPDATE public_places SET osm_ref/, () => ({ affectedRows: 1 })]]);
  const q = (sql, p) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  await osmCheck.apply(q, [
    place({ id: 1, verification_status: 'osm_confirmed' }),
    place({ id: 2, verification_status: 'ign_confirmed', ign_ref: 'TERRSPOR1' }),
    place({ id: 3 }),
  ], [pitch({ leisure: 'pitch', sport: 'soccer' }, { dy: 500 })]);
  const statuses = db.calls.map(c => [c.params[3], c.params[2]]);
  assert.deepEqual(statuses, [[1, 'auto'], [2, 'ign_confirmed'], [3, 'auto']]);
});

test('BK-PP-27 Overpass 504 : on recule et on réessaie ; au-delà du nombre d’essais, on lève', async () => {
  let n = 0;
  const waits = [];
  const fetchImpl = async () => {
    n++;
    if (n < 3) return { ok: false, status: 504, headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ elements: [{ type: 'way', id: 7, tags: { leisure: 'pitch', sport: 'soccer' }, bounds: { minlat: 1, maxlat: 2, minlon: 1, maxlon: 2 } }] }) };
  };
  const els = await osmCheck.fetchPitches({ south: 1, west: 1, north: 2, east: 2 }, { fetchImpl, wait: async (ms) => waits.push(ms) });
  assert.equal(els.length, 1);
  assert.equal(waits.length, 2);

  await assert.rejects(
    osmCheck.fetchPitches({ south: 1, west: 1, north: 2, east: 2 }, {
      fetchImpl: async () => ({ ok: false, status: 504, headers: { get: () => null } }), retries: 1, wait: async () => {},
    }),
    /Overpass 504/,
  );
});

test('BK-PP-28 file OSM : zones dédoublonnées, une à la fois, erreurs avalées, budget ; la recherche n’attend pas', async () => {
  const pending = [place()];
  const db = fakeDb([
    [/SELECT[\s\S]*osm_checked_at IS NULL/, () => pending],
    [/UPDATE public_places SET osm_ref/, () => ({ affectedRows: 1 })],
  ]);
  let calls = 0;
  const queue = createOsmQueue(db, { pauseMs: 0, fetchOsm: async () => { calls++; return []; } });
  assert.equal(queue.enqueueArea(LAT, LNG, 15), true);
  assert.equal(queue.enqueueArea(LAT, LNG, 15), false, 'même zone déjà en file');
  await queue.drain();
  assert.equal(calls, 1);

  const failing = createOsmQueue(db, { pauseMs: 0, fetchOsm: async () => { throw new Error('Overpass 504'); } });
  failing.enqueueArea(LAT, LNG, 15);
  await failing.drain(); // ne lève pas

  let t = 0;
  let budgetCalls = 0;
  const limited = createOsmQueue(db, { pauseMs: 0, now: () => t, fetchOsm: async () => { budgetCalls++; return []; } });
  for (let i = 0; i < HOURLY_BUDGET + 5; i++) limited.enqueueArea(LAT + i, LNG, 15);
  await limited.drain();
  assert.equal(budgetCalls, HOURLY_BUDGET);

  // Route : la recherche dépose la zone sans attendre Overpass.
  let enqueued = null;
  const osmQueue = { enqueueArea: (lat, lng, r) => { enqueued = [lat, lng, r]; return true; } };
  const searchDb = fakeDb([[/FROM public_places p/, () => []]]);
  const app = express();
  app.use('/api', publicPlacesRouter(searchDb, { osmQueue }));
  app.use(errorHandler);
  const { server, url } = await listen(app);
  try {
    const res = await fetch(`${url}/api/public-places?lat=45.2&lng=5.83&radius=10`);
    assert.equal(res.status, 200);
    assert.deepEqual(enqueued, [45.2, 5.83, 10]);
  } finally { server.close(); }
});
