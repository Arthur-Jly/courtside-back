const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const announcementsRouter = require('../src/routes/announcements');
const AnnouncementsController = require('../src/controllers/announcements.controller');
const { errorHandler } = require('../src/middleware/errorHandler');

const TOKEN = jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', announcementsRouter(db));
  app.use(errorHandler);
  return app;
}

// ── BK-ANN-09 : gardes des routes ───────────────────────────────────────────
test('BK-ANN-09 POST /announcements sans auth -> 401 ; id non numérique -> 400', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    let res = await postJson(`${url}/api/announcements`, { sport_type: 'padel' });
    assert.equal(res.status, 401);

    res = await postJson(`${url}/api/announcements/abc/join`, {}, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-ANN-10 : session pleine -> 400 puis waitlist -> 201 ──────────────────
test('BK-ANN-10 join session pleine -> 400 ; waitlist alors possible -> 201', async () => {
  const db = fakeDb([
    [/SELECT id FROM annonce_participants WHERE annonce_id = \? AND user_id/, () => []],
    [/SELECT places_disponibles FROM announcements/, () => [{ places_disponibles: 0 }]],
    [/SELECT id, created_by, places_disponibles, status FROM announcements/,
      () => [{ id: 5, created_by: 42, places_disponibles: 0, status: 'active' }]],
    [/INSERT IGNORE INTO annonce_waitlist/, () => ({ affectedRows: 1 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/announcements/5/join`, {}, AUTH);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Plus de places/);

    res = await postJson(`${url}/api/announcements/5/waitlist`, {}, AUTH);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).waitlisted, true);
  } finally { server.close(); }
});

test('BK-ANN-10b waitlist refusée si des places restent ou si organisateur', async () => {
  const mk = (row) => fakeDb([[/SELECT id, created_by, places_disponibles, status FROM announcements/, () => [row]]]);
  // places dispo
  let { server, url } = await listen(makeApp(mk({ id: 5, created_by: 42, places_disponibles: 2, status: 'active' })));
  try {
    const res = await postJson(`${url}/api/announcements/5/waitlist`, {}, AUTH);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /places sont disponibles/);
  } finally { server.close(); }
  // organisateur (user 7)
  ({ server, url } = await listen(makeApp(mk({ id: 5, created_by: 7, places_disponibles: 0, status: 'active' }))));
  try {
    const res = await postJson(`${url}/api/announcements/5/waitlist`, {}, AUTH);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /organises/);
  } finally { server.close(); }
});

// ── BK-ANN-11 : join efface l'entrée waitlist ───────────────────────────────
test('BK-ANN-11 join réussi : purge waitlist du user + notif organisateur', async () => {
  const db = fakeDb([
    [/SELECT id FROM annonce_participants WHERE annonce_id = \? AND user_id/, () => []],
    [/SELECT places_disponibles FROM announcements/, () => [{ places_disponibles: 2 }]],
    [/INSERT INTO annonce_participants/, () => ({ insertId: 9 })],
    [/UPDATE announcements SET places_disponibles = places_disponibles - 1/, () => ({})],
    [/DELETE FROM annonce_waitlist/, () => ({})],
    [/SELECT created_by FROM announcements/, () => [{ created_by: 42 }]],
    [/INSERT INTO notifications/, () => ({ insertId: 1 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/announcements/5/join`, {}, AUTH);
    assert.equal(res.status, 200);
    // best-effort async : laisser la boucle d'événements vider les .catch()
    await new Promise(r => setTimeout(r, 20));
    assert.ok(db.calls.some(c => /DELETE FROM annonce_waitlist/.test(c.sql)), 'waitlist purgée');
    const notif = db.calls.find(c => /INSERT INTO notifications/.test(c.sql));
    assert.ok(notif, 'organisateur notifié');
    assert.equal(notif.params[0], 42);
    assert.ok(String(notif.params[1]).includes('session_join'));
  } finally { server.close(); }
});

// ── BK-ANN-12 : leave promeut le 1er en waitlist ────────────────────────────
test('BK-ANN-12 leave : place libérée, 1er waitlisté notifié et marqué', async () => {
  const db = fakeDb([
    [/SELECT id, role FROM annonce_participants|SELECT \* FROM annonce_participants WHERE annonce_id = \? AND user_id|SELECT id FROM annonce_participants WHERE annonce_id = \? AND user_id/,
      () => [{ id: 9, role: 'participant' }]],
    [/DELETE FROM annonce_participants/, () => ({ affectedRows: 1 })],
    [/UPDATE announcements SET places_disponibles = places_disponibles \+ 1/, () => ({})],
    [/SELECT user_id FROM annonce_waitlist WHERE annonce_id = \? AND notified_at IS NULL/,
      () => [{ user_id: 55 }]],
    [/UPDATE annonce_waitlist SET notified_at = NOW/, () => ({ affectedRows: 1 })],
    [/INSERT INTO notifications/, () => ({ insertId: 2 })],
    [/./, () => []],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/announcements/5/leave`, { method: 'DELETE', headers: AUTH });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(db.calls.some(c => /UPDATE annonce_waitlist SET notified_at/.test(c.sql)), 'waitlisté marqué');
    const notif = db.calls.find(c => /INSERT INTO notifications/.test(c.sql));
    assert.ok(notif && notif.params[0] === 55, 'waitlisté 55 notifié');
    assert.ok(String(notif.params[1]).includes('waitlist_spot'));
  } finally { server.close(); }
});

// ── BK-ANN-13 : expiration cron ─────────────────────────────────────────────
test('BK-ANN-13 expiration : annule sous le minimum, libère le slot, garde les autres', async () => {
  const db = fakeDb([
    [/SELECT a\.id, a\.sport_type, a\.places_total/, () => [
      { id: 1, participant_count: 1, min_participants: 2, slot_id: 10 },  // sous le min -> annulée
      { id: 2, participant_count: 3, min_participants: 2, slot_id: null }, // ok -> gardée
    ]],
    [/UPDATE announcements SET status = \?/, (params) => { assert.equal(params[0], 'cancelled'); return {}; }],
    [/UPDATE slots SET status = \?/, (params) => { assert.deepEqual(params, ['free', 10]); return {}; }],
  ]);
  const controller = new AnnouncementsController(db);
  const out = await controller.checkAndCancelExpiredAnnouncements();
  assert.equal(out.checked, 2);
  assert.deepEqual(out.cancelledIds, [1]);
  assert.deepEqual(out.keptIds, [2]);
  assert.ok(db.calls.some(c => /UPDATE slots SET status/.test(c.sql)), 'slot libéré');
});

test('BK-ANN-13b endpoint check-expired refuse sans CRON_TOKEN', async () => {
  process.env.CRON_TOKEN = 'cron-secret';
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    let res = await postJson(`${url}/api/announcements/check-expired`, {});
    assert.equal(res.status, 403);
    res = await fetch(`${url}/api/announcements/check-expired`, {
      method: 'POST', headers: { 'x-cron-token': 'wrong' },
    });
    assert.equal(res.status, 403);
  } finally { server.close(); delete process.env.CRON_TOKEN; }
});

// ── BK-ANN-14 : validation par le créateur seul ─────────────────────────────
test('BK-ANN-14 validate par un non-créateur -> 404 (annonce non trouvée pour lui)', async () => {
  const db = fakeDb([[/SELECT \* FROM announcements WHERE id = \? AND created_by/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/announcements/5/validate`, {}, AUTH);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /créateur|introuvable/);
  } finally { server.close(); }
});

test('BK-ANN-14b validate refuse une annonce déjà validée', async () => {
  const db = fakeDb([
    [/SELECT \* FROM announcements WHERE id = \? AND created_by/,
      () => [{ id: 5, status: 'validated', slot_id: 10 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/announcements/5/validate`, {}, AUTH);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /déjà été validée/);
  } finally { server.close(); }
});

// ── BK-ANN-15 : fair-play ratings ───────────────────────────────────────────
function ratingsDb({ sessionInFuture = false, isParticipant = true } = {}) {
  return fakeDb([
    [/SELECT id, created_by, manual_date, slot_start FROM announcements/,
      () => [{ id: 5, created_by: 42, manual_date: null, slot_start: sessionInFuture ? '2099-01-01 10:00:00' : '2020-01-01 10:00:00' }]],
    [/SELECT user_id FROM annonce_participants/,
      () => (isParticipant ? [{ user_id: 7 }, { user_id: 55 }] : [{ user_id: 55 }])],
    [/INSERT INTO player_ratings/, () => ({ affectedRows: 1 })],
  ]);
}

test('BK-ANN-15 ratings : bornes 1-5, jamais soi-même, upsert sur doublon', async () => {
  const db = ratingsDb();
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/announcements/5/rate-players`, {
      ratings: [
        { user_id: 55, rating: 5 },   // ok
        { user_id: 7, rating: 4 },    // soi-même -> ignoré
        { user_id: 55, rating: 9 },   // hors bornes -> ignoré
        { user_id: 999, rating: 3 },  // pas participant -> ignoré
      ],
    }, AUTH);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).saved, 1);
    const upsert = db.calls.find(c => /INSERT INTO player_ratings/.test(c.sql));
    assert.match(upsert.sql, /ON DUPLICATE KEY UPDATE/, 'note re-modifiable');
    assert.deepEqual(upsert.params, [5, 7, 55, 5]);
  } finally { server.close(); }
});

test('BK-ANN-15b ratings refusés : session future -> 400, non-participant -> 403', async () => {
  let { server, url } = await listen(makeApp(ratingsDb({ sessionInFuture: true })));
  try {
    const res = await postJson(`${url}/api/announcements/5/rate-players`,
      { ratings: [{ user_id: 55, rating: 5 }] }, AUTH);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /pas encore eu lieu/);
  } finally { server.close(); }

  ({ server, url } = await listen(makeApp(ratingsDb({ isParticipant: false }))));
  try {
    const res = await postJson(`${url}/api/announcements/5/rate-players`,
      { ratings: [{ user_id: 55, rating: 5 }] }, AUTH);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

// ── BK-ANN-16 : accepter une invitation décrémente les places ──────────────
test('BK-ANN-16 invitation accept : addParticipant + statut accepted', async () => {
  const db = fakeDb([
    [/SELECT \* FROM annonce_invitations WHERE id = \? AND user_id/,
      () => [{ id: 3, annonce_id: 5, user_id: 7, status: 'pending' }]],
    [/SELECT id FROM annonce_participants WHERE annonce_id = \? AND user_id/, () => []],
    [/SELECT places_disponibles FROM announcements/, () => [{ places_disponibles: 1 }]],
    [/INSERT INTO annonce_participants/, () => ({ insertId: 12 })],
    [/UPDATE announcements SET places_disponibles = places_disponibles - 1/, () => ({})],
    [/UPDATE annonce_invitations SET status/, (params) => { assert.equal(params[0], 'accepted'); return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/invitations/3/accept`, { method: 'PUT', headers: AUTH });
    assert.equal(res.status, 200);
    assert.ok(db.calls.some(c => /places_disponibles - 1/.test(c.sql)), 'place décomptée');
  } finally { server.close(); }
});

// ── BK-CHAT-02 : chat de session idempotent ────────────────────────────────
test('BK-CHAT-02 chat de session : 1er appel crée le groupe, 2e renvoie le même', async () => {
  let chatRow = null;
  const db = fakeDb([
    [/SELECT id, created_by, sport_type, manual_date FROM announcements/,
      () => [{ id: 5, created_by: 7, sport_type: 'padel', manual_date: null }]],
    [/SELECT user_id FROM annonce_participants/, () => [{ user_id: 55 }]],
    [/SELECT \* FROM chats WHERE announcement_id/, () => (chatRow ? [chatRow] : [])],
    [/INSERT INTO chats/, () => { chatRow = { id: 88, type: 'group', name: 'Match Padel', announcement_id: 5 }; return { insertId: 88 }; }],
    [/INSERT INTO chat_participants|INSERT IGNORE INTO chat_participants/, () => ({})],
    [/SELECT \* FROM chats WHERE id/, () => [chatRow]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/announcements/5/chat`, {}, AUTH);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).id, 88);

    res = await postJson(`${url}/api/announcements/5/chat`, {}, AUTH);
    assert.equal(res.status, 200, 'idempotent: pas de re-création');
    assert.equal((await res.json()).id, 88);
    assert.equal(db.calls.filter(c => /INSERT INTO chats\b/.test(c.sql)).length, 1, 'un seul chat créé');
  } finally { server.close(); }
});

test('BK-CHAT-02b chat de session réservé aux participants -> 403', async () => {
  const db = fakeDb([
    [/SELECT id, created_by, sport_type, manual_date FROM announcements/,
      () => [{ id: 5, created_by: 42, sport_type: 'padel', manual_date: null }]],
    [/SELECT user_id FROM annonce_participants/, () => [{ user_id: 55 }]], // user 7 absent
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/announcements/5/chat`, {}, AUTH);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});
