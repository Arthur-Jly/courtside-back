const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const reviewsRouter = require('../src/routes/reviews');
const { errorHandler } = require('../src/middleware/errorHandler');

const PLAYER = { Authorization: `Bearer ${jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
const ADMIN_CLUB_1 = { Authorization: `Bearer ${jwt.sign({ id: 20, role: 'club_admin', club_id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };
const ADMIN_CLUB_2 = { Authorization: `Bearer ${jwt.sign({ id: 21, role: 'club_admin', club_id: 2 }, process.env.JWT_SECRET, { expiresIn: '5m' })}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', reviewsRouter(db));
  app.use(errorHandler);
  return app;
}

// ── BK-CLUB-01 : requireOwnClub — testé sur la réponse aux avis ─────────────
test('BK-CLUB-01 réponse à un avis : club_admin du BON club seulement', async () => {
  const db = fakeDb([
    [/SELECT club_id FROM reviews WHERE id/, () => [{ club_id: 1 }]],
    [/UPDATE reviews SET response/, () => ({ affectedRows: 1 })],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    // joueur -> 403
    let res = await fetch(`${url}/api/reviews/9/response`, {
      method: 'PUT', headers: { ...PLAYER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'Merci !' }),
    });
    assert.equal(res.status, 403);

    // admin d'un AUTRE club -> 403
    res = await fetch(`${url}/api/reviews/9/response`, {
      method: 'PUT', headers: { ...ADMIN_CLUB_2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'Merci !' }),
    });
    assert.equal(res.status, 403);

    // admin du club de l'avis -> 200
    res = await fetch(`${url}/api/reviews/9/response`, {
      method: 'PUT', headers: { ...ADMIN_CLUB_1, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: 'Merci !' }),
    });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

// ── BK-CLUB-06 : avis 1-5, un seul par cible, ownership ────────────────────
test('BK-CLUB-06 review : rating hors bornes -> 400, doublon même club -> 409', async () => {
  const db = fakeDb([
    [/SELECT id FROM reviews WHERE user_id = \? AND club_id/, () => [{ id: 4 }]], // déjà un avis
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/reviews`, { club_id: 1, rating: 6, comment: 'Top' }, PLAYER);
    assert.equal(res.status, 400, 'rating 6 refusé par Joi');

    res = await postJson(`${url}/api/reviews`, { rating: 5, comment: 'Top' }, PLAYER);
    assert.equal(res.status, 400, 'ni club ni lieu public -> 400');

    res = await postJson(`${url}/api/reviews`, { club_id: 1, rating: 5, comment: 'Top' }, PLAYER);
    assert.equal(res.status, 409, 'un seul avis par club et par user');
  } finally { server.close(); }
});

test('BK-CLUB-06b review créée puis modifiable par son auteur seul', async () => {
  let inserted = null;
  const db = fakeDb([
    [/SELECT id FROM reviews WHERE user_id/, () => []],
    [/INSERT INTO reviews/, (params) => { inserted = params; return { insertId: 12 }; }],
    [/SELECT user_id FROM reviews WHERE id/, () => [{ user_id: 999 }]], // avis d'un autre
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/reviews`, { club_id: 1, rating: 5, comment: 'Très bon club' }, PLAYER);
    assert.equal(res.status, 201);
    assert.deepEqual(inserted.slice(0, 4), [7, 1, null, 5]);

    // update d'un avis qui n'est pas à moi -> 403
    res = await fetch(`${url}/api/reviews/12`, {
      method: 'PUT', headers: { ...PLAYER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 1 }),
    });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});
