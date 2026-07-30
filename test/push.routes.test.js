/**
 * Web Push — BK-PUSH-*.
 * Sans clés VAPID le module doit rester inerte : l'app tourne, le push est
 * simplement désactivé. Aucune route ne doit tomber pour autant.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const pushRouter = require('../src/routes/push');
const push = require('../src/utils/push');
const { errorHandler } = require('../src/middleware/errorHandler');

const AUTH = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', pushRouter(db));
  app.use(errorHandler);
  return app;
}

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BPk-key', auth: 'auth-secret' },
};

// ── BK-PUSH-01 : clé publique ───────────────────────────────────────────────
test('BK-PUSH-01 GET /push/public-key annonce l\'état réel du service', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const body = await (await fetch(`${url}/api/push/public-key`)).json();
    assert.equal(body.enabled, push.isEnabled());
    // sans clés VAPID configurées : pas de clé exposée, mais pas d'erreur
    if (!push.isEnabled()) assert.equal(body.publicKey, null);
  } finally { server.close(); }
});

// ── BK-PUSH-02 : abonnement ─────────────────────────────────────────────────
test('BK-PUSH-02 subscribe : upsert par endpoint, réattribue à l\'utilisateur courant', async () => {
  const db = fakeDb([[/INSERT INTO push_subscriptions/, () => ({ affectedRows: 1 })]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/push/subscribe`, SUB, AUTH);
    assert.equal(res.status, 201);
    const { sql, params } = db.calls[0];
    assert.match(sql, /ON DUPLICATE KEY UPDATE user_id = VALUES\(user_id\)/);
    assert.equal(params[0], 7);
    assert.equal(params[1], SUB.endpoint);
  } finally { server.close(); }
});

test('BK-PUSH-02b subscribe rejette un endpoint non https ou des clés absentes', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    let res = await postJson(`${url}/api/push/subscribe`, { ...SUB, endpoint: 'http://evil.example' }, AUTH);
    assert.equal(res.status, 400);
    res = await postJson(`${url}/api/push/subscribe`, { endpoint: SUB.endpoint }, AUTH);
    assert.equal(res.status, 400);
    res = await postJson(`${url}/api/push/subscribe`, SUB);   // sans auth
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// ── BK-PUSH-03 : désabonnement ──────────────────────────────────────────────
test('BK-PUSH-03 unsubscribe : un appareil ciblé, ou tous', async () => {
  const db = fakeDb([[/DELETE FROM push_subscriptions/, () => ({ affectedRows: 1 })]]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/push/subscribe`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ endpoint: SUB.endpoint }),
    });
    assert.equal(res.status, 200);
    assert.match(db.calls[0].sql, /user_id = \? AND endpoint = \?/);

    res = await fetch(`${url}/api/push/subscribe`, { method: 'DELETE', headers: AUTH });
    assert.equal(res.status, 200);
    assert.doesNotMatch(db.calls[1].sql, /endpoint/);
  } finally { server.close(); }
});

// ── BK-PUSH-04 : libellés ───────────────────────────────────────────────────
test('BK-PUSH-04 describe() produit un libellé court par type connu', () => {
  const join = push.describe('session_join', { from_name: 'Marc' });
  assert.match(join.title, /rejoint/i);
  assert.match(join.body, /Marc/);
  assert.equal(join.url, '/matchs');

  const nearby = push.describe('new_game_nearby', { summary: 'Foot 2030-01-15 19:00 · Grenoble' });
  assert.match(nearby.body, /Foot/);

  // type inconnu : aucun push (mieux que pousser un libellé vide)
  assert.equal(push.describe('type_inconnu'), null);
});

// ── BK-PUSH-05 : inerte sans clés ───────────────────────────────────────────
test('BK-PUSH-05 pushToUser sans VAPID ne touche pas la base', () => {
  if (push.isEnabled()) return;   // environnement configuré : test sans objet
  const db = fakeDb([[/.*/, () => { throw new Error('la base ne doit pas être appelée'); }]]);
  assert.doesNotThrow(() => push.pushToUser(db, 7, 'session_join', { from_name: 'Marc' }));
  assert.equal(db.calls.length, 0);
});
