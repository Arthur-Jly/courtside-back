const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';
process.env.PRIVATE_STRIPE_KEY = 'sk_test_dummy_key_for_tests';
const WEBHOOK_SECRET = 'whsec_test_secret_for_signatures';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const { installStripeMock, signedHeader } = require('./helpers/stripeMock');

const stripeMock = installStripeMock({
  retrieve: async (id) => RETRIEVE_RESPONSES[id] || (() => { throw new Error('no stub for ' + id); })(),
});
const paymentsModule = require('../src/routes/payments');
const { errorHandler } = require('../src/middleware/errorHandler');

let RETRIEVE_RESPONSES = {};

const TOKEN = jwt.sign({ id: 9, role: 'player', email: 'p@x.fr' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use('/api', paymentsModule.webhook(db));   // raw body AVANT json, comme index.js
  app.use(express.json());
  app.use('/api', paymentsModule(db));
  app.use(errorHandler);
  return app;
}

const CHECKOUT_BODY = {
  reservationData: {
    court: { name: 'Padel 1', id: 2, club_id: 1 },
    date: '2030-06-15',
    slotLabel: '10:00 - 11:00',
    slotId: 42,
    terrainId: 2,
    totalPrice: 40,
  },
};

// ── BK-PAY-01 ────────────────────────────────────────────────────────────────
test('BK-PAY-01 create-checkout-session sans auth -> 401', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    const res = await postJson(`${url}/api/payments/create-checkout-session`, CHECKOUT_BODY);
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// ── BK-PAY-02 ────────────────────────────────────────────────────────────────
test('BK-PAY-02 montants invalides -> 400, Stripe jamais appelé', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  const before = stripeMock.calls.create.length;
  try {
    for (const totalPrice of [-5, 'abc', 0, 999999]) {
      const body = { reservationData: { ...CHECKOUT_BODY.reservationData, slotId: undefined, totalPrice } };
      const res = await postJson(`${url}/api/payments/create-checkout-session`, body, AUTH);
      assert.equal(res.status, 400, `totalPrice=${totalPrice}`);
    }
    assert.equal(stripeMock.calls.create.length, before, 'aucun appel Stripe');
  } finally { server.close(); }
});

// ── BK-PAY-03 ────────────────────────────────────────────────────────────────
test('BK-PAY-03 checkout valide -> 200, URL Stripe, montant en centimes', async () => {
  const db = fakeDb([[/SELECT status FROM slots/, () => [{ status: 'free' }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/payments/create-checkout-session`, CHECKOUT_BODY, AUTH);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/checkout\.stripe\.com\//);
    const payload = stripeMock.calls.create.at(-1);
    assert.equal(payload.line_items[0].price_data.unit_amount, 4000); // 40 € -> 4000 cts
    assert.equal(payload.metadata.userId, '9');
    assert.equal(payload.metadata.slotId, '42');
  } finally { server.close(); }
});

// ── BK-PAY-04 ────────────────────────────────────────────────────────────────
test('BK-PAY-04 slot déjà réservé -> 409, Stripe jamais appelé', async () => {
  const db = fakeDb([[/SELECT status FROM slots/, () => [{ status: 'booked' }]]]);
  const { server, url } = await listen(makeApp(db));
  const before = stripeMock.calls.create.length;
  try {
    const res = await postJson(`${url}/api/payments/create-checkout-session`, CHECKOUT_BODY, AUTH);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /vient d'être réservé/);
    assert.equal(stripeMock.calls.create.length, before);
  } finally { server.close(); }
});

// ── Webhook helpers ─────────────────────────────────────────────────────────
function paidSessionEvent(overrides = {}) {
  return JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: overrides.id || 'cs_test_paid_0001',
        payment_status: overrides.payment_status || 'paid',
        amount_total: 4000,
        customer_email: 'p@x.fr',
        metadata: {
          reservationData: JSON.stringify(CHECKOUT_BODY.reservationData),
          date: '2030-06-15',
          slot: '10:00 - 11:00',
          userId: '9',
          slotId: '42',
          terrainId: '2',
          clubId: '1',
          ...overrides.metadata,
        },
      },
    },
  });
}

function webhookHandlers({ existingReservation = false, slotUpdateHits = 1 } = {}) {
  return [
    [/SELECT id FROM reservations WHERE stripe_session_id/, () => (existingReservation ? [{ id: 1 }] : [])],
    [/INSERT INTO reservations/, () => ({ insertId: 77 })],
    [/INSERT INTO notifications/, () => ({ insertId: 1 })],
    [/UPDATE slots SET status/, () => ({ affectedRows: slotUpdateHits })],
    [/SELECT id FROM slots WHERE terrain_id/, () => [{ id: 42 }]],
    [/INSERT INTO reservation_share_payments/, () => ({ insertId: 5 })],
    [/SELECT id FROM terrains/, () => [{ id: 2 }]],
  ];
}

async function postWebhook(url, payload, header) {
  return fetch(`${url}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
}

// ── BK-PAY-05 ────────────────────────────────────────────────────────────────
test('BK-PAY-05 webhook signature VALIDE -> résa créée + slot verrouillé', async () => {
  const db = fakeDb(webhookHandlers());
  const { server, url } = await listen(makeApp(db));
  try {
    const payload = paidSessionEvent();
    const res = await postWebhook(url, payload, signedHeader(payload, WEBHOOK_SECRET));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    const inserted = db.calls.find(c => /INSERT INTO reservations/.test(c.sql));
    assert.ok(inserted, 'INSERT reservations émis');
    assert.equal(inserted.params[6], 'cs_test_paid_0001'); // stripe_session_id
    assert.equal(inserted.params[5], 'confirmed');
    const slotUpdate = db.calls.find(c => /UPDATE slots SET status/.test(c.sql));
    assert.ok(slotUpdate, 'slot verrouillé');
    assert.deepEqual(slotUpdate.params.slice(0, 2), ['booked', 77]);
  } finally { server.close(); }
});

// ── BK-PAY-06 déjà couvert dans paymentsWebhook.test.js (signature forgée) ──

// ── BK-PAY-07 ────────────────────────────────────────────────────────────────
test('BK-PAY-07 webhook unpaid -> 200 mais aucune résa', async () => {
  const db = fakeDb(webhookHandlers());
  const { server, url } = await listen(makeApp(db));
  try {
    const payload = paidSessionEvent({ payment_status: 'unpaid' });
    const res = await postWebhook(url, payload, signedHeader(payload, WEBHOOK_SECRET));
    assert.equal(res.status, 200);
    assert.ok(!db.calls.some(c => /INSERT INTO reservations/.test(c.sql)), 'zéro INSERT');
  } finally { server.close(); }
});

// ── BK-PAY-08 ────────────────────────────────────────────────────────────────
test('BK-PAY-08 webhook idempotent : session déjà traitée -> aucun doublon', async () => {
  const db = fakeDb(webhookHandlers({ existingReservation: true }));
  const { server, url } = await listen(makeApp(db));
  try {
    const payload = paidSessionEvent();
    const res = await postWebhook(url, payload, signedHeader(payload, WEBHOOK_SECRET));
    assert.equal(res.status, 200);
    assert.ok(!db.calls.some(c => /INSERT INTO reservations/.test(c.sql)), 'zéro INSERT');
  } finally { server.close(); }
});

// ── BK-PAY-05b part d'un paiement partagé ───────────────────────────────────
test('BK-PAY-05b webhook share payment -> enregistre la part, pas de résa', async () => {
  const db = fakeDb(webhookHandlers());
  const { server, url } = await listen(makeApp(db));
  try {
    const payload = paidSessionEvent({ id: 'cs_test_share_01', metadata: { share_for_reservation: '77' } });
    const res = await postWebhook(url, payload, signedHeader(payload, WEBHOOK_SECRET));
    assert.equal(res.status, 200);
    const share = db.calls.find(c => /INSERT IGNORE INTO reservation_share_payments/.test(c.sql));
    assert.ok(share, 'part enregistrée');
    assert.equal(share.params[0], 77);
    assert.equal(share.params[2], 40); // amount_total 4000 cts -> 40 €
    assert.ok(!db.calls.some(c => /INSERT INTO reservations\b/.test(c.sql)), 'pas de résa');
  } finally { server.close(); }
});

// ── BK-PAY-09 ────────────────────────────────────────────────────────────────
test('BK-PAY-09 confirm-payment : paid -> 200, unpaid -> 400, id invalide -> 400', async () => {
  RETRIEVE_RESPONSES = {
    cs_test_paid_0001: JSON.parse(paidSessionEvent()).data.object,
    cs_test_unpaid_01: { id: 'cs_test_unpaid_01', payment_status: 'unpaid', metadata: {} },
  };
  const db = fakeDb(webhookHandlers({ existingReservation: true })); // idempotent: résa déjà là
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/payments/confirm-payment`, { sessionId: 'cs_test_paid_0001' }, AUTH);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    res = await postJson(`${url}/api/payments/confirm-payment`, { sessionId: 'cs_test_unpaid_01' }, AUTH);
    assert.equal(res.status, 400);

    res = await postJson(`${url}/api/payments/confirm-payment`, { sessionId: 'DROP TABLE;--' }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ── BK-PAY-10 ────────────────────────────────────────────────────────────────
test('BK-PAY-10 create-share-link : lien pour sa part, ownership vérifié', async () => {
  const db = fakeDb([
    [/SELECT id, user_id, price FROM reservations/, () => [{ id: 77, user_id: 9, price: 25 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/payments/create-share-link`,
      { checkout_session_id: 'cs_test_paid_0001' }, AUTH);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.amount, 25);
    const payload = stripeMock.calls.create.at(-1);
    assert.equal(payload.line_items[0].price_data.unit_amount, 2500);
    assert.equal(payload.metadata.share_for_reservation, '77');
  } finally { server.close(); }
});

test('BK-PAY-10b create-share-link : pas ma résa -> 403', async () => {
  const db = fakeDb([
    [/SELECT id, user_id, price FROM reservations/, () => [{ id: 77, user_id: 999, price: 25 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/payments/create-share-link`,
      { checkout_session_id: 'cs_test_paid_0001' }, AUTH);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});
