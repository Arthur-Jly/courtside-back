/**
 * Niveau déclaré par sport — BK-LVL-01 à 04.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const usersRouter = require('../src/routes/users');
const { errorHandler } = require('../src/middleware/errorHandler');

const AUTH = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', usersRouter(db));
  app.use(errorHandler);
  return app;
}

const put = (url, body, headers = AUTH) => fetch(`${url}/api/users/me/sport-levels`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('BK-LVL-01 PUT /users/me/sport-levels : upsert des sports reçus, retrait des autres, user du JWT', async () => {
  const db = fakeDb([[/user_sport_levels/, () => ({ affectedRows: 1 })]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const levels = [{ sport: 'foot', level: 'confirme' }, { sport: 'padel', level: 'debutant' }];
    const res = await put(url, { levels });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).levels, levels);

    const [upsert, prune] = db.calls;
    assert.match(upsert.sql, /INSERT INTO user_sport_levels[\s\S]*ON DUPLICATE KEY UPDATE level/);
    assert.deepEqual(upsert.params, [7, 'foot', 'confirme', 7, 'padel', 'debutant']);
    assert.match(prune.sql, /DELETE FROM user_sport_levels WHERE user_id = \? AND sport NOT IN \(\?, \?\)/);
    assert.deepEqual(prune.params, [7, 'foot', 'padel']);
  } finally { server.close(); }
});

test('BK-LVL-02 liste vide : tous les niveaux du joueur sont retirés', async () => {
  const db = fakeDb([[/user_sport_levels/, () => ({ affectedRows: 2 })]]);
  const { server, url } = await listen(makeApp(db));
  try {
    assert.equal((await put(url, { levels: [] })).status, 200);
    assert.equal(db.calls.length, 1);
    assert.match(db.calls[0].sql, /^DELETE FROM user_sport_levels WHERE user_id = \?$/);
    assert.deepEqual(db.calls[0].params, [7]);
  } finally { server.close(); }
});

test('BK-LVL-03 niveau inconnu, sport en double ou sport mal formé -> 400, rien écrit', async () => {
  const db = fakeDb([[/./, () => ({})]]);
  const { server, url } = await listen(makeApp(db));
  try {
    for (const levels of [
      [{ sport: 'foot', level: 'expert' }],
      [{ sport: 'foot', level: 'debutant' }, { sport: 'foot', level: 'confirme' }],
      [{ sport: 'Foot; DROP', level: 'debutant' }],
    ]) {
      assert.equal((await put(url, { levels })).status, 400, JSON.stringify(levels));
    }
    assert.equal((await put(url, {})).status, 400);
    assert.equal(db.calls.length, 0);
  } finally { server.close(); }
});

test('BK-LVL-04 sans auth -> 401', async () => {
  const db = fakeDb([]);
  const { server, url } = await listen(makeApp(db));
  try {
    assert.equal((await put(url, { levels: [] }, {})).status, 401);
  } finally { server.close(); }
});
