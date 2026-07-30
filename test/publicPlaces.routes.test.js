/**
 * Terrains publics (phase 1) — BK-PP-*.
 * La règle testée en priorité : un lieu signalé inexistant ne ressort jamais,
 * et un statut posé par un humain n'est pas écrasé par la communauté.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');

const TOKEN = jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', publicPlacesRouter(db));
  app.use(errorHandler);
  return app;
}

const PLACE_ROW = {
  id: 12,
  external_ref: 'I38185000123',
  name: 'City-stade Malherbe',
  equip_type: 'Multisports/City-stades',
  sports: '["foot","basket"]',
  address: '2 rue des Alpes',
  postal_code: '38100',
  city: 'Grenoble',
  department: 'Isère',
  lat: '45.170000',
  lng: '5.720000',
  free_access: 1,
  lighting: 1,
  seasonal: null,
  accessible_pmr: 0,
  source: 'data_es',
  verification_status: 'manually_curated',
  confirmations_count: 4,
  reports_count: 0,
  last_played_at: null,
  photo_url: null,
};

// ── BK-PP-01 : recherche ville + sport ──────────────────────────────────────
test('BK-PP-01 GET /public-places filtre ville/sport, exclut les lieux invalidés', async () => {
  const db = fakeDb([[/FROM public_places/, () => [PLACE_ROW]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/public-places?city=Grenoble&sport=foot`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    // sports JSON -> tableau exploitable côté front
    assert.deepEqual(body.places[0].sports, ['foot', 'basket']);
    assert.equal(body.places[0].lighting, true);

    const { sql, params } = db.calls[0];
    assert.match(sql, /verification_status <> 'reported_invalid'/);
    assert.match(sql, /LOWER\(p\.city\) = LOWER\(\?\)/);
    assert.match(sql, /JSON_CONTAINS\(p\.sports, \?\)/);
    assert.ok(params.includes('Grenoble'));
    assert.ok(params.includes('"foot"'));
  } finally { server.close(); }
});

// ── BK-PP-02 : recherche géo ────────────────────────────────────────────────
test('BK-PP-02 lat/lng -> distance haversine, rayon et tri par proximité', async () => {
  const db = fakeDb([[/FROM public_places/, () => [{ ...PLACE_ROW, distance_km: 1.234 }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/public-places?lat=45.18&lng=5.72&radius=5`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.places[0].distance_km, 1.2);

    const { sql, params } = db.calls[0];
    assert.match(sql, /AS distance_km/);
    assert.match(sql, /HAVING distance_km <= \?/);
    assert.match(sql, /ORDER BY distance_km ASC/);
    // boîte englobante avant haversine (usage de l'index lat/lng)
    assert.match(sql, /p\.lat BETWEEN \? AND \?/);
    assert.ok(params.includes(5));
  } finally { server.close(); }
});

test('BK-PP-02b lat sans lng -> 400', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await fetch(`${url}/api/public-places?lat=45.18`);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-PP-03 : détail ───────────────────────────────────────────────────────
test('BK-PP-03 GET /public-places/:id -> lieu + parties à venir ; inconnu -> 404', async () => {
  const db = fakeDb([
    [/FROM public_places p\s+WHERE p\.id/, () => [PLACE_ROW]],
    [/FROM announcements a/, () => [{ id: 3, sport_type: 'foot', places_disponibles: 2 }]],
  ]);
  let { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/public-places/12`);
    assert.equal(res.status, 200);
    const { place } = await res.json();
    assert.equal(place.name, 'City-stade Malherbe');
    assert.equal(place.upcoming.length, 1);
    // le détail exclut lui aussi les lieux invalidés
    assert.match(db.calls[0].sql, /verification_status <> 'reported_invalid'/);
  } finally { server.close(); }

  ({ server, url } = await listen(makeApp(fakeDb([[/FROM public_places/, () => []]]))));
  try {
    const res = await fetch(`${url}/api/public-places/999`);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

// ── BK-PP-04 : confirmations communautaires ─────────────────────────────────
test('BK-PP-04 3e confirmation -> community_verified ; curation humaine préservée', async () => {
  const mk = (status, count) => fakeDb([
    [/SELECT id, verification_status FROM public_places/, () => [{ id: 12, verification_status: status }]],
    [/INSERT IGNORE INTO place_confirmations/, () => ({ affectedRows: 1 })],
    [/COUNT\(\*\) AS count FROM place_confirmations/, () => [{ count }]],
    [/UPDATE public_places/, () => ({ affectedRows: 1 })],
    [/INSERT INTO analytics_events/, () => ({ insertId: 1 })],
  ]);

  const lastUpdate = (db) => db.calls.filter(c => /UPDATE public_places/.test(c.sql)).at(-1).sql;

  let db = mk('auto', 3);
  let { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, {}, AUTH);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).verification_status, 'community_verified');
    assert.match(lastUpdate(db), /verification_status = 'community_verified'/);
  } finally { server.close(); }

  // sous le seuil : aucun changement de statut
  db = mk('auto', 2);
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, {}, AUTH);
    assert.equal((await res.json()).verification_status, 'auto');
    assert.doesNotMatch(lastUpdate(db), /verification_status =/);
  } finally { server.close(); }

  // un lieu curé à la main garde son statut
  db = mk('manually_curated', 9);
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, {}, AUTH);
    assert.equal((await res.json()).verification_status, 'manually_curated');
  } finally { server.close(); }
});

// ── BK-PP-05 : signalements ─────────────────────────────────────────────────
test('BK-PP-05 3 signalements « inexistant » -> reported_invalid', async () => {
  const mk = (status, missing) => fakeDb([
    [/SELECT id, verification_status FROM public_places/, () => [{ id: 12, verification_status: status }]],
    [/INSERT INTO place_reports/, () => ({ affectedRows: 1 })],
    [/FROM place_reports WHERE place_id/, () => [{ total: missing, missing }]],
    [/UPDATE public_places/, () => ({ affectedRows: 1 })],
    [/INSERT INTO analytics_events/, () => ({ insertId: 1 })],
  ]);

  const lastUpdate = (db) => db.calls.filter(c => /UPDATE public_places/.test(c.sql)).at(-1).sql;

  let db = mk('auto', 3);
  let { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/public-places/12/report`, { kind: 'inexistant' }, AUTH);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).verification_status, 'reported_invalid');
  } finally { server.close(); }

  // la curation manuelle fait foi : elle n'est pas invalidée par la communauté
  db = mk('manually_curated', 5);
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/report`, { kind: 'inexistant' }, AUTH);
    assert.equal((await res.json()).verification_status, 'manually_curated');
  } finally { server.close(); }
});

test('BK-PP-05b motif de signalement invalide -> 400', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await postJson(`${url}/api/public-places/12/report`, { kind: 'nul' }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-PP-06 : gardes d'authentification ────────────────────────────────────
test('BK-PP-06 écritures sans auth -> 401 ; lecture ouverte -> 200', async () => {
  const db = fakeDb([[/FROM public_places/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    assert.equal((await postJson(`${url}/api/public-places/12/confirm`, {})).status, 401);
    assert.equal((await postJson(`${url}/api/public-places/12/report`, { kind: 'ferme' })).status, 401);
    assert.equal((await postJson(`${url}/api/public-places`, { name: 'X' })).status, 401);
    assert.equal((await fetch(`${url}/api/public-places?city=Lyon`)).status, 200);
  } finally { server.close(); }
});

// ── BK-PP-07 : ajout par un joueur ──────────────────────────────────────────
test('BK-PP-07 POST /public-places -> source user, statut auto', async () => {
  const db = fakeDb([
    [/INSERT INTO public_places/, () => ({ insertId: 55 })],
    [/FROM public_places p\s+WHERE p\.id/, () => [{ ...PLACE_ROW, id: 55, source: 'user', verification_status: 'auto' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/public-places`, {
      name: 'Terrain du parc',
      sports: ['foot'],
      city: 'Grenoble',
      lat: 45.19,
      lng: 5.73,
    }, AUTH);
    assert.equal(res.status, 201);
    const { place } = await res.json();
    assert.equal(place.source, 'user');
    assert.equal(place.verification_status, 'auto');
    assert.match(db.calls[0].sql, /'user', 'auto'/);
  } finally { server.close(); }
});

test('BK-PP-07b sport hors périmètre -> 400', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await postJson(`${url}/api/public-places`, {
      name: 'Court de padel', sports: ['padel'], city: 'Grenoble', lat: 45.1, lng: 5.7,
    }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});
