/**
 * Tests d'intégration sur MySQL RÉEL (base jetable courtside_test).
 * Lancés via `npm run test:integration` — exclus de `npm test`.
 * Prouvent ce que les fakes ne peuvent pas : FK, verrous de slots,
 * provisioning baseline, anonymisation RGPD sur vraies contraintes.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';
process.env.PRIVATE_STRIPE_KEY = 'sk_test_dummy_key_for_tests';
const WEBHOOK_SECRET = 'whsec_test_secret_for_signatures';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { installStripeMock, signedHeader } = require('../helpers/stripeMock');
installStripeMock({});

const { createTestDb, seed } = require('./helpers/testDb');
const { listen } = require('../helpers/testServer');
const paymentsModule = require('../../src/routes/payments');
const slotsRouter = require('../../src/routes/slots');
const usersRouter = require('../../src/routes/users');
const { errorHandler } = require('../../src/middleware/errorHandler');

let db, fx, server, url;

function tokenFor(id, extra = {}) {
  return `Bearer ${jwt.sign({ id, role: 'player', name: 'T', ...extra }, process.env.JWT_SECRET, { expiresIn: '10m' })}`;
}

before(async () => {
  db = await createTestDb();
  fx = await seed(db);
  const app = express();
  app.use('/api', paymentsModule.webhook(db.pool));
  app.use(express.json());
  app.use('/api', slotsRouter(db.pool));
  app.use('/api', usersRouter(db.pool));
  app.use(errorHandler);
  ({ server, url } = await listen(app));
});

after(async () => {
  server?.close();
  await db?.destroy();
});

// ── BK-INF-05 : provisioning base vierge ────────────────────────────────────
test('BK-INF-05 base vierge provisionnée : 35 tables, 53 FK, migrations enregistrées', async () => {
  const [tables] = [await db.query(
    'SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')];
  assert.equal(tables[0].n, 35); // 34 métier + schema_migrations (017 a supprimé la table démo)
  const fks = await db.query(
    'SELECT COUNT(*) n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()');
  assert.equal(fks[0].n, 53);
  const migs = await db.query('SELECT COUNT(*) n FROM schema_migrations');
  assert.ok(migs[0].n >= 16, 'toutes les migrations marquées incluses');
});

// ── BK-PAY-11 : double-booking concurrent ───────────────────────────────────
function paidEvent(sessionId) {
  return JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        payment_status: 'paid',
        amount_total: 4000,
        customer_email: 'paul@test.dev',
        metadata: {
          date: '2030-06-15',
          slot: '10:00 - 11:30',
          userId: '7',
          slotId: '42',
          terrainId: '2',
          clubId: '1',
          reservationData: JSON.stringify({ court: { name: 'Padel 1' }, date: '2030-06-15', totalPrice: 40 }),
        },
      },
    },
  });
}

test('BK-PAY-11 deux paiements concurrents sur le même slot : un seul verrou', async () => {
  const payloads = [paidEvent('cs_int_race_A'), paidEvent('cs_int_race_B')];
  const responses = await Promise.all(payloads.map(p =>
    fetch(`${url}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signedHeader(p, WEBHOOK_SECRET) },
      body: p,
    })
  ));
  assert.deepEqual(responses.map(r => r.status), [200, 200]);

  // Exactement UNE ligne slot pour ce créneau, verrouillée par une seule résa.
  const slots = await db.query(
    "SELECT id, status, reservation_id FROM slots WHERE terrain_id = 2 AND date = '2030-06-15' AND start_time = '10:00:00'");
  assert.equal(slots.length, 1, 'pas de slot dupliqué (contrainte unique)');
  assert.equal(slots[0].status, 'booked');
  assert.ok(slots[0].reservation_id, 'slot lié à une réservation');

  const owners = await db.query(
    'SELECT id, stripe_session_id FROM reservations WHERE id = ?', [slots[0].reservation_id]);
  assert.equal(owners.length, 1);
  assert.match(owners[0].stripe_session_id, /^cs_int_race_(A|B)$/);
});

// ── BK-PAY-12 : annulation libère le slot (bug slot_id corrigé) ────────────
test('BK-PAY-12 annulation par le propriétaire : résa cancelled, slot relibéré', async () => {
  // réserve le slot 43 pour Paul
  const r = await db.query(
    `INSERT INTO reservations (user_id, terrain_id, start_time, end_time, price, status, stripe_session_id)
     VALUES (7, 2, '2030-06-15 11:30:00', '2030-06-15 13:00:00', 40, 'confirmed', 'cs_int_cancel_1')`);
  await db.query("UPDATE slots SET status = 'booked', reservation_id = ? WHERE id = 43", [r.insertId]);

  // un autre joueur ne peut pas annuler
  let res = await fetch(`${url}/api/reservations/${r.insertId}/cancel`, {
    method: 'POST', headers: { Authorization: tokenFor(fx.otherPlayerId) },
  });
  assert.equal(res.status, 403);

  // le propriétaire annule
  res = await fetch(`${url}/api/reservations/${r.insertId}/cancel`, {
    method: 'POST', headers: { Authorization: tokenFor(fx.playerId) },
  });
  assert.equal(res.status, 200, 'le bug reservations.slot_id aurait renvoyé 500');

  const [slot] = await db.query('SELECT status, reservation_id FROM slots WHERE id = 43');
  assert.equal(slot.status, 'free');
  assert.equal(slot.reservation_id, null);
  const [resa] = await db.query('SELECT status FROM reservations WHERE id = ?', [r.insertId]);
  assert.equal(resa.status, 'cancelled');
});

// ── BK-RGPD-03 : anonymisation sur vraies FK ────────────────────────────────
test('BK-RGPD-03 suppression de compte : purges + anonymisation, l\'historique survit', async () => {
  // relations réelles autour de Paul (7)
  await db.query("INSERT INTO amis (user_id_1, user_id_2, status) VALUES (7, 8, 'accepted')");
  await db.query('INSERT INTO favorites (user_id, terrain_id) VALUES (7, 2)');
  await db.query("INSERT INTO notifications (user_id, type, created_at) VALUES (7, 'invitation', NOW())");
  await db.query(`INSERT INTO announcements (sport_type, slot_start, slot_end, places_total, places_disponibles, created_by)
                  VALUES ('padel', '2030-07-01 10:00:00', '2030-07-01 11:00:00', 4, 3, 8)`);
  const [ann] = await db.query('SELECT id FROM announcements ORDER BY id DESC LIMIT 1');
  await db.query("INSERT INTO annonce_participants (annonce_id, user_id, role) VALUES (?, 7, 'participant')", [ann.id]);

  const res = await fetch(`${url}/api/users/me`, {
    method: 'DELETE', headers: { Authorization: tokenFor(7) },
  });
  assert.equal(res.status, 200, 'aucune erreur FK pendant la purge');

  const [user] = await db.query('SELECT name, email, username, password_hash FROM users WHERE id = 7');
  assert.equal(user.email, 'deleted-7@deleted.invalid');
  assert.equal(user.username, null);
  assert.equal(user.password_hash, 'account-deleted');

  assert.equal((await db.query('SELECT COUNT(*) n FROM amis WHERE user_id_1 = 7 OR user_id_2 = 7'))[0].n, 0);
  assert.equal((await db.query('SELECT COUNT(*) n FROM favorites WHERE user_id = 7'))[0].n, 0);
  assert.equal((await db.query('SELECT COUNT(*) n FROM annonce_participants WHERE user_id = 7'))[0].n, 0);
  // l'historique de réservation survit (anonymisé, pas supprimé)
  const resas = await db.query('SELECT COUNT(*) n FROM reservations WHERE user_id = 7');
  assert.ok(resas[0].n >= 1, 'réservations conservées');
});

// ── Cascades FK réelles ─────────────────────────────────────────────────────
test('BK-INF-07 cascades : supprimer une annonce emporte participants/waitlist/invitations', async () => {
  await db.query(`INSERT INTO announcements (sport_type, slot_start, slot_end, places_total, places_disponibles, created_by)
                  VALUES ('tennis', '2030-08-01 10:00:00', '2030-08-01 11:00:00', 4, 2, 8)`);
  const [ann] = await db.query('SELECT id FROM announcements ORDER BY id DESC LIMIT 1');
  await db.query("INSERT INTO annonce_participants (annonce_id, user_id, role) VALUES (?, 8, 'creator')", [ann.id]);
  await db.query('INSERT INTO annonce_waitlist (annonce_id, user_id, created_at) VALUES (?, 20, NOW())', [ann.id]);
  await db.query("INSERT INTO annonce_invitations (annonce_id, user_id, invited_by, status) VALUES (?, 20, 8, 'pending')", [ann.id]);

  await db.query('DELETE FROM announcements WHERE id = ?', [ann.id]);

  for (const table of ['annonce_participants', 'annonce_waitlist', 'annonce_invitations']) {
    const n = (await db.query(`SELECT COUNT(*) n FROM ${table} WHERE annonce_id = ?`, [ann.id]))[0].n;
    assert.equal(n, 0, `${table} purgée par CASCADE`);
  }
});
