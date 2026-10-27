/**
 * Durcissements issus de l'audit sécurité : chaque test verrouille un correctif
 * (jetons, erreurs client, e-mails, confidentialité, créneaux, push, uploads, CSV).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';
process.env.SMTP_HOST = 'smtp.test.invalid';
const SECRET = process.env.JWT_SECRET;

// Capture des e-mails : le transport est créé au require d'emailService.
const sentMails = [];
nodemailer.createTransport = () => ({ sendMail: async (mail) => { sentMails.push(mail); } });

const { fakeDb, mysqlError, dupEntry } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const { errorHandler, AppError } = require('../src/middleware/errorHandler');
const { requireAuth } = require('../src/middleware/auth');
const tokenRevocation = require('../src/services/tokenRevocation');
const emailService = require('../src/services/emailService');
const { hasValidSignature } = require('../src/services/storageService');
const usersRouter = require('../src/routes/users');
const announcementsRouter = require('../src/routes/announcements');
const slotsRouter = require('../src/routes/slots');
const slotsControllerFactory = require('../src/controllers/slots.controller');
const pushRouter = require('../src/routes/push');
const adminRouter = require('../src/routes/admin');

const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '5m' })}` });
const PLAYER_7 = bearer({ id: 7, role: 'player', name: 'Paul' });

function appWith(mount) {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use(errorHandler);
  return app;
}

// ── SEC-01 : algorithme JWT épinglé ─────────────────────────────────────────
test('SEC-01 requireAuth : HS256 accepté ; alg=none et HS512 refusés', async () => {
  const app = appWith((a) => a.get('/me', requireAuth, (req, res) => res.json({ id: req.user.id })));
  const { server, url } = await listen(app);
  try {
    const call = (token) => fetch(`${url}/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await call(jwt.sign({ id: 1 }, SECRET, { algorithm: 'HS256' }))).status, 200);
    assert.equal((await call(jwt.sign({ id: 1 }, SECRET, { algorithm: 'HS512' }))).status, 401, 'HS512');
    assert.equal((await call(jwt.sign({ id: 1 }, '', { algorithm: 'none' }))).status, 401, 'alg=none');
    assert.equal((await call(jwt.sign({ id: 1 }, 'un-autre-secret-un-autre-secret-xx'))).status, 401, 'mauvais secret');
  } finally { server.close(); }
});

// ── SEC-02 : révocation ─────────────────────────────────────────────────────
test('SEC-02 revokeUser invalide les jetons émis avant, pas ceux émis après', async () => {
  tokenRevocation.reset();
  const app = appWith((a) => a.get('/me', requireAuth, (req, res) => res.json({ id: req.user.id })));
  const { server, url } = await listen(app);
  try {
    const old = jwt.sign({ id: 5, iat: Math.floor(Date.now() / 1000) - 30 }, SECRET, { expiresIn: '1h' });
    const other = jwt.sign({ id: 6, iat: Math.floor(Date.now() / 1000) - 30 }, SECRET, { expiresIn: '1h' });
    const call = (token) => fetch(`${url}/me`, { headers: { Authorization: `Bearer ${token}` } });

    assert.equal((await call(old)).status, 200);
    tokenRevocation.revokeUser(5);
    assert.equal((await call(old)).status, 401, 'ancien jeton du user 5 refusé');
    assert.equal((await call(other)).status, 200, 'les autres comptes ne sont pas touchés');
    assert.equal((await call(jwt.sign({ id: 5 }, SECRET, { expiresIn: '1h' }))).status, 200, 'nouveau jeton accepté');
  } finally { server.close(); tokenRevocation.reset(); }
});

// ── SEC-03 : erreurs client -> 4xx, jamais 500 ──────────────────────────────
test('SEC-03 JSON invalide -> 400, corps trop gros -> 413, CORS refusé -> 403', async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/x', (req, res) => res.json({ ok: true }));
  app.get('/cors', (req, res, next) => next(new AppError('CORS: origine refusée', 403)));
  app.use(errorHandler);
  const { server, url } = await listen(app);
  try {
    const json = { 'Content-Type': 'application/json' };
    const bad = await fetch(`${url}/x`, { method: 'POST', headers: json, body: '{oups' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'Corps de requête invalide');

    const big = await fetch(`${url}/x`, { method: 'POST', headers: json, body: JSON.stringify({ a: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413);

    assert.equal((await fetch(`${url}/cors`)).status, 403);
  } finally { server.close(); }
});

// ── SEC-04 : e-mails HTML-échappés ──────────────────────────────────────────
test('SEC-04 e-mails : prénom, terrain et club échappés (pas de HTML injecté)', async () => {
  sentMails.length = 0;
  await emailService.sendWelcome('a@b.fr', '<a href="https://evil.example">Clique ici</a>');
  await emailService.sendReservationConfirmed('a@b.fr', {
    courtName: '<script>alert(1)</script>', date: '2030-06-15', slot: '10:00', amount: 20,
  });
  await emailService.sendClubInvitation('a@b.fr', { inviteUrl: 'https://x.fr/i?t="><script>', clubName: '<img src=x onerror=alert(1)>' });

  assert.equal(sentMails.length, 3);
  for (const mail of sentMails) {
    assert.ok(!/<script>|<img src=x|<a href="https:\/\/evil/.test(mail.html), `HTML injecté dans « ${mail.subject} »`);
  }
  assert.match(sentMails[0].html, /&lt;a href=&quot;https:\/\/evil\.example&quot;&gt;/);
  assert.ok(!sentMails[2].html.includes('"><script>'), 'href échappé');
});

// ── SEC-05 : confidentialité du profil ──────────────────────────────────────
function profileDb(isPublic) {
  return fakeDb([
    [/SELECT id, name, username FROM users WHERE id/, () => [{ id: 5, name: 'Léa', username: 'lea' }]],
    [/SELECT \* FROM user_profiles/, () => [{
      user_id: 5, bio: 'bio-secrete', city: 'Lyon', birthdate: '1990-01-01', sports: 'foot', is_public: isPublic,
    }]],
    [/FROM user_sport_levels/, () => [{ sport: 'foot', level: 'confirme' }]],
  ]);
}

test('SEC-05 GET /users/:id/profile : un profil privé ne fuit ni bio, ni ville, ni date de naissance', async () => {
  const { server, url } = await listen(appWith((a) => a.use('/api', usersRouter(profileDb(0)))));
  try {
    const anon = await (await fetch(`${url}/api/users/5/profile`)).json();
    assert.deepEqual(anon.profile, { user_id: 5, is_public: false, user_name: 'Léa', username: 'lea' });

    const stranger = await (await fetch(`${url}/api/users/5/profile`, { headers: PLAYER_7 })).json();
    assert.equal(stranger.profile.bio, undefined);
    assert.equal(stranger.profile.birthdate, undefined);

    const owner = await (await fetch(`${url}/api/users/5/profile`, { headers: bearer({ id: 5, role: 'player' }) })).json();
    assert.equal(owner.profile.bio, 'bio-secrete', 'le propriétaire voit tout');
    assert.equal(owner.profile.birthdate, '1990-01-01');
  } finally { server.close(); }
});

test('SEC-05b un profil public reste visible sans authentification', async () => {
  const { server, url } = await listen(appWith((a) => a.use('/api', usersRouter(profileDb(1)))));
  try {
    const body = await (await fetch(`${url}/api/users/5/profile`)).json();
    assert.equal(body.profile.bio, 'bio-secrete');
    assert.equal(body.profile.is_public, true);
  } finally { server.close(); }
});

// ── SEC-06 : user_id de l'URL ne donne plus accès aux sessions privées ──────
test('SEC-06 GET /announcements : user_id de l\'URL ignoré, seul le JWT compte', async () => {
  let seen = null;
  const db = fakeDb([
    [/FROM announcements a/, (params, sql) => { seen = { params, sql }; return []; }],
    [/./, () => []],
  ]);
  const { server, url } = await listen(appWith((a) => a.use('/api', announcementsRouter(db))));
  try {
    let res = await fetch(`${url}/api/announcements?user_id=9`);
    assert.equal(res.status, 200);
    assert.ok(!seen.sql.includes("a.visibility = 'private'"), 'anonyme : aucune session privée demandée');
    assert.ok(!seen.params.includes(9));

    seen = null;
    res = await fetch(`${url}/api/announcements?user_id=9`, { headers: PLAYER_7 });
    assert.equal(res.status, 200);
    assert.ok(seen.sql.includes("a.visibility = 'private'"), 'connecté : ses propres sessions privées');
    assert.ok(seen.params.includes(7), 'identité = JWT');
    assert.ok(!seen.params.includes(9), 'jamais l\'id passé dans l\'URL');
  } finally { server.close(); }
});

// ── SEC-07 : réservation directe sans paiement ──────────────────────────────
test('SEC-07 POST /slots/:id/book : désactivé par défaut (aucun accès DB)', async () => {
  delete process.env.ALLOW_DIRECT_BOOKING;
  const db = fakeDb([]);
  const { server, url } = await listen(appWith((a) => a.use('/api', slotsRouter(db))));
  try {
    const res = await postJson(`${url}/api/slots/1/book`, { price: 0 }, PLAYER_7);
    assert.equal(res.status, 403);
    assert.equal(db.calls.length, 0);
  } finally { server.close(); }
});

test('SEC-07b réservation directe activée : le prix vient du terrain, pas du body', async () => {
  process.env.ALLOW_DIRECT_BOOKING = 'true';
  const calls = [];
  const conn = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM slots s JOIN terrains t/.test(sql)) {
        return [[{ status: 'free', date: new Date(2030, 5, 10), start_time: '10:00:00', end_time: '11:30:00', terrain_id: 2, price_per_hour: 40 }]];
      }
      if (/INSERT INTO reservations/.test(sql)) return [{ insertId: 500 }];
      if (/UPDATE slots/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error('SQL inattendu: ' + sql);
    },
  };
  const db = { query() {}, promise: () => ({ getConnection: async () => conn, query: async () => [[]] }) };
  const { server, url } = await listen(appWith((a) => a.use('/api', slotsRouter(db))));
  try {
    const res = await postJson(`${url}/api/slots/1/book`, { price: 0.01, user_id: 999 }, PLAYER_7);
    assert.equal(res.status, 200);
    const insert = calls.find(c => /INSERT INTO reservations/.test(c.sql));
    assert.deepEqual(insert.params, [7, 2, '2030-06-10 10:00:00', '2030-06-10 11:30:00', 60, 'confirmed'],
      'user du JWT, prix 40 €/h × 1,5 h = 60 €');
  } finally { server.close(); delete process.env.ALLOW_DIRECT_BOOKING; }
});

// ── SEC-08 : génération de créneaux bornée, purges qui gardent l'historique ─
test('SEC-08 generateSlotsForTerrain : plage > 366 jours ou inversée -> 400 avant toute requête', async () => {
  const db = fakeDb([]);
  const controller = slotsControllerFactory(db);
  for (const [from, to] of [['2030-01-01', '2032-01-01'], ['2030-06-10', '2030-06-01'], ['n-importe-quoi', '2030-06-01']]) {
    await assert.rejects(controller.generateSlotsForTerrain(2, from, to), (e) => e.statusCode === 400, `${from} → ${to}`);
  }
  assert.equal(db.calls.length, 0);
});

test('SEC-08b cleanup et truncate ne suppriment jamais un créneau réservé', async () => {
  const sqls = [];
  const db = fakeDb([[/DELETE FROM slots/, (params, sql) => { sqls.push(sql); return { affectedRows: 0 }; }]]);
  const controller = slotsControllerFactory(db);
  const res = { json() {} };
  await controller.adminCleanupSlots({ user: { club_id: 1 }, body: { keepDays: 30 } }, res);
  await controller.adminTruncateSlots({ user: { club_id: 1 }, body: {} }, res);
  assert.match(sqls[0], /status <> 'booked'/);
  assert.match(sqls[1], /status IN \('free', 'blocked'\)/);
});

// ── SEC-09 : abonnement push -> services de push connus uniquement ──────────
test('SEC-09 push/subscribe : seuls les services de push connus (anti-SSRF)', async () => {
  const db = fakeDb([[/INSERT INTO push_subscriptions/, () => ({ affectedRows: 1 })]]);
  const { server, url } = await listen(appWith((a) => a.use('/api', pushRouter(db))));
  const keys = { p256dh: 'k', auth: 'a' };
  try {
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data',
      'https://intranet.corp/hook',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'pas-une-url',
    ]) {
      const res = await postJson(`${url}/api/push/subscribe`, { endpoint, keys }, PLAYER_7);
      assert.equal(res.status, 400, endpoint);
    }
    assert.equal(db.calls.length, 0, 'rien n\'est stocké');

    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ]) {
      const res = await postJson(`${url}/api/push/subscribe`, { endpoint, keys }, PLAYER_7);
      assert.equal(res.status, 201, endpoint);
    }
  } finally { server.close(); }
});

// ── SEC-10 : signature réelle des fichiers uploadés ─────────────────────────
test('SEC-10 hasValidSignature : le contenu doit correspondre au type déclaré', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const gif = Buffer.from('GIF89a\0\0\0\0');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  const pdf = Buffer.from('%PDF-1.7\n...');
  const html = Buffer.from('<html><script>alert(1)</script></html>');

  assert.ok(hasValidSignature(png, 'image/png'));
  assert.ok(hasValidSignature(jpeg, 'image/jpeg'));
  assert.ok(hasValidSignature(gif, 'image/gif'));
  assert.ok(hasValidSignature(webp, 'image/webp'));
  assert.ok(hasValidSignature(pdf, 'application/pdf'));

  assert.ok(!hasValidSignature(html, 'image/png'), 'HTML renommé en .png');
  assert.ok(!hasValidSignature(png, 'image/jpeg'), 'PNG déclaré JPEG');
  assert.ok(!hasValidSignature(png, 'image/svg+xml'), 'type non géré');
  assert.ok(!hasValidSignature(Buffer.alloc(0), 'image/png'), 'fichier vide');
  assert.ok(!hasValidSignature('pas un buffer', 'image/png'));
});

// ── SEC-11 : export CSV admin sans injection de formules ────────────────────
test('SEC-11 export CSV admin : =, +, -, @ en début de cellule neutralisés', async () => {
  const db = fakeDb([[/FROM reservations r\s+JOIN terrains/, () => [{
    id: 1, start_time: '2030-01-01 10:00:00', price: 25, status: 'confirmed',
    club_name: '=HYPERLINK("http://evil.example","clic")', terrain_name: '@SUM(1+1)', user_email: '+33612345678',
  }]]]);
  const { server, url } = await listen(appWith((a) => a.use('/api', adminRouter(db, null))));
  try {
    const res = await fetch(`${url}/api/admin/finances/export`, { headers: bearer({ id: 1, role: 'admin' }) });
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.ok(csv.includes(`"'=HYPERLINK(`), 'formule préfixée par une apostrophe');
    assert.ok(csv.includes(`"'@SUM(1+1)"`));
    assert.ok(csv.includes(`"'+33612345678"`));
    assert.ok(!/(^|,)"=/.test(csv.split('\n')[1]), 'aucune cellule ne commence par =');
  } finally { server.close(); }
});

// ── SEC-12 : suppression de compte admin = même anonymisation que la self ──
test('SEC-12 DELETE /admin/users/:id : purge complète (push, notifications, notes) + révocation', async () => {
  tokenRevocation.reset();
  const db = fakeDb([
    [/SELECT id, role FROM users WHERE id/, () => [{ id: 9, role: 'player' }]],
    [/./, () => ({ affectedRows: 0 })],
  ]);
  const { server, url } = await listen(appWith((a) => a.use('/api', adminRouter(db, null))));
  try {
    const res = await fetch(`${url}/api/admin/users/9`, { method: 'DELETE', headers: bearer({ id: 1, role: 'admin' }) });
    assert.equal(res.status, 200);
    for (const table of ['push_subscriptions', 'notifications', 'user_profiles', 'player_ratings', 'favorites', 'amis']) {
      assert.ok(db.calls.some(c => new RegExp(`DELETE FROM ${table}`).test(c.sql)), `purge ${table}`);
    }
    const ratings = db.calls.find(c => /DELETE FROM player_ratings/.test(c.sql));
    assert.match(ratings.sql, /rated_user_id/, 'colonne réelle du schéma (rated_id n\'existe pas)');
    assert.ok(db.calls.some(c => /UPDATE messages SET content/.test(c.sql)), 'messages anonymisés');
    assert.ok(tokenRevocation.isRevoked(9, Math.floor(Date.now() / 1000) - 60), 'jetons du compte révoqués');
  } finally { server.close(); tokenRevocation.reset(); }
});

// ── SEC-13 : email de profil / demandes d'amis ──────────────────────────────
test('SEC-13 PUT /users/:id : email normalisé en minuscules, doublon -> 409', async () => {
  let params = null;
  let dup = false;
  const db = fakeDb([[/UPDATE users SET/, (p) => { params = p; if (dup) throw dupEntry(); return { affectedRows: 1 }; }]]);
  const { server, url } = await listen(appWith((a) => a.use('/api', usersRouter(db))));
  try {
    const put = () => fetch(`${url}/api/users/7`, {
      method: 'PUT', headers: { ...PLAYER_7, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Paul@Example.COM' }),
    });
    assert.equal((await put()).status, 200);
    assert.equal(params[0], 'paul@example.com', 'sinon le login (qui met en minuscules) ne retrouve plus le compte');

    dup = true;
    assert.equal((await put()).status, 409);
  } finally { server.close(); }
});

test('SEC-13b friend-request : cible inexistante -> 404, course sur la paire -> 400', async () => {
  let mode = 'ghost';
  const db = fakeDb([
    [/SELECT \* FROM amis/, () => []],
    [/INSERT INTO amis/, () => {
      throw mode === 'ghost' ? mysqlError(1452, 'ER_NO_REFERENCED_ROW_2') : dupEntry();
    }],
  ]);
  const { server, url } = await listen(appWith((a) => a.use('/api', usersRouter(db))));
  try {
    assert.equal((await postJson(`${url}/api/friend-request`, { to_user_id: 999 }, PLAYER_7)).status, 404);
    mode = 'race';
    assert.equal((await postJson(`${url}/api/friend-request`, { to_user_id: 55 }, PLAYER_7)).status, 400);
    assert.equal((await postJson(`${url}/api/friend-request`, { to_user_id: 5.5 }, PLAYER_7)).status, 400, 'id non entier');
    assert.equal((await postJson(`${url}/api/friend-request`, { to_user_id: -3 }, PLAYER_7)).status, 400);
  } finally { server.close(); }
});
