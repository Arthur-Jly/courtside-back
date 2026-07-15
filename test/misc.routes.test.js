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

const TODAY = new Date().toISOString().slice(0, 10);
const SLOT_ROW = {
  id: 42, date: TODAY, start_time: '18:30:00', end_time: '20:00:00',
  terrain_id: 2, sport_type: 'padel', terrain_name: 'Padel 1', price_per_hour: 20,
  club_name: 'Club Test', address: '1 rue du Test', city: 'Lyon',
};

// ── BK-LM : lastminute = vrais créneaux libres aujourd'hui/demain ───────────
test('BK-LM-01 GET /lastminute : créneaux réels des clubs confirmés, forme front', async () => {
  const db = fakeDb([
    [/FROM slots s/, (params, sql) => {
      assert.match(sql, /s\.status = 'free'/, 'créneaux libres uniquement');
      assert.match(sql, /c\.status = 'confirme'/, 'clubs confirmés uniquement');
      assert.match(sql, /CURDATE\(\)/, 'fenêtre aujourd hui/demain');
      return [SLOT_ROW];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/lastminute`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    const s = body.last_minute_slots[0];
    assert.equal(s.title, 'Padel — Club Test');
    assert.equal(s.time, "Aujourd'hui 18h30 — 20h");
    assert.equal(s.location, 'Club Test, Lyon');
    assert.equal(s.terrainId, 2, 'permet la navigation vers la fiche terrain');
    assert.equal(s.price, 20);
  } finally { server.close(); }
});

test('BK-LM-02 filtres sport/lieu paramétrés, id inconnu -> 404', async () => {
  const db = fakeDb([
    [/AND s\.id = \?/, () => []],
    [/FROM slots s/, (params, sql) => {
      assert.match(sql, /LOWER\(t\.sport_type\) = \?/);
      assert.equal(params[0], 'padel');
      assert.equal(params.filter(p => p === '%lyon%').length, 3, 'recherche club/adresse/ville');
      return [];
    }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/lastminute?sport=Padel&location=Lyon`);
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
