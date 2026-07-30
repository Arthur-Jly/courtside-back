/**
 * Métriques de la phase 1 — BK-MET-*.
 * Ce qui compte ici : les seuils du go/no-go sont calculés PAR VILLE ET PAR
 * SPORT, et les alertes se déclenchent aux valeurs fixées à l'avance.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const adminRouter = require('../src/routes/admin');
const { errorHandler } = require('../src/middleware/errorHandler');
const { track } = require('../src/utils/track');

const ADMIN = { Authorization: `Bearer ${jwt.sign({ id: 1, role: 'admin', name: 'Admin' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
const PLAYER = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', adminRouter(db, { list: () => [], run: () => {} }));
  app.use(errorHandler);
  return app;
}

const metricsDb = (rows = {}) => fakeDb([
  [/GROUP BY city, sport/, () => rows.byCitySport || []],
  [/type = 'game_published'/, () => rows.weekly || []],
  [/returning_players/, () => rows.retention || []],
  [/FROM public_places/, () => rows.places || []],
]);

// ── BK-MET-01 : taux calculés par ville × sport ─────────────────────────────
test('BK-MET-01 remplissage et annulations calculés par ville × sport', async () => {
  const db = metricsDb({
    byCitySport: [
      { city: 'Grenoble', sport: 'foot', published: 20, filled: 12, joins: 90, leaves: 4, cancelled_no_players: 5, cancelled_by_organizer: 1, avg_hours_to_fill: '18.5' },
      { city: 'Grenoble', sport: 'basket', published: 10, filled: 3, joins: 20, leaves: 1, cancelled_no_players: 4, cancelled_by_organizer: 0, avg_hours_to_fill: null },
    ],
  });
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/admin/metrics/phase1?city=Grenoble`, { headers: ADMIN });
    assert.equal(res.status, 200);
    const body = await res.json();

    const foot = body.by_city_sport.find(r => r.sport === 'foot');
    const basket = body.by_city_sport.find(r => r.sport === 'basket');
    assert.equal(foot.fill_rate_pct, 60);
    assert.equal(foot.avg_hours_to_fill, 18.5);
    assert.deepEqual(foot.alerts, [], 'foot au-dessus des seuils');

    // basket : 30 % de remplissage et 40 % d'annulations -> deux alertes
    assert.equal(basket.fill_rate_pct, 30);
    assert.equal(basket.cancelled_rate_pct, 40);
    assert.equal(basket.alerts.length, 2);
    // les deux sports restent séparés : pas de moyenne qui masque le basket
    assert.equal(body.by_city_sport.length, 2);
  } finally { server.close(); }
});

// ── BK-MET-02 : séries hebdo et rétention ───────────────────────────────────
test('BK-MET-02 semaine sous la cible et rétention S+1 signalées', async () => {
  const db = metricsDb({
    weekly: [
      { week_start: new Date('2026-07-06T00:00:00Z'), city: 'Lyon', sport: 'foot', published: 12 },
      { week_start: new Date('2026-07-13T00:00:00Z'), city: 'Lyon', sport: 'foot', published: 4 },
    ],
    retention: [
      { week_start: new Date('2026-07-06T00:00:00Z'), city: 'Lyon', players: 10, returning_players: 4 },
      { week_start: new Date('2026-07-13T00:00:00Z'), city: 'Lyon', players: 10, returning_players: 2 },
    ],
  });
  const { server, url } = await listen(makeApp(db));
  try {
    const body = await (await fetch(`${url}/api/admin/metrics/phase1`, { headers: ADMIN })).json();

    assert.equal(body.weekly[0].below_target, false, '12 publications : au-dessus de 10');
    assert.equal(body.weekly[1].below_target, true, '4 publications : sous la cible');
    assert.equal(body.weekly[0].week_start, '2026-07-06');

    assert.equal(body.retention[0].retention_pct, 40);
    assert.equal(body.retention[0].below_target, false);
    assert.equal(body.retention[1].retention_pct, 20, 'sous les 30 % attendus');
    assert.equal(body.retention[1].below_target, true);
  } finally { server.close(); }
});

// ── BK-MET-03 : qualité du référentiel par ville ────────────────────────────
test('BK-MET-03 part de lieux vérifiés par ville', async () => {
  const db = metricsDb({
    places: [
      { city: 'Grenoble', verification_status: 'manually_curated', count: 30 },
      { city: 'Grenoble', verification_status: 'auto', count: 10 },
      { city: 'Grenoble', verification_status: 'community_verified', count: 10 },
    ],
  });
  const { server, url } = await listen(makeApp(db));
  try {
    const body = await (await fetch(`${url}/api/admin/metrics/phase1`, { headers: ADMIN })).json();
    const gre = body.places.find(p => p.city === 'Grenoble');
    assert.equal(gre.total, 50);
    assert.equal(gre.verified_pct, 80);
  } finally { server.close(); }
});

// ── BK-MET-04 : garde d'accès ───────────────────────────────────────────────
test('BK-MET-04 métriques réservées au super-admin', async () => {
  const { server, url } = await listen(makeApp(metricsDb()));
  try {
    assert.equal((await fetch(`${url}/api/admin/metrics/phase1`)).status, 401);
    assert.equal((await fetch(`${url}/api/admin/metrics/phase1`, { headers: PLAYER })).status, 401);
  } finally { server.close(); }
});

// ── BK-MET-05 : le tracker ne casse jamais le parcours ──────────────────────
test('BK-MET-05 track() avale les erreurs SQL et rejette les types inconnus', () => {
  const failing = fakeDb([[/INSERT INTO analytics_events/, () => { throw new Error('table absente'); }]]);
  assert.doesNotThrow(() => track(failing, 'game_published', { userId: 1, city: 'Lyon', sport: 'foot' }));

  const db = fakeDb([[/INSERT INTO analytics_events/, () => ({ insertId: 1 })]]);
  track(db, 'type_bidon', { userId: 1 });
  assert.equal(db.calls.length, 0, 'aucun INSERT pour un type non déclaré');

  track(db, 'game_joined', { userId: 3, announcementId: 9, city: 'Grenoble', sport: 'basket' });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params.slice(0, 6), ['game_joined', 3, 9, null, 'Grenoble', 'basket']);
});
