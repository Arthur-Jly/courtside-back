const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-secret-test-secret-test-secret!'; // >= 32 chars
process.env.JWT_SECRET = JWT_SECRET;

const authRouter = require('../src/routes/auth');
const { errorHandler } = require('../src/middleware/errorHandler');

const PASSWORD = 'motdepasse1';
const HASH = bcrypt.hashSync(PASSWORD, 4); // rounds faibles: test only

const USER_ROW = {
  id: 12, name: 'Léa Marchand', email: 'lea@example.com',
  password_hash: HASH, role: 'player', club_id: null, username: 'lea123',
};

function makeApp(rows) {
  const db = {
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      if (/SELECT \* FROM users WHERE email/.test(sql)) return cb(null, rows);
      if (/FROM users WHERE id/.test(sql)) return cb(null, rows);
      return cb(null, []);
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter(db, JWT_SECRET));
  app.use(errorHandler);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function postLogin(url, body) {
  return fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('login returns a valid JWT for correct credentials', async () => {
  const { server, url } = await listen(makeApp([USER_ROW]));
  try {
    const res = await postLogin(url, { email: 'lea@example.com', password: PASSWORD });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 12);
    assert.ok(!('password_hash' in body), 'hash must never leak');
    const decoded = jwt.verify(body.token, JWT_SECRET);
    assert.equal(decoded.id, 12);
    assert.equal(decoded.role, 'player');
  } finally { server.close(); }
});

test('login rejects a wrong password with 401', async () => {
  const { server, url } = await listen(makeApp([USER_ROW]));
  try {
    const res = await postLogin(url, { email: 'lea@example.com', password: 'mauvaispass1' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('login rejects an unknown email with 401 (no user enumeration)', async () => {
  const { server, url } = await listen(makeApp([]));
  try {
    const res = await postLogin(url, { email: 'ghost@example.com', password: PASSWORD });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).toLowerCase().includes('introuvable'),
      'same message for unknown email and wrong password');
  } finally { server.close(); }
});

test('GET /me validates the bearer token and returns the fresh user', async () => {
  const { server, url } = await listen(makeApp([USER_ROW]));
  try {
    const token = jwt.sign({ id: 12, role: 'player' }, JWT_SECRET, { expiresIn: '5m' });
    const res = await fetch(`${url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const me = await res.json();
    assert.equal(me.id, 12);
  } finally { server.close(); }
});

test('GET /me rejects a bad token with 401', async () => {
  const { server, url } = await listen(makeApp([USER_ROW]));
  try {
    const res = await fetch(`${url}/api/auth/me`, { headers: { Authorization: 'Bearer forged.token.here' } });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});
