const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const usersRouter = require('../src/routes/users');
const notificationsRouter = require('../src/routes/notifications');
const newsletterRouter = require('../src/routes/newsletter');
const { errorHandler } = require('../src/middleware/errorHandler');

const TOKEN = jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', usersRouter(db));
  app.use('/api', notificationsRouter(db));
  app.use('/api', newsletterRouter(db));
  app.use(errorHandler);
  return app;
}

// ── BK-SOC-01 : demandes d'ami ──────────────────────────────────────────────
test('BK-SOC-01 friend-request : pending + notif ; doublon (même inversé) -> 400', async () => {
  let relation = null;
  const db = fakeDb([
    [/SELECT \* FROM amis/, () => (relation ? [relation] : [])],
    [/INSERT INTO amis/, () => { relation = { id: 3, user_id_1: 7, user_id_2: 55, status: 'pending' }; return { insertId: 3 }; }],
    [/INSERT INTO notifications/, () => ({ insertId: 1 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/friend-request`, { to_user_id: 55 }, AUTH);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'pending');
    await new Promise(r => setTimeout(r, 10));
    const notif = db.calls.find(c => /INSERT INTO notifications/.test(c.sql));
    assert.ok(notif && notif.params[0] === 55, 'destinataire notifié');

    // relation existe (peu importe le sens) -> refus
    res = await postJson(`${url}/api/friend-request`, { to_user_id: 55 }, AUTH);
    assert.equal(res.status, 400);

    // soi-même -> refus
    res = await postJson(`${url}/api/friend-request`, { to_user_id: 7 }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-SOC-02 : accept/refus ────────────────────────────────────────────────
test('BK-SOC-02 accept : seul le destinataire peut répondre, expéditeur notifié', async () => {
  const db = fakeDb([
    // UPDATE ... AND user_id_2 = 7 -> 1 ligne si le user est bien destinataire
    [/UPDATE amis SET status/, (params) => ({ affectedRows: params[2] === 7 ? 1 : 0 })],
    [/SELECT user_id_1 FROM amis WHERE id/, () => [{ user_id_1: 55 }]],
    [/INSERT INTO notifications/, () => ({ insertId: 2 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/friend-request/3`, {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 10));
    const notif = db.calls.find(c => /INSERT INTO notifications/.test(c.sql));
    assert.ok(notif && notif.params[0] === 55, 'expéditeur (55) notifié de l\'acceptation');
    assert.ok(String(notif.params[1]).includes('friend_accept'));
  } finally { server.close(); }
});

test('BK-SOC-02b répondre à une demande qui ne m\'est pas adressée -> 404 ; statut invalide -> 400', async () => {
  const db = fakeDb([[/UPDATE amis SET status/, () => ({ affectedRows: 0 })]]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/friend-request/3`, {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'accepted' }),
    });
    assert.equal(res.status, 404);
    res = await fetch(`${url}/api/friend-request/3`, {
      method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'blocked' }),
    });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-SOC-03 : suppression d'ami dans les deux sens ────────────────────────
test('BK-SOC-03 delete friend : supprime la relation quel que soit le sens', async () => {
  let deleteParams = null;
  const db = fakeDb([
    [/DELETE FROM amis\s+WHERE \(user_id_1/, (params) => { deleteParams = params; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/friends/7/55`, { method: 'DELETE', headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(deleteParams, [7, 55, 55, 7], 'les deux sens couverts');
  } finally { server.close(); }
});

test('BK-SOC-03b delete friend d\'une relation étrangère -> 403', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await fetch(`${url}/api/friends/55/56`, { method: 'DELETE', headers: AUTH });
    assert.equal(res.status, 403, 'user 7 ne peut pas toucher la relation 55-56');
  } finally { server.close(); }
});

// ── BK-SOC-04 : favoris idempotents ────────────────────────────────────────
test('BK-SOC-04 favoris : INSERT IGNORE (idempotent), delete scopé au user', async () => {
  const db = fakeDb([
    [/INSERT IGNORE INTO favorites/, () => ({ affectedRows: 1 })],
    [/DELETE FROM favorites WHERE user_id = \? AND terrain_id/, (params) => {
      assert.deepEqual(params, [7, 2]); return { affectedRows: 1 };
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/favorites`, { terrain_id: 2 }, AUTH);
    assert.equal(res.status, 200);
    const ins = db.calls.find(c => /INSERT/.test(c.sql));
    assert.match(ins.sql, /INSERT IGNORE/, 'double ajout sans erreur');

    res = await fetch(`${url}/api/favorites`, {
      method: 'DELETE', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ terrain_id: 2 }),
    });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

// ── BK-SOC-05 : notifications scopées ───────────────────────────────────────
test('BK-SOC-05 notifications : liste/summary/read scopés au user authentifié', async () => {
  const db = fakeDb([
    [/SELECT id, type, payload, read_at, created_at/, (params) => {
      assert.deepEqual(params, [7]); return [{ id: 1, type: 'invitation', payload: '{"a":1}', read_at: null, created_at: '2026-01-01' }];
    }],
    [/SELECT COUNT\(\*\) AS n FROM notifications/, (params) => { assert.equal(params[0], 7); return [{ n: 2 }]; }],
    [/SELECT COUNT\(\*\) AS n\s+FROM messages/, () => [{ n: 3 }]],
    [/UPDATE notifications SET read_at = NOW\(\) WHERE id = \? AND user_id = \?/, (params) => {
      assert.deepEqual(params, [1, 7]); return { affectedRows: 1 };
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/notifications`, { headers: AUTH });
    const list = await res.json();
    assert.deepEqual(list[0].payload, { a: 1 }, 'payload JSON parsé');

    res = await fetch(`${url}/api/notifications/summary`, { headers: AUTH });
    assert.deepEqual(await res.json(), { unread_notifications: 2, unread_messages: 3 });

    res = await fetch(`${url}/api/notifications/1/read`, { method: 'PUT', headers: AUTH });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

// ── BK-SOC-06 : newsletter ──────────────────────────────────────────────────
test('BK-SOC-06 newsletter : email normalisé + INSERT IGNORE ; invalide -> 400', async () => {
  let inserted = null;
  const db = fakeDb([[/INSERT IGNORE INTO newsletter_subscribers/, (params) => { inserted = params; return {}; }]]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/newsletter/subscribe`, { email: '  LEA@Example.COM ' });
    assert.equal(res.status, 201);
    assert.equal(inserted[0], 'lea@example.com', 'trim + lowercase');

    res = await postJson(`${url}/api/newsletter/subscribe`, { email: 'pas-un-email' });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});
