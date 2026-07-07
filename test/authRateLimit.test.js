const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const JWT_SECRET = 'test-secret-test-secret-test-secret!';
process.env.JWT_SECRET = JWT_SECRET;

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const authRouter = require('../src/routes/auth');
const { errorHandler } = require('../src/middleware/errorHandler');

// Fichier dédié : le loginLimiter est partagé au niveau module, on a besoin
// d'un process propre pour compter les tentatives sans polluer les autres tests.

test('BK-AUTH-09 rate-limit login : 11e tentative -> 429', async () => {
  const db = fakeDb([[/SELECT \* FROM users WHERE email/, () => []]]); // toujours 401
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter(db, JWT_SECRET));
  app.use(errorHandler);
  const { server, url } = await listen(app);
  try {
    let last = null;
    for (let i = 1; i <= 11; i++) {
      last = await postJson(`${url}/api/auth/login`,
        { email: 'brute@force.fr', password: 'motdepasse1' });
      if (i <= 10) assert.equal(last.status, 401, `tentative ${i} -> 401`);
    }
    assert.equal(last.status, 429, '11e tentative bloquée');
    assert.match((await last.json()).error, /Trop de tentatives/);
  } finally { server.close(); }
});
