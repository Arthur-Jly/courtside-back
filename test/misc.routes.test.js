const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const lastminuteRouter = require('../src/routes/lastminute');
const realtimeRouter = require('../src/routes/realtime');
const { errorHandler } = require('../src/middleware/errorHandler');

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', lastminuteRouter(db));
  app.use('/api', realtimeRouter());
  app.use(errorHandler);
  return app;
}

const ROW = {
  id: 1, title: 'Session Basketball', location: 'Gymnase', address: '45 rue X',
  sport: 'Basketball', time: '18h30', currentPlayers: 6, maxPlayers: 10,
  level: 'Intermédiaire', distance: '1.2km', description: 'Match', organizer: 'Alex',
  image: null, created_at: '2026-07-01',
};

// ── BK-LM : lastminute — alias camelCase préservés après le rename SQL ──────
test('BK-LM-01 GET /lastminute : forme API stable (currentPlayers/maxPlayers)', async () => {
  const db = fakeDb([
    [/SELECT .*current_players AS currentPlayers.* FROM last_minute_slots/s, (params, sql) => {
      assert.ok(!/SELECT \* FROM/.test(sql), 'colonnes explicites, pas de SELECT *');
      return [ROW];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/lastminute`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.last_minute_slots[0].currentPlayers, 6, 'camelCase préservé pour le front');
    assert.equal(body.last_minute_slots[0].maxPlayers, 10);
  } finally { server.close(); }
});

test('BK-LM-02 filtres sport/location paramétrés, id inconnu -> 404', async () => {
  const db = fakeDb([
    [/FROM last_minute_slots WHERE id/, () => []],
    [/FROM last_minute_slots/, (params, sql) => {
      assert.match(sql, /LOWER\(sport\) = \?/);
      assert.equal(params[0], 'padel');
      assert.equal(params.filter(p => p === '%gymnase%').length, 4, 'recherche texte sur 4 colonnes');
      return [];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/lastminute?sport=Padel&location=Gymnase`);
    assert.equal(res.status, 200);
    res = await fetch(`${url}/api/lastminute/999`);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

// ── BK-SSE : stream temps réel ──────────────────────────────────────────────
test('BK-SSE-01 stream refuse un token absent/forgé (401)', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    let res = await fetch(`${url}/api/realtime/stream`);
    assert.equal(res.status, 401);
    res = await fetch(`${url}/api/realtime/stream?token=forged.token.here`);
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('BK-SSE-02 stream accepte un JWT valide et ouvre un event-stream', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const token = jwt.sign({ id: 7, role: 'player' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const controller = new AbortController();
    const res = await fetch(`${url}/api/realtime/stream?token=${token}`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /: connected/);
    controller.abort(); // ferme la connexion SSE proprement
  } finally { server.close(); }
});
