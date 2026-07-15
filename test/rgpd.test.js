const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const usersRouter = require('../src/routes/users');
const { errorHandler } = require('../src/middleware/errorHandler');

const TOKEN = jwt.sign({ id: 31, role: 'player' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', usersRouter(db));
  app.use(errorHandler);
  return app;
}

// ── BK-RGPD-01 ───────────────────────────────────────────────────────────────
test('BK-RGPD-01 DELETE /users/me anonymise, ne supprime jamais la ligne users', async () => {
  const db = fakeDb([
    [/DELETE FROM favorites/, () => ({})],
    [/DELETE FROM amis/, () => ({})],
    [/DELETE FROM annonce_invitations/, () => ({})],
    [/DELETE FROM password_resets/, () => ({})],
    [/DELETE FROM annonce_participants/, () => ({})],
    [/UPDATE users SET/, () => ({ affectedRows: 1 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/users/me`, { method: 'DELETE', headers: AUTH });
    assert.equal(res.status, 200);

    assert.ok(!db.calls.some(c => /DELETE FROM users/.test(c.sql)),
      'jamais de DELETE users — anonymisation seulement');

    const anonymize = db.calls.find(c => /UPDATE users SET/.test(c.sql));
    assert.ok(anonymize, 'UPDATE users émis');
    assert.match(anonymize.sql, /deleted-.*@deleted\.invalid/, 'email anonymisé');
    assert.match(anonymize.sql, /password_hash = 'account-deleted'/, 'login tué');
    assert.deepEqual(anonymize.params, [31], 'uniquement le user authentifié');

    for (const table of ['favorites', 'amis', 'annonce_invitations', 'password_resets', 'annonce_participants']) {
      const purge = db.calls.find(c => new RegExp(`DELETE FROM ${table}`).test(c.sql));
      assert.ok(purge, `purge ${table}`);
      assert.ok(purge.params.every(p => p === 31), `purge ${table} scopée au user`);
    }
  } finally { server.close(); }
});

test('BK-RGPD-01b DELETE /users/me sans auth -> 401', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await fetch(`${url}/api/users/me`, { method: 'DELETE' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// ── BK-RGPD-02 ───────────────────────────────────────────────────────────────
test('BK-RGPD-02 export : données du user seul, en pièce jointe JSON', async () => {
  const db = fakeDb([
    [/FROM users/, () => [{ id: 31, name: 'Léa', email: 'lea@example.com' }]],
    [/FROM user_profiles/, () => [{ user_id: 31, city: 'Lyon' }]],
    [/FROM reservations/, () => [{ id: 77, user_id: 31, price: 25 }]],
    [/FROM favorites/, () => []],
    [/FROM amis/, () => []],
    [/./, () => []], // toute autre table du dump -> vide
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/users/me/export`, { headers: AUTH });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    const body = await res.json();
    const flat = JSON.stringify(body);
    assert.ok(flat.includes('lea@example.com'), 'contient les données du user');
    // chaque requête du dump est scopée sur le user 31
    for (const call of db.calls) {
      if (call.params.length > 0) {
        assert.ok(call.params.every(p => p === 31),
          `requête scopée au user: ${call.sql.slice(0, 60)}`);
      }
    }
  } finally { server.close(); }
});
