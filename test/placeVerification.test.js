/**
 * Recoupement BD TOPO (IGN) — BK-PP-14 à 22.
 * Règle testée : un terrain n'est « confirmé » que si l'IGN voit, au même
 * endroit, un terrain en service compatible ; sinon il reste sans preuve. Aucun
 * appel réseau : le WFS est simulé.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const bdTopo = require('../src/services/bdTopo');
const { createPlaceVerification, HOURLY_BUDGET } = require('../src/services/placeVerification');
const { deriveStatus } = require('../src/services/placeStatus');
const { upsertPlaces } = require('../src/services/dataEs');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');

const LAT = 45.2044;
const LNG = 5.82728;
const M_LAT = 1 / 111320;                                   // 1 m en degrés de latitude
const M_LNG = 1 / (111320 * Math.cos((LAT * Math.PI) / 180)); // 1 m en degrés de longitude

/** Terrain IGN carré de `half` m de demi-côté, centré à (dy, dx) m du point Data ES. */
function igFeature({ dx = 0, dy = 0, half = 10, nature = 'Petit terrain multi-sports', detail = null, etat = 'En service', ref = 'TERRSPOR1' } = {}) {
  const cLat = LAT + dy * M_LAT;
  const cLng = LNG + dx * M_LNG;
  const ring = [
    [cLng - half * M_LNG, cLat - half * M_LAT], [cLng + half * M_LNG, cLat - half * M_LAT],
    [cLng + half * M_LNG, cLat + half * M_LAT], [cLng - half * M_LNG, cLat + half * M_LAT],
    [cLng - half * M_LNG, cLat - half * M_LAT],
  ];
  return bdTopo.normalize({
    properties: { cleabs: ref, nature, nature_detaillee: detail, etat_de_l_objet: etat, date_de_confirmation: '2024-04-25Z' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
}

const place = (over = {}) => ({
  id: 1, equip_type: 'Multisports/City-stades', lat: LAT, lng: LNG, source: 'data_es',
  verification_status: 'auto', ign_ref: null, osm_ref: null, osm_checked_at: null,
  original_lat: null, original_lng: null, ...over,
});

// ── Appariement ─────────────────────────────────────────────────────────────

test('BK-PP-14 nature compatible : tennis, natation, rugby, volley refusés ; basket seulement sur petit terrain', () => {
  assert.equal(bdTopo.compatible('Multisports/City-stades', 'Petit terrain multi-sports', 'City-stade'), true);
  assert.equal(bdTopo.compatible('Terrain de football', 'Grand terrain de sport', 'Terrain de football'), true);
  assert.equal(bdTopo.compatible('Multisports/City-stades', 'Terrain de tennis', null), false);
  assert.equal(bdTopo.compatible('Multisports/City-stades', 'Bassin de natation', null), false);
  assert.equal(bdTopo.compatible('Terrain de football', 'Grand terrain de sport', 'Terrain de rugby'), false);
  assert.equal(bdTopo.compatible('Multisports/City-stades', 'Petit terrain multi-sports', 'Terrain de volley-ball'), false);
  assert.equal(bdTopo.compatible('Terrain de basket-ball', 'Grand terrain de sport', null), false);
  assert.equal(bdTopo.compatible('Terrain de basket-ball', 'Petit terrain multi-sports', 'Terrain de basket-ball'), true);
});

test('BK-PP-15 distance : dedans ou ≤ 30 m confirmé, 30–60 m recalé, au-delà ou hors service refusé', () => {
  const inside = bdTopo.matchPlace(place(), [igFeature({ half: 20 })]);
  assert.equal(inside.inside, true);
  assert.equal(inside.distance, 0);
  assert.equal(inside.recenter, false);

  const near = bdTopo.matchPlace(place(), [igFeature({ dx: 25, half: 5 })]);
  assert.ok(near && !near.recenter, '25 m : confirmé sans déplacer le point');

  const offset = bdTopo.matchPlace(place(), [igFeature({ dy: 50, half: 10 })]);
  assert.ok(offset && offset.recenter, '50 m : confirmé et recalé (cas réel : point Data ES à l’adresse)');

  assert.equal(bdTopo.matchPlace(place(), [igFeature({ dy: 80, half: 10 })]), null, '80 m : autre terrain');
  assert.equal(bdTopo.matchPlace(place(), [igFeature({ half: 20, etat: 'En construction' })]), null);
  assert.equal(bdTopo.matchPlace(place(), [igFeature({ half: 20, nature: 'Terrain de tennis' })]), null);
});

test('BK-PP-16 deriveStatus : humain > IGN > OSM > rien ; ancien osm_confirmed gardé jusqu’au recoupement durci', () => {
  assert.equal(deriveStatus(place({ ign_ref: 'X' })), 'ign_confirmed');
  assert.equal(deriveStatus(place({ osm_ref: 'way/1' })), 'osm_confirmed');
  assert.equal(deriveStatus(place({ ign_ref: 'X', osm_ref: 'way/1' })), 'ign_confirmed');
  assert.equal(deriveStatus(place()), 'auto');
  assert.equal(deriveStatus(place({ verification_status: 'osm_confirmed' })), 'osm_confirmed');
  assert.equal(deriveStatus(place({ verification_status: 'osm_confirmed', osm_checked_at: new Date() })), 'auto');
  for (const s of ['manually_curated', 'community_verified', 'reported_invalid']) {
    assert.equal(deriveStatus(place({ verification_status: s })), s, `${s} n’est jamais réécrit`);
  }
});

// ── Service de vérification ─────────────────────────────────────────────────

function makeDb(pending) {
  return fakeDb([
    [/SELECT[\s\S]*FROM public_places[\s\S]*ign_checked_at IS NULL/, () => pending],
    [/UPDATE public_places SET ign_ref/, () => ({ affectedRows: 1 })],
  ]);
}
const updates = (db) => db.calls.filter(c => /UPDATE public_places SET ign_ref/.test(c.sql));

test('BK-PP-17 zone déjà vérifiée : aucun appel à l’IGN', async () => {
  const db = makeDb([]);
  let calls = 0;
  const v = createPlaceVerification(db, { fetchIgn: async () => { calls++; return []; } });
  assert.equal(await v.verifyArea(LAT, LNG, 15), 'checked');
  assert.equal(calls, 0);
});

test('BK-PP-18 un seul appel par zone ; confirmé IGN ou laissé sans preuve, résultat stocké', async () => {
  const db = makeDb([place({ id: 1 }), place({ id: 2, lat: LAT + 0.01 })]);
  const boxes = [];
  const v = createPlaceVerification(db, { fetchIgn: async (box) => { boxes.push(box); return [igFeature({ half: 20, ref: 'TERRSPOR42' })]; } });
  assert.equal(await v.verifyArea(LAT, LNG, 15), 'verified');
  assert.equal(boxes.length, 1, 'une requête WFS pour toute la zone');
  assert.ok(boxes[0].south < LAT && boxes[0].north > LAT + 0.01, 'la boîte couvre les terrains à vérifier');

  const [u1, u2] = updates(db);
  assert.match(u1.sql, /ign_checked_at = NOW\(\)/);
  assert.deepEqual(u1.params.slice(0, 4), ['TERRSPOR42', 'Petit terrain multi-sports', '2024-04-25', 'ign_confirmed']);
  assert.deepEqual(u2.params.slice(0, 4), [null, null, null, 'auto'], 'à 1 km : rien, reste sans preuve');
});

test('BK-PP-19 point recalé sur le terrain IGN (coords d’origine gardées) ; un lieu ajouté par un joueur ne bouge pas', async () => {
  const db = makeDb([place({ id: 1 }), place({ id: 2, source: 'user' })]);
  const v = createPlaceVerification(db, { fetchIgn: async () => [igFeature({ dy: 50, half: 10 })] });
  await v.verifyArea(LAT, LNG, 15);
  const [moved, kept] = updates(db);
  assert.match(moved.sql, /lat = \?, lng = \?, original_lat = \?, original_lng = \?/);
  assert.ok(Math.abs(moved.params[4] - (LAT + 50 * M_LAT)) < 1e-6, 'nouveau point = centre du terrain IGN');
  assert.equal(moved.params[6], LAT, 'latitude Data ES conservée');
  assert.doesNotMatch(kept.sql, /original_lat/);
});

test('BK-PP-20 IGN indisponible : ne lève pas, rien d’écrit (retenté ensuite) ; recherches simultanées : un appel ; budget horaire', async () => {
  const failing = makeDb([place()]);
  const v1 = createPlaceVerification(failing, { fetchIgn: async () => { throw new Error('timeout'); } });
  assert.equal(await v1.verifyArea(LAT, LNG), 'failed');
  assert.equal(updates(failing).length, 0);

  let calls = 0;
  const v2 = createPlaceVerification(makeDb([place()]), {
    fetchIgn: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return []; },
  });
  await Promise.all([v2.verifyArea(LAT, LNG), v2.verifyArea(LAT, LNG), v2.verifyArea(LAT, LNG)]);
  assert.equal(calls, 1);

  let t = 0;
  let budgetCalls = 0;
  const v3 = createPlaceVerification(makeDb([place()]), { fetchIgn: async () => { budgetCalls++; return []; }, now: () => t });
  for (let i = 0; i < HOURLY_BUDGET; i++) await v3.verifyArea(LAT + i * 0.5, LNG);
  assert.equal(await v3.verifyArea(LAT, LNG + 3), 'budget');
  t = 3600 * 1000 + 1;
  assert.equal(await v3.verifyArea(LAT, LNG + 3), 'verified');
  assert.equal(budgetCalls, HOURLY_BUDGET + 1);
});

// ── Réimport ────────────────────────────────────────────────────────────────

test('BK-PP-21 réimport : point recalé conservé ; si Data ES déplace l’équipement, on reprend son point et on revérifie', async () => {
  const row = { external_ref: 'A1', name: 'T', equip_type: 'Multisports/City-stades', sports: '["foot"]', address: 'a', postal_code: '38420', city: 'Domène', department: 'Isère', lat: LAT, lng: LNG, lighting: null, seasonal: null, accessible_pmr: null, data_updated_at: '2025-03-31' };
  const run = async (known) => {
    const db = fakeDb([
      [/SELECT id, external_ref/, () => [known]],
      [/UPDATE public_places/, () => ({ affectedRows: 1 })],
    ]);
    await upsertPlaces((sql, p) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r)))), [row]);
    return db.calls.find(c => /UPDATE public_places/.test(c.sql));
  };

  const same = await run({ id: 9, external_ref: 'A1', verification_status: 'ign_confirmed', lat: LAT + 0.0004, lng: LNG, original_lat: LAT, original_lng: LNG });
  assert.doesNotMatch(same.sql, /lat=\?/, 'point recalé gardé');

  const moved = await run({ id: 9, external_ref: 'A1', verification_status: 'ign_confirmed', lat: LAT + 0.0004, lng: LNG, original_lat: LAT - 0.01, original_lng: LNG });
  assert.match(moved.sql, /lat=\?, lng=\?, original_lat=NULL, original_lng=NULL, ign_checked_at=NULL, osm_checked_at=NULL/);
});

// ── Recherche ───────────────────────────────────────────────────────────────

test('BK-PP-22 GET /public-places?lat&lng : chargement de la zone PUIS recoupement IGN, avant de répondre', async () => {
  const order = [];
  const coverage = { ensure: async () => { order.push('ensure'); return 'covered'; } };
  const verification = { verifyArea: async (lat, lng, r) => { order.push(`verify:${lat}:${lng}:${r}`); return 'checked'; } };
  const db = fakeDb([[/FROM public_places p/, () => { order.push('sql'); return []; }]]);
  const app = express();
  app.use('/api', publicPlacesRouter(db, { coverage, verification }));
  app.use(errorHandler);
  const { server, url } = await listen(app);
  try {
    await fetch(`${url}/api/public-places?lat=45.2&lng=5.83&radius=10`);
    assert.deepEqual(order.slice(0, 3), ['ensure', 'verify:45.2:5.83:10', 'sql']);
  } finally { server.close(); }
});
