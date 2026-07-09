const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!';

const { fakeDb } = require('./helpers/fakeDb');
const { listen, postJson } = require('./helpers/testServer');
const chatsRouter = require('../src/routes/chats');
const { errorHandler } = require('../src/middleware/errorHandler');

const TOKEN = jwt.sign({ id: 7, role: 'player', name: 'Paul' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', chatsRouter(db));
  app.use(errorHandler);
  return app;
}

// ── BK-CHAT-01 : chat privé idempotent ──────────────────────────────────────
test('BK-CHAT-01 création chat privé : 2 appels même paire -> même chat', async () => {
  let created = null;
  const db = fakeDb([
    [/SELECT \* FROM chats\s+WHERE type = 'private'/, () => (created ? [created] : [])],
    [/SELECT status FROM amis/, () => [{ status: 'accepted' }]],
    [/INSERT INTO chats/, () => { created = { id: 88, type: 'private', status: 'accepted' }; return { insertId: 88 }; }],
    [/INSERT INTO chat_participants/, () => ({})],
    [/SELECT \* FROM chats WHERE id/, () => [created]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/chats`, { user_id_2: 55 }, AUTH);
    assert.equal((await res.json()).id, 88);
    res = await postJson(`${url}/api/chats`, { user_id_2: 55 }, AUTH);
    assert.equal((await res.json()).id, 88);
    assert.equal(db.calls.filter(c => /INSERT INTO chats\b/.test(c.sql)).length, 1, 'un seul chat');
  } finally { server.close(); }
});

test('BK-CHAT-01b chat avec soi-même ou id invalide -> 400', async () => {
  const { server, url } = await listen(makeApp(fakeDb([])));
  try {
    let res = await postJson(`${url}/api/chats`, { user_id_2: 7 }, AUTH);
    assert.equal(res.status, 400);
    res = await postJson(`${url}/api/chats`, { user_id_2: 'abc' }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('BK-CHAT-01c non-amis -> chat créé en statut pending', async () => {
  let insertedStatus = null;
  const db = fakeDb([
    [/SELECT \* FROM chats\s+WHERE type = 'private'/, () => []],
    [/SELECT status FROM amis/, () => []], // pas amis
    [/INSERT INTO chats/, (params) => { insertedStatus = params[0]; return { insertId: 89 }; }],
    [/INSERT INTO chat_participants/, () => ({})],
    [/SELECT \* FROM chats WHERE id/, () => [{ id: 89, status: insertedStatus }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    await postJson(`${url}/api/chats`, { user_id_2: 55 }, AUTH);
    assert.equal(insertedStatus, 'pending', 'demande de contact, pas de spam direct');
  } finally { server.close(); }
});

// ── BK-CHAT-03 : accès réservé aux participants ─────────────────────────────
test('BK-CHAT-03 non-participant : messages/envoi/mark-read -> 403', async () => {
  const db = fakeDb([[/SELECT 1 AS ok FROM chat_participants/, () => []]]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await fetch(`${url}/api/chats/9/messages`, { headers: AUTH });
    assert.equal(res.status, 403);
    res = await postJson(`${url}/api/chats/9/messages`, { content: 'hey' }, AUTH);
    assert.equal(res.status, 403);
    res = await postJson(`${url}/api/chats/9/mark-read`, {}, AUTH);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

// ── BK-CHAT-04 : contenu des messages ───────────────────────────────────────
function memberDb(extra = []) {
  return fakeDb([
    [/SELECT 1 AS ok FROM chat_participants/, () => [{ ok: 1 }]],
    ...extra,
    [/SELECT user_id FROM chat_participants WHERE chat_id = \? AND user_id !=/, () => [{ user_id: 55 }]],
  ]);
}

test('BK-CHAT-04 message vide sans fichier -> 400 ; texte -> stocké', async () => {
  let inserted = null;
  const db = memberDb([[/INSERT INTO messages/, (params) => { inserted = params; return { insertId: 101 }; }]]);
  const { server, url } = await listen(makeApp(db));
  try {
    let res = await postJson(`${url}/api/chats/9/messages`, { content: '   ' }, AUTH);
    assert.equal(res.status, 400);

    res = await postJson(`${url}/api/chats/9/messages`, { content: 'Salut !' }, AUTH);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message_id, 101);
    assert.equal(inserted[2], 'Salut !');
    assert.equal(inserted[5], 'text');
  } finally { server.close(); }
});

test('BK-CHAT-04b booking_request : metadata JSON stockée avec le bon type', async () => {
  let inserted = null;
  const db = memberDb([[/INSERT INTO messages/, (params) => { inserted = params; return { insertId: 102 }; }]]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/chats/9/messages`, {
      message_type: 'booking_request',
      booking_data: { court_name: 'Padel 1', date: '2030-06-15', time: '10:00', price: 30 },
    }, AUTH);
    assert.equal(res.status, 200);
    assert.equal(inserted[5], 'booking_request');
    assert.deepEqual(JSON.parse(inserted[6]), { court_name: 'Padel 1', date: '2030-06-15', time: '10:00', price: 30 });
  } finally { server.close(); }
});

test('BK-CHAT-04c contenu tronqué à 4000 caractères', async () => {
  let inserted = null;
  const db = memberDb([[/INSERT INTO messages/, (params) => { inserted = params; return { insertId: 103 }; }]]);
  const { server, url } = await listen(makeApp(db));
  try {
    await postJson(`${url}/api/chats/9/messages`, { content: 'a'.repeat(5000) }, AUTH);
    assert.equal(inserted[2].length, 4000);
  } finally { server.close(); }
});

// ── BK-CHAT-05 : mark-read ──────────────────────────────────────────────────
test('BK-CHAT-05 mark-read : last_read_at posé pour le user seul', async () => {
  let updateParams = null;
  const db = fakeDb([
    [/SELECT 1 AS ok FROM chat_participants/, () => [{ ok: 1 }]],
    [/UPDATE chat_participants SET last_read_at/, (params) => { updateParams = params; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await postJson(`${url}/api/chats/9/mark-read`, {}, AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(updateParams, [9, 7]);
  } finally { server.close(); }
});

// ── BK-CHAT-06 : accept d'un chat pending ───────────────────────────────────
test('BK-CHAT-06 accept : passe pending -> accepted, participants seulement', async () => {
  let acceptSql = null;
  const db = fakeDb([
    [/SELECT 1 AS ok FROM chat_participants/, () => [{ ok: 1 }]],
    [/UPDATE chats SET status = 'accepted'/, (params, sql) => { acceptSql = sql; return { affectedRows: 1 }; }],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    const res = await fetch(`${url}/api/chats/9/accept`, { method: 'PUT', headers: AUTH });
    assert.equal(res.status, 200);
    assert.match(acceptSql, /status = 'pending'/, "n'écrase pas un statut déjà tranché");
  } finally { server.close(); }
});

// ── BK-CHAT-07 : groupe via friends picker ──────────────────────────────────
test('BK-CHAT-07 création groupe : créateur admin, membres dédupliqués, bornes', async () => {
  let participantsParams = null;
  const db = fakeDb([
    [/INSERT INTO chats/, () => ({ insertId: 90 })],
    [/INSERT INTO chat_participants/, (params) => { participantsParams = params; return {}; }],
    [/SELECT \* FROM chats WHERE id/, () => [{ id: 90, type: 'group', name: 'La team' }]],
  ]);
  const { server, url } = await listen(makeApp(db));
  try {
    // doublons + créateur dans la liste -> nettoyés
    let res = await postJson(`${url}/api/chats/group`, { name: 'La team', member_ids: [55, 55, 7, 56] }, AUTH);
    assert.equal(res.status, 201);
    // params: [90, 7, 'admin', 90, 55, 'member', 90, 56, 'member']
    assert.deepEqual(participantsParams.slice(0, 3), [90, 7, 'admin']);
    assert.equal(participantsParams.length, 9, 'créateur + 2 membres uniques');

    res = await postJson(`${url}/api/chats/group`, { name: '', member_ids: [55] }, AUTH);
    assert.equal(res.status, 400);
    res = await postJson(`${url}/api/chats/group`, { name: 'X', member_ids: [] }, AUTH);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});
