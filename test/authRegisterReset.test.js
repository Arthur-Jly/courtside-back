const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret-test-secret-test-secret!';
process.env.JWT_SECRET = JWT_SECRET;
process.env.BCRYPT_ROUNDS = '4'; // tests only

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const authRouter = require('../src/routes/auth');
const { errorHandler } = require('../src/middleware/errorHandler');

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter(db, JWT_SECRET));
  app.use(errorHandler);
  return app;
}

const REGISTER_BODY = {
  first_name: 'Léa', last_name: 'Marchand', username: 'lea123',
  email: 'lea@example.com', password: 'motdepasse1', role: 'player',
};

// ── BK-AUTH-06 ───────────────────────────────────────────────────────────────
test('BK-AUTH-06 register crée le user avec un hash bcrypt', async () => {
  let insertParams = null;
  const db = fakeDb([
    [/SELECT id FROM users WHERE email/, () => []],
    [/SELECT id FROM users WHERE username/, () => []],
    [/INSERT INTO users/, (params) => { insertParams = params; return { insertId: 31 }; }],
    [/SELECT id, name, email, role, club_id, username FROM users WHERE id/,
      () => [{ id: 31, name: 'Léa Marchand', email: 'lea@example.com', role: 'player', club_id: null, username: 'lea123' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/auth/register`, REGISTER_BODY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token, 'token renvoyé');
    assert.equal(jwt.verify(body.token, JWT_SECRET).id, 31);
    const hash = insertParams[2];
    assert.notEqual(hash, REGISTER_BODY.password);
    assert.match(hash, /^\$2b\$/);
    assert.ok(bcrypt.compareSync(REGISTER_BODY.password, hash));
  } finally { server.close(); }
});

// ── BK-AUTH-07 ───────────────────────────────────────────────────────────────
test('BK-AUTH-07 register refuse un email déjà utilisé -> 409', async () => {
  const db = fakeDb([[/SELECT id FROM users WHERE email/, () => [{ id: 1 }]]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/auth/register`, REGISTER_BODY);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /déjà utilisé/);
  } finally { server.close(); }
});

// ── BK-AUTH-08 ───────────────────────────────────────────────────────────────
test('BK-AUTH-08 register club_admin rattache le club existant', async () => {
  let insertParams = null;
  const db = fakeDb([
    [/SELECT id FROM users WHERE email/, () => []],
    [/SELECT id FROM users WHERE username/, () => []],
    [/SELECT id FROM clubs WHERE/, () => [{ id: 5 }]],
    [/INSERT INTO users/, (params) => { insertParams = params; return { insertId: 32 }; }],
    [/SELECT id, name, email, role, club_id, username FROM users WHERE id/,
      () => [{ id: 32, name: 'Ad Min', email: 'admin@club.fr', role: 'club_admin', club_id: 5, username: 'adminclub' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/auth/register`, {
      ...REGISTER_BODY, email: 'admin@club.fr', username: 'adminclub',
      role: 'club_admin', club_name: 'Club Test',
    });
    assert.equal(res.status, 200);
    assert.equal(insertParams[4], 5, 'club_id lié');
  } finally { server.close(); }
});

// ── BK-AUTH-10 ───────────────────────────────────────────────────────────────
test('BK-AUTH-10 forgot-password : token hashé en base, réponse générique toujours 200', async () => {
  let insertedHash = null;
  const db = fakeDb([
    [/SELECT id, email FROM users WHERE email/, (params) =>
      (params[0] === 'lea@example.com' ? [{ id: 31, email: 'lea@example.com' }] : [])],
    [/INSERT INTO password_resets/, (params) => { insertedHash = params[1]; return { insertId: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/auth/forgot-password`, { email: 'lea@example.com' });
    assert.equal(res.status, 200);
    assert.match(insertedHash, /^[a-f0-9]{64}$/, 'sha256 hex, jamais le token en clair');

    // email inconnu : même réponse, pas d'INSERT
    const before = db.calls.filter(c => /INSERT INTO password_resets/.test(c.sql)).length;
    res = await postJson(`${url}/api/auth/forgot-password`, { email: 'ghost@example.com' });
    assert.equal(res.status, 200);
    const after = db.calls.filter(c => /INSERT INTO password_resets/.test(c.sql)).length;
    assert.equal(after, before, 'aucun INSERT pour un email inconnu');
  } finally { server.close(); }
});

// ── BK-AUTH-11 ───────────────────────────────────────────────────────────────
test('BK-AUTH-11 reset-password : hash mis à jour, token consommé, rejeu -> 401', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let consumed = false;
  let newHash = null;
  const db = fakeDb([
    [/SELECT id, user_id FROM password_resets WHERE token_hash/, (params) =>
      (!consumed && params[0] === tokenHash ? [{ id: 7, user_id: 31 }] : [])],
    [/UPDATE users SET password_hash/, (params) => { newHash = params[0]; return { affectedRows: 1 }; }],
    [/UPDATE password_resets SET used_at/, () => { consumed = true; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/auth/reset-password`, { token, password: 'nouveaupass1' });
    assert.equal(res.status, 200);
    assert.ok(bcrypt.compareSync('nouveaupass1', newHash));

    // rejouer le même token -> refusé
    res = await postJson(`${url}/api/auth/reset-password`, { token, password: 'encoreautre1' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// ── BK-AUTH-12 ───────────────────────────────────────────────────────────────
test('BK-AUTH-12 reset-password : token expiré/inconnu -> 401', async () => {
  const db = fakeDb([[/SELECT id, user_id FROM password_resets/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/auth/reset-password`,
      { token: 'a'.repeat(64), password: 'nouveaupass1' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// ── BK-AUTH-13 : invitation gérant de club ───────────────────────────────────
test('BK-AUTH-13 GET /club-invitation/:token renvoie email + club, sans consommer', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const db = fakeDb([
    [/FROM club_invitations ci JOIN clubs c/, (params) =>
      (params[0] === tokenHash ? [{ email: 'g@club.fr', club_id: 9, club_name: 'Club Neuf' }] : [])],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/auth/club-invitation/${token}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.email, 'g@club.fr');
    assert.equal(body.clubName, 'Club Neuf');
  } finally { server.close(); }
});

test('BK-AUTH-14 accept-club-invitation crée un club_admin lié au club + consomme le token', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  let insertParams = null;
  let consumed = false;
  const db = fakeDb([
    [/SELECT id, club_id, email FROM club_invitations/, (params) =>
      (!consumed && params[0] === tokenHash ? [{ id: 3, club_id: 9, email: 'g@club.fr' }] : [])],
    [/SELECT id FROM users WHERE email/, () => []],
    [/SELECT id FROM users WHERE username/, () => []],
    [/INSERT INTO users/, (params) => { insertParams = params; return { insertId: 50 }; }],
    [/UPDATE club_invitations SET used_at/, () => { consumed = true; return { affectedRows: 1 }; }],
    [/SELECT id, name, email, role, club_id, username FROM users WHERE id/,
      () => [{ id: 50, name: 'Jean Gerant', email: 'g@club.fr', role: 'club_admin', club_id: 9, username: 'jean' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/auth/accept-club-invitation`, {
      token, first_name: 'Jean', last_name: 'Gerant', password: 'motdepasse1', username: 'jean',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, 'club_admin');
    assert.equal(body.club_id, 9, 'compte relié au club');
    assert.ok(body.token, 'auto-login');
    assert.equal(insertParams[3], 'club_admin', 'role inséré');
    assert.equal(insertParams[4], 9, 'club_id inséré');
    assert.equal(insertParams[1], 'g@club.fr', 'email pris depuis l\'invitation, pas la requête');

    // rejeu du même token -> 401
    res = await postJson(`${url}/api/auth/accept-club-invitation`, {
      token, first_name: 'Jean', last_name: 'Gerant', password: 'motdepasse1', username: 'autre',
    });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('BK-AUTH-15 accept-club-invitation refuse un email déjà utilisé -> 409', async () => {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const db = fakeDb([
    [/SELECT id, club_id, email FROM club_invitations/, (params) =>
      (params[0] === tokenHash ? [{ id: 3, club_id: 9, email: 'g@club.fr' }] : [])],
    [/SELECT id FROM users WHERE email/, () => [{ id: 12 }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/auth/accept-club-invitation`, {
      token, first_name: 'Jean', last_name: 'Gerant', password: 'motdepasse1', username: 'jean',
    });
    assert.equal(res.status, 409);
  } finally { server.close(); }
});
