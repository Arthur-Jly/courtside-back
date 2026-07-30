const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const adminRouter = require('../src/routes/admin');
const { errorHandler } = require('../src/middleware/errorHandler');

function makeApp(db, cronService) {
  const app = express();
  app.use(express.json());
  app.use('/api', adminRouter(db, cronService));
  app.use(errorHandler);
  return app;
}

const ADMIN = { Authorization: `Bearer ${jwt.sign({ id: 1, role: 'admin', name: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
const PLAYER = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
const CLUB = { Authorization: `Bearer ${jwt.sign({ id: 20, role: 'club_admin', club_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };

// ── BK-ADM : garde d'accès super-admin ──────────────────────────────────────
test('BK-ADM-01 /admin/* refuse anonyme, player et club_admin', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    assert.equal((await fetch(`${url}/api/admin/stats`)).status, 401, 'anonyme');
    assert.equal((await fetch(`${url}/api/admin/stats`, { headers: PLAYER })).status, 401, 'player');
    assert.equal((await fetch(`${url}/api/admin/stats`, { headers: CLUB })).status, 401, 'club_admin');
  } finally { server.close(); }
});

test('BK-ADM-02 GET /admin/clubs?status filtre par statut', async () => {
  const db = fakeDb([
    [/FROM clubs c/, (params, sql) => {
      assert.match(sql, /WHERE c\.status = \?/, 'filtre statut appliqué');
      assert.equal(params[0], 'attente');
      return [{ id: 3, name: 'Club A', status: 'attente', terrains_count: 0 }];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs?status=attente`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.clubs[0].name, 'Club A');
  } finally { server.close(); }
});

test('BK-ADM-03 GET /admin/clubs rejette un statut invalide', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs?status=bogus`, { headers: ADMIN });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('BK-ADM-04 PUT /admin/clubs/:id/confirm passe le club en confirme + audit', async () => {
  let updateSql = null;
  const db = fakeDb([
    [/SELECT id, name, email, status FROM clubs/, () => [{ id: 5, name: 'Club B', email: 'g@club.fr', status: 'attente' }]],
    [/UPDATE club_invitations SET used_at = NOW\(\) WHERE club_id/, () => ({ affectedRows: 0 })],
    [/UPDATE clubs SET status = 'confirme'/, (params, sql) => { updateSql = sql; assert.equal(Number(params[0]), 1, 'reviewed_by = admin id'); return { affectedRows: 1 }; }],
    [/INSERT INTO club_invitations/, () => ({ insertId: 99 })],
    [/FROM clubs c WHERE c\.id/, () => [{ id: 5, name: 'Club B', status: 'confirme', terrains_count: 0, managers_count: 0 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs/5/confirm`, { method: 'PUT', headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.club.status, 'confirme');
    assert.equal(body.invitationSent, true, 'email envoyé (mode log en test)');
    assert.match(updateSql, /reviewed_by = \?, reviewed_at = NOW\(\)/);
  } finally { server.close(); }
});

test('BK-ADM-05 PUT confirm sur club inexistant -> 404', async () => {
  const db = fakeDb([[/SELECT id, name, email, status FROM clubs/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs/999/confirm`, { method: 'PUT', headers: ADMIN });
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('BK-ADM-06 PUT /admin/clubs/:id/reject enregistre la raison', async () => {
  let rejectParams = null;
  const db = fakeDb([
    [/SELECT id FROM clubs WHERE id/, () => [{ id: 6 }]],
    [/UPDATE clubs SET status = 'rejete'/, (params) => { rejectParams = params; return { affectedRows: 1 }; }],
    [/FROM clubs c WHERE c\.id/, () => [{ id: 6, status: 'rejete', reject_reason: 'Hors zone', terrains_count: 0, managers_count: 0 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs/6/reject`, {
      method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Hors zone' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.club.status, 'rejete');
    assert.equal(rejectParams[0], 1, 'reviewed_by = admin id');
    assert.equal(rejectParams[1], 'Hors zone', 'raison enregistrée');
  } finally { server.close(); }
});

test('BK-ADM-07 GET /admin/stats agrège les KPIs plateforme', async () => {
  const db = fakeDb([
    [/FROM users/, () => [{ total: 100, new_7d: 5, new_30d: 20, club_admins: 8, players: 92 }]],
    [/SUM\(status = 'attente'\)/, () => [{ attente: 3, confirme: 12, rejete: 1, total: 16 }]],
    // Revenu = SUM(price) FROM reservations (plus depuis payments)
    [/COALESCE\(SUM\(price\), 0\) AS total/, () => [{ total: 12500.5, last_7d: 800 }]],
    // Comptage réservations
    [/COUNT\(\*\) AS total,\s*SUM\(created_at/s, () => [{ total: 500, last_7d: 30 }]],
    [/FROM announcements/, () => [{ total: 40, open: 12 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/stats`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.users.total, 100);
    assert.equal(s.clubs.attente, 3);
    assert.equal(s.reservations.last_7d, 30);
    assert.equal(s.revenue.total, 12500.5);
    assert.equal(s.announcements.open, 12);
  } finally { server.close(); }
});

// ── P1 : utilisateurs ───────────────────────────────────────────────────────
test('BK-ADM-08 GET /admin/users paginé + recherche', async () => {
  const db = fakeDb([
    [/SELECT COUNT\(\*\) AS total FROM users/, (params, sql) => { assert.match(sql, /u\.name LIKE \? OR u\.email LIKE \?/); return [{ total: 3 }]; }],
    [/SELECT u\.id, u\.name.*FROM users u/s, (params) => {
      assert.equal(params[params.length - 2], 25, 'limit');
      assert.equal(params[params.length - 1], 0, 'offset');
      return [{ id: 1, name: 'Léa', email: 'lea@x.fr', role: 'player', club_id: null, reservations_count: 4 }];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/users?query=lea`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 3);
    assert.equal(body.users[0].name, 'Léa');
  } finally { server.close(); }
});

test('BK-ADM-09 GET /admin/users/:id renvoie détail + compteurs + fairplay', async () => {
  const db = fakeDb([
    [/SELECT u\.id, u\.name.*WHERE u\.id/s, () => [{ id: 5, name: 'Max', email: 'm@x.fr', role: 'player', club_id: null }]],
    [/FROM user_profiles WHERE user_id/, () => [{ bio: 'salut', city: 'Lyon', sports: null, is_public: 1 }]],
    [/SELECT\s+\(SELECT COUNT\(\*\) FROM reservations/s, () => [{ reservations: 7, announcements: 2, reviews: 1, friends: 3 }]],
    [/FROM player_ratings WHERE rated_user_id/, () => [{ avg: 4.5, count: 6 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/users/5`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.counts.reservations, 7);
    assert.equal(user.fairplay.avg, 4.5);
    assert.equal(user.profile.city, 'Lyon');
  } finally { server.close(); }
});

test('BK-ADM-10 PUT /admin/users/:id/role rejette rôle invalide, délie le club si non club_admin', async () => {
  let updateSql = null;
  const db = fakeDb([
    [/SELECT id FROM users WHERE id/, () => [{ id: 9 }]],
    [/UPDATE users SET role = \?, club_id = NULL/, (params, sql) => { updateSql = sql; assert.equal(params[0], 'admin'); return { affectedRows: 1 }; }],
    [/SELECT u\.id, u\.name.*WHERE u\.id/s, () => [{ id: 9, name: 'X', email: 'x@x.fr', role: 'admin', club_id: null }]],
    [/FROM user_profiles/, () => []],
    [/SELECT\s+\(SELECT COUNT/s, () => [{ reservations: 0, announcements: 0, reviews: 0, friends: 0 }]],
    [/FROM player_ratings/, () => [{ avg: null, count: 0 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/admin/users/9/role`, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'boss' }) });
    assert.equal(res.status, 400, 'rôle invalide');
    res = await fetch(`${url}/api/admin/users/9/role`, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
    assert.equal(res.status, 200);
    assert.ok(updateSql, 'club délié pour rôle non club_admin');
  } finally { server.close(); }
});

test('BK-ADM-11 DELETE /admin/users/:id refuse un compte admin', async () => {
  const db = fakeDb([[/SELECT id, role FROM users WHERE id/, () => [{ id: 2, role: 'admin' }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/users/2`, { method: 'DELETE', headers: ADMIN });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── P1 : réservations ───────────────────────────────────────────────────────
test('BK-ADM-12 GET /admin/reservations filtre statut + pagination', async () => {
  const db = fakeDb([
    [/SELECT COUNT\(\*\) AS total FROM reservations r JOIN terrains/, (params, sql) => { assert.match(sql, /r\.status = \?/); assert.equal(params[0], 'confirmed'); return [{ total: 8 }]; }],
    [/SELECT r\.id, r\.status.*FROM reservations r/s, () => [{ id: 1, status: 'confirmed', price: 20, club_name: 'C', user_name: 'U' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/reservations?status=confirmed`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 8);
    assert.equal(body.reservations[0].club_name, 'C');
  } finally { server.close(); }
});

// ── P1 : finances ───────────────────────────────────────────────────────────
test('BK-ADM-13 GET /admin/finances calcule revenu depuis reservations + commission 10%', async () => {
  const db = fakeDb([
    [/COALESCE\(SUM\(r\.price\), 0\) AS revenue, COUNT\(\*\) AS count\s+FROM reservations r\s+WHERE r\.status IN/s, (params, sql) => {
      assert.match(sql, /status IN \('confirmed', 'paid'\)/, 'depuis reservations, pas payments');
      return [{ revenue: 1000, count: 40 }];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/finances?period=month`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const f = await res.json();
    assert.equal(f.totalRevenue, 1000);
    assert.equal(f.commission, 100);
    assert.equal(f.netRevenue, 900);
    assert.equal(f.averageTransaction, 25);
  } finally { server.close(); }
});

test('BK-ADM-14 GET /admin/stats/timeseries remplit les jours vides à 0', async () => {
  const db = fakeDb([
    [/GROUP BY DATE\(created_at\)/, () => []], // aucune donnée
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/stats/timeseries?metric=reservations&days=7`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.series.length, 7, '7 jours');
    assert.ok(body.series.every(p => p.value === 0), 'tous à 0');
    assert.match(body.series[0].date, /^\d{4}-\d{2}-\d{2}$/);
  } finally { server.close(); }
});

// ── P2 : suspension de club ─────────────────────────────────────────────────
test('BK-ADM-16 PUT /admin/clubs/:id/suspend refuse un club non confirmé', async () => {
  const db = fakeDb([[/SELECT id, status FROM clubs WHERE id/, () => [{ id: 4, status: 'attente' }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs/4/suspend`, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /confirmé/);
  } finally { server.close(); }
});

test('BK-ADM-17 suspend passe le club en suspendu avec motif + audit', async () => {
  let params = null;
  const db = fakeDb([
    [/SELECT id, status FROM clubs WHERE id/, () => [{ id: 4, status: 'confirme' }]],
    [/UPDATE clubs SET status = 'suspendu'/, (p, sql) => { params = p; assert.match(sql, /reviewed_by = \?, reviewed_at = NOW\(\)/); return { affectedRows: 1 }; }],
    [/FROM clubs c WHERE c\.id/, () => [{ id: 4, name: 'C', status: 'suspendu', terrains_count: 0, managers_count: 0 }]],
    [/FROM terrains WHERE club_id/, () => []],
    [/FROM users WHERE club_id/, () => []],
    [/FROM reservations r JOIN terrains t ON r\.terrain_id = t\.id\s+WHERE t\.club_id = \? AND r\.status/s, () => [{ count: 0, revenue: 0 }]],
    [/FROM reviews WHERE club_id/, () => [{ count: 0, avg: null }]],
    [/MAX\(r\.created_at\)/, () => [{ last_reservation: null }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/clubs/4/suspend`, { method: 'PUT', headers: { ...ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Litige' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).club.status, 'suspendu');
    assert.equal(params[0], 1, 'reviewed_by = admin id');
    assert.equal(params[1], 'Litige', 'motif enregistré');
  } finally { server.close(); }
});

// ── P2 : modération sessions ────────────────────────────────────────────────
test('BK-ADM-18 GET /admin/announcements filtre par statut', async () => {
  const db = fakeDb([
    [/SELECT COUNT\(\*\) AS total FROM announcements/, (p, sql) => { assert.match(sql, /a\.status = \?/); assert.equal(p[0], 'active'); return [{ total: 5 }]; }],
    [/SELECT a\.id, a\.sport_type/s, () => [{ id: 3, sport_type: 'padel', status: 'active', creator_name: 'Léa', participants_count: 2 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/announcements?status=active`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.total, 5);
    assert.equal(b.announcements[0].creator_name, 'Léa');
  } finally { server.close(); }
});

test('BK-ADM-19 PUT /admin/announcements/:id/cancel annule et libère le créneau', async () => {
  let slotFreed = false;
  const db = fakeDb([
    [/SELECT id, status, slot_id FROM announcements/, () => [{ id: 3, status: 'active', slot_id: 77 }]],
    [/UPDATE announcements SET status = 'cancelled'/, () => ({ affectedRows: 1 })],
    [/UPDATE slots SET status = 'free'/, (p) => { slotFreed = Number(p[0]) === 77; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/announcements/3/cancel`, { method: 'PUT', headers: ADMIN });
    assert.equal(res.status, 200);
    assert.ok(slotFreed, 'créneau libéré');
  } finally { server.close(); }
});

test('BK-ADM-20 cancel sur session déjà annulée -> 400', async () => {
  const db = fakeDb([[/SELECT id, status, slot_id FROM announcements/, () => [{ id: 3, status: 'cancelled', slot_id: null }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/announcements/3/cancel`, { method: 'PUT', headers: ADMIN });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── P2 : modération avis ────────────────────────────────────────────────────
test('BK-ADM-21 GET /admin/reviews + DELETE /admin/reviews/:id', async () => {
  let deleted = false;
  const db = fakeDb([
    [/SELECT COUNT\(\*\) AS total FROM reviews/, () => [{ total: 12 }]],
    [/SELECT r\.id, r\.rating/s, () => [{ id: 8, rating: 1, comment: 'nul', user_name: 'Bob', club_name: 'C' }]],
    [/SELECT id FROM reviews WHERE id/, () => [{ id: 8 }]],
    [/DELETE FROM reviews WHERE id/, () => { deleted = true; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/admin/reviews`, { headers: ADMIN });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).total, 12);

    res = await fetch(`${url}/api/admin/reviews/8`, { method: 'DELETE', headers: ADMIN });
    assert.equal(res.status, 200);
    assert.ok(deleted, 'avis supprimé');
  } finally { server.close(); }
});

// ── P3 : activité (volumétrie only) ─────────────────────────────────────────
test('BK-ADM-22 GET /admin/activity/metrics : agrégats seulement, aucun contenu', async () => {
  const db = fakeDb([
    [/FROM chats/, () => [{ total: 10, private_chats: 7, group_chats: 2, session_chats: 1 }]],
    [/COUNT\(\*\) AS total,\s*SUM\(created_at.*FROM messages/s, () => [{ total: 100, last_7d: 12, last_30d: 40 }]],
    [/COUNT\(DISTINCT chat_id\)/, () => [{ active_7d: 4 }]],
    [/FROM notifications/, () => [{ total: 50, unread: 8 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/activity/metrics`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.chats.total, 10);
    assert.equal(m.chats.active_7d, 4);
    assert.equal(m.messages.avg_per_chat, 10);
    assert.equal(m.notifications.unread, 8);
    // Privacy : aucune requête ne doit lire le contenu des messages.
    const readsContent = db.calls.some(c => /SELECT[^;]*\bcontent\b/i.test(c.sql));
    assert.equal(readsContent, false, 'aucun contenu de message lu');
  } finally { server.close(); }
});

// ── P3 : cron ───────────────────────────────────────────────────────────────
test('BK-ADM-23 GET /admin/cron liste les tâches, run sur tâche inconnue -> 404', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  const fakeCron = {
    listJobs: () => [{ name: 'db-cleanup', schedule: '0 4 * * *', description: 'Purge' }],
    runJobManually: async () => ({ ok: true }),
  };
  const { server, url } = await listen(makeApp(db, fakeCron));
  try {
    let res = await fetch(`${url}/api/admin/cron`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.jobs[0].name, 'db-cleanup');

    res = await fetch(`${url}/api/admin/cron/bogus/run`, { method: 'POST', headers: ADMIN });
    assert.equal(res.status, 404, 'tâche inconnue refusée');
  } finally { server.close(); }
});

test('BK-ADM-24 POST /admin/cron/:name/run déclenche la tâche connue', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  let ranWith = null;
  const fakeCron = {
    listJobs: () => [{ name: 'db-cleanup', schedule: '0 4 * * *', description: 'Purge' }],
    runJobManually: async (n) => { ranWith = n; return { deleted: 3 }; },
  };
  const { server, url } = await listen(makeApp(db, fakeCron));
  try {
    const res = await fetch(`${url}/api/admin/cron/db-cleanup/run`, { method: 'POST', headers: ADMIN });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.ran, true);
    assert.equal(ranWith, 'db-cleanup');
    assert.deepEqual(b.result, { deleted: 3 });
  } finally { server.close(); }
});

test('BK-ADM-25 /admin/activity et /admin/cron refusent un non-admin', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  const { server, url } = await listen(makeApp(db, { listJobs: () => [], runJobManually: async () => {} }));
  try {
    assert.equal((await fetch(`${url}/api/admin/activity/metrics`, { headers: PLAYER })).status, 401);
    assert.equal((await fetch(`${url}/api/admin/cron`, { headers: CLUB })).status, 401);
    assert.equal((await fetch(`${url}/api/admin/cron/db-cleanup/run`, { method: 'POST' })).status, 401);
  } finally { server.close(); }
});

test('BK-ADM-15 /admin/users et /admin/finances refusent un non-admin', async () => {
  const db = fakeDb([[/.*/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    assert.equal((await fetch(`${url}/api/admin/users`, { headers: PLAYER })).status, 401);
    assert.equal((await fetch(`${url}/api/admin/finances`, { headers: CLUB })).status, 401);
    assert.equal((await fetch(`${url}/api/admin/reservations`)).status, 401);
  } finally { server.close(); }
});
