const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen } = require('./helpers/testServer');
const slotsControllerFactory = require('../src/controllers/slots.controller');
const clubsRouter = require('../src/routes/clubs');
const { errorHandler } = require('../src/middleware/errorHandler');

const DAY = '2030-06-10';
const DOW = new Date(DAY + 'T00:00:00Z').getDay();

// ── BK-CLUB-02 : génération de créneaux ─────────────────────────────────────
test('BK-CLUB-02 génération : découpe la plage, saute les chevauchements, INSERT IGNORE', async () => {
  let insertSql = null, insertParams = null;
  const db = fakeDb([
    [/FROM recurring_availabilities/, () => [
      { id: 1, day_of_week: DOW, start_time: '10:00', end_time: '13:00', is_closed: 0 },
    ]],
    [/SELECT club_id FROM `terrains`/, () => [{ club_id: 1 }]],
    [/SELECT slot_duration FROM `terrains`/, () => [{ slot_duration: 60 }]],
    [/FROM availability_exceptions/, () => []],
    // un slot existant 11:00-12:00 -> le créneau du milieu doit être sauté
    [/FROM slots WHERE terrain_id/, () => [{ date_str: DAY, start_time: '11:00', end_time: '12:00' }]],
    [/INSERT IGNORE INTO slots/, (params, sql) => { insertSql = sql; insertParams = params; return { affectedRows: 2 }; }],
  ]);
  const controller = slotsControllerFactory(db);
  const out = await controller.generateSlotsForTerrain(2, DAY, DAY);
  assert.equal(out.inserted, 2);
  assert.match(insertSql, /INSERT IGNORE/, 'relance sans doublon');
  // 10:00-11:00 et 12:00-13:00 seulement (11:00-12:00 occupé)
  assert.deepEqual(insertParams.slice(0, 6), [2, 1, DAY, '10:00', '11:00', 'free']);
  assert.deepEqual(insertParams.slice(6, 12), [2, 1, DAY, '12:00', '13:00', 'free']);
});

test('BK-CLUB-02b jour fermé (exception) : aucun créneau généré', async () => {
  const db = fakeDb([
    [/FROM recurring_availabilities/, () => [
      { id: 1, day_of_week: DOW, start_time: '10:00', end_time: '13:00', is_closed: 0 },
    ]],
    [/SELECT club_id FROM `terrains`/, () => [{ club_id: 1 }]],
    [/SELECT slot_duration FROM `terrains`/, () => [{ slot_duration: 60 }]],
    [/FROM availability_exceptions/, () => [{ id: 9, date_str: DAY, is_closed: 1, special_open_time: null, special_close_time: null }]],
    [/FROM slots WHERE terrain_id/, () => []],
  ]);
  const controller = slotsControllerFactory(db);
  const out = await controller.generateSlotsForTerrain(2, DAY, DAY);
  assert.equal(out.inserted, 0, 'jour fermé respecté');
});

test('BK-CLUB-02c horaires spéciaux (exception) : plage réduite appliquée', async () => {
  let insertParams = null;
  const db = fakeDb([
    [/FROM recurring_availabilities/, () => [
      { id: 1, day_of_week: DOW, start_time: '08:00', end_time: '20:00', is_closed: 0 },
    ]],
    [/SELECT club_id FROM `terrains`/, () => [{ club_id: 1 }]],
    [/SELECT slot_duration FROM `terrains`/, () => [{ slot_duration: 60 }]],
    [/FROM availability_exceptions/, () => [{ id: 9, date_str: DAY, is_closed: 0, special_open_time: '10:00', special_close_time: '12:00' }]],
    [/FROM slots WHERE terrain_id/, () => []],
    [/INSERT IGNORE INTO slots/, (params) => { insertParams = params; return { affectedRows: 2 }; }],
  ]);
  const controller = slotsControllerFactory(db);
  const out = await controller.generateSlotsForTerrain(2, DAY, DAY);
  assert.equal(out.inserted, 2, '10-11 et 11-12 seulement');
  assert.equal(insertParams[3], '10:00');
  assert.equal(insertParams[9], '11:00');
});

// ── BK-CLUB-05 : KPIs dashboard ─────────────────────────────────────────────
test('BK-CLUB-05 kpis : agrégats du club, requireOwnClub bloque un autre club', async () => {
  const db = fakeDb([
    [/SELECT COUNT\(\*\) AS total_res/, (params) => {
      assert.equal(params[0], 1, 'scopé club 1');
      return [{ total_res: 4, revenue: 120, unique_users: 3 }];
    }],
    [/SELECT s\.\*, t\.name AS terrain_name/, () => [
      { start_time: '10:00:00', terrain_name: 'Padel 1', who: 'Léa', status: 'booked', price: 30 },
    ]],
    [/SELECT COUNT\(\*\) AS total_slots/, () => [{ total_slots: 10, booked_slots: 4 }]],
    [/./, () => []],
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api', clubsRouter(db));
  app.use(errorHandler);
  const { server, url } = await listen(app);

  const admin1 = { Authorization: `Bearer ${jwt.sign({ id: 20, role: 'club_admin', club_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
  const admin2 = { Authorization: `Bearer ${jwt.sign({ id: 21, role: 'club_admin', club_id: 2 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
  try {
    let res = await fetch(`${url}/api/clubs/1/kpis`, { headers: admin2 });
    assert.equal(res.status, 401, 'admin du club 2 refusé sur le club 1');

    res = await fetch(`${url}/api/clubs/1/kpis`, { headers: admin1 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kpis[0].value, '120 €');
    assert.equal(body.kpis[1].value, '4');
    assert.equal(body.kpis[2].value, '40 %'); // 4/10 slots
    assert.equal(body.kpis[3].value, '3');
    assert.deepEqual(body.today[0], { time: '10:00', court: 'Padel 1', who: 'Léa', status: 'Confirmé', price: 30 });
  } finally { server.close(); }
});
