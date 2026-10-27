/**
 * Chiffres vitrine — BK-ST-01 à 03.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const statsRouter = require('../src/routes/stats');
const { errorHandler } = require('../src/middleware/errorHandler');

function makeApp(db, opts) {
  const app = express();
  app.use('/api', statsRouter(db, opts));
  app.use(errorHandler);
  return app;
}

const db = () => fakeDb([
  [/FROM users/, (_p, sql) => {
    assert.match(sql, /role = 'player'/);
    assert.match(sql, /account-deleted/, 'comptes anonymisés exclus');
    return [{ n: 1234 }];
  }],
  [/FROM public_places/, (params, sql) => {
    assert.match(sql, /source_missing_at IS NULL/);
    assert.ok(params.includes('ign_confirmed') && !params.includes('auto'), 'terrains prouvés seulement');
    return [{ n: '8421' }];
  }],
  [/FROM clubs/, () => [{ n: 0 }]],
]);

test('BK-ST-01 GET /stats : joueurs, terrains prouvés, clubs confirmés', async () => {
  const { server, url } = await listen(makeApp(db()));
  try {
    const res = await fetch(`${url}/api/stats`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { players: 1234, places: 8421, clubs: 0 });
  } finally { server.close(); }
});

test('BK-ST-02 cache de 10 min : pas de COUNT à chaque visite', async () => {
  let t = 0;
  const d = db();
  const { server, url } = await listen(makeApp(d, { now: () => t }));
  try {
    await fetch(`${url}/api/stats`);
    await fetch(`${url}/api/stats`);
    assert.equal(d.calls.length, 3);
    t = 11 * 60 * 1000;
    await fetch(`${url}/api/stats`);
    assert.equal(d.calls.length, 6);
  } finally { server.close(); }
});

test('BK-ST-03 visites simultanées à froid : un seul calcul en vol', async () => {
  // Base lente : les COUNT ne répondent qu'une fois toutes les visites arrivées.
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const slowDb = { promise: () => ({ query: (sql) => { calls.push(sql); return gate.then(() => [[{ n: 150 }], []]); } }) };
  const { server, url } = await listen(makeApp(slowDb));
  try {
    const visits = [1, 2, 3, 4, 5].map(() => fetch(`${url}/api/stats`).then(r => r.json()));
    await new Promise(r => setTimeout(r, 100));
    release();
    const all = await Promise.all(visits);
    assert.equal(calls.length, 3, 'trois COUNT, pas quinze');
    for (const body of all) assert.deepEqual(body, { players: 150, places: 150, clubs: 150 });
  } finally { server.close(); }
});
