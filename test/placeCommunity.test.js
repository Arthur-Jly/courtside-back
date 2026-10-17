/**
 * Validation communautaire — BK-PP-31 à 34.
 * Une confirmation ne vaut que d'un joueur qui y a joué ou qui y est ; un
 * signalement pèse d'autant plus que le terrain est mal prouvé ; on demande
 * après chaque partie si le terrain existait ; les confirmations expirent.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret!';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const publicPlacesRouter = require('../src/routes/publicPlaces');
const { errorHandler } = require('../src/middleware/errorHandler');
const { reportThreshold, askPlaceChecks, expireCommunityVerified, CONFIRM_RADIUS_M } = require('../src/services/placeCommunity');

const AUTH = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player' }, process.env.JWT_SECRET)}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', publicPlacesRouter(db));
  app.use(errorHandler);
  return app;
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(body) });

const PLACE = { id: 12, lat: 45.2, lng: 5.83, verification_status: 'auto' };
function confirmDb({ played = false } = {}) {
  return fakeDb([
    [/SELECT id, lat, lng, verification_status FROM public_places/, () => [PLACE]],
    [/FROM annonce_participants ap/, () => (played ? [{ ok: 1 }] : [])],
    [/INSERT IGNORE INTO place_confirmations/, () => ({ affectedRows: 1 })],
    [/COUNT\(\*\) AS count FROM place_confirmations/, () => [{ count: 1 }]],
    [/UPDATE public_places/, () => ({ affectedRows: 1 })],
    [/INSERT INTO analytics_events/, () => ({ insertId: 1 })],
  ]);
}
const inserted = (db) => db.calls.some(c => /INSERT IGNORE INTO place_confirmations/.test(c.sql));

test('BK-PP-31 « J’ai joué ici » : ni sur place ni participant → 403 ; sur place ou participant → compté', async () => {
  let db = confirmDb();
  let { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, {});
    assert.equal(res.status, 403);
    assert.equal(inserted(db), false);
  } finally { server.close(); }

  // À ~1 km : trop loin pour compter comme « sur place »
  db = confirmDb();
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, { lat: 45.209, lng: 5.83 });
    assert.equal(res.status, 403);
  } finally { server.close(); }

  // À ~100 m : sur place, pas besoin d'avoir joué
  db = confirmDb();
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, { lat: 45.2009, lng: 5.83 });
    assert.equal(res.status, 200);
    assert.ok(inserted(db));
    assert.ok(!db.calls.some(c => /annonce_participants/.test(c.sql)), 'position suffisante : pas de requête participation');
    const count = db.calls.find(c => /COUNT\(\*\) AS count FROM place_confirmations/.test(c.sql));
    assert.match(count.sql, /created_at > DATE_SUB\(NOW\(\), INTERVAL \? MONTH\)/, 'seules les confirmations récentes comptent');
  } finally { server.close(); }

  // Participant à une partie passée sur ce terrain
  db = confirmDb({ played: true });
  ({ server, url } = await listen(makeApp(db)));
  try {
    const res = await postJson(`${url}/api/public-places/12/confirm`, {});
    assert.equal(res.status, 200);
    assert.ok(inserted(db));
  } finally { server.close(); }

  assert.equal(CONFIRM_RADIUS_M, 300);
});

test('BK-PP-32 seuil de signalement selon le statut : 1 sans preuve, 2 recoupé, 3 communauté, jamais pour une curation', async () => {
  assert.equal(reportThreshold('auto'), 1);
  assert.equal(reportThreshold('ign_confirmed'), 2);
  assert.equal(reportThreshold('osm_confirmed'), 2);
  assert.equal(reportThreshold('community_verified'), 3);
  assert.equal(reportThreshold('manually_curated'), Infinity);

  const run = async (status, missing) => {
    const db = fakeDb([
      [/SELECT id, verification_status FROM public_places/, () => [{ id: 12, verification_status: status }]],
      [/INSERT INTO place_reports/, () => ({ affectedRows: 1 })],
      [/FROM place_reports/, () => [{ total: missing, missing }]],
      [/UPDATE public_places/, () => ({ affectedRows: 1 })],
      [/INSERT INTO analytics_events/, () => ({ insertId: 1 })],
    ]);
    const { server, url } = await listen(makeApp(db));
    try {
      const res = await postJson(`${url}/api/public-places/12/report`, { kind: 'inexistant' });
      return (await res.json()).verification_status;
    } finally { server.close(); }
  };
  assert.equal(await run('auto', 1), 'reported_invalid');
  assert.equal(await run('ign_confirmed', 1), 'ign_confirmed');
  assert.equal(await run('ign_confirmed', 2), 'reported_invalid');
  assert.equal(await run('community_verified', 2), 'community_verified');
  assert.equal(await run('community_verified', 3), 'reported_invalid');
  assert.equal(await run('manually_curated', 50), 'manually_curated');
});

test('BK-PP-33 après une partie : « le terrain existait ? » à chaque participant, une seule fois', async () => {
  const db = fakeDb([
    [/FROM announcements a\s+JOIN public_places p/, () => [{ id: 42, public_place_ref: 12, place_name: 'City-stade' }]],
    [/FROM annonce_participants WHERE annonce_id/, () => [{ user_id: 7 }, { user_id: 8 }]],
    [/UPDATE announcements SET place_check_sent_at/, () => ({ affectedRows: 1 })],
  ]);
  const sent = [];
  const res = await askPlaceChecks(db, { notifyFn: (_db, uid, type, payload) => sent.push([uid, type, payload.place_id]) });
  assert.equal(res.asked, 2);
  assert.deepEqual(sent, [[7, 'place_check', 12], [8, 'place_check', 12]]);
  const select = db.calls[0].sql;
  assert.match(select, /place_check_sent_at IS NULL/);
  assert.match(select, /slot_end <= NOW\(\)/);
  assert.match(select, /NOT IN \('manually_curated', 'reported_invalid'\)/);
  assert.ok(db.calls.some(c => /UPDATE announcements SET place_check_sent_at = NOW\(\)/.test(c.sql)));

  // requête en échec : ne lève pas
  const broken = fakeDb([]);
  assert.deepEqual(await askPlaceChecks(broken, { notifyFn: () => {} }), { asked: 0 });
});

test('BK-PP-34 expiration : community_verified sans activité depuis 18 mois retombe sur ses preuves', async () => {
  const db = fakeDb([[/UPDATE public_places/, () => ({ affectedRows: 2 })]]);
  assert.deepEqual(await expireCommunityVerified(db), { expired: 2 });
  const { sql, params } = db.calls[0];
  assert.match(sql, /WHEN ign_ref IS NOT NULL THEN 'ign_confirmed'/);
  assert.match(sql, /WHEN osm_ref IS NOT NULL THEN 'osm_confirmed'/);
  assert.match(sql, /ELSE 'auto'/);
  assert.match(sql, /verification_status = 'community_verified'/);
  assert.deepEqual(params, [18]);
});
