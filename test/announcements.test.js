const { test } = require('node:test');
const assert = require('node:assert');
const AnnouncementsController = require('../src/controllers/announcements.controller');

/**
 * Fake db : dispatch par motif SQL, dans l'ordre de déclaration.
 * handlers = [[regex, (params) => résultat], ...]
 */
function fakeDb(handlers) {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      calls.push({ sql, params });
      for (const [re, respond] of handlers) {
        if (re.test(sql)) {
          try { return cb(null, respond(params, sql)); }
          catch (e) { return cb(e); }
        }
      }
      cb(new Error('Unexpected SQL in test: ' + sql.slice(0, 80)));
    },
  };
}

// ── Régression du découpage (juillet 2026) : les méthodes du mixin
//    announcementInvitations doivent rester sur le contrôleur. ─────────────
test('invitation mixin methods are present on the controller', () => {
  const c = new AnnouncementsController({ query() {} });
  for (const m of ['inviteFriends', 'shareSession', 'checkIfFriends', 'createInvitation',
    'getUserInvitations', 'acceptInvitation', 'declineInvitation', 'inviteFriendsWithMessages',
    'getOrCreatePrivateChat', 'sendInvitationMessage', 'respondToInvitation']) {
    assert.equal(typeof c[m], 'function', m + ' missing after split');
  }
});

// ── addParticipant ──────────────────────────────────────────────────────────
test('addParticipant rejects when the session is full (non-creator)', async () => {
  const db = fakeDb([
    [/SELECT id FROM annonce_participants/, () => []],
    [/SELECT places_disponibles FROM announcements/, () => [{ places_disponibles: 0 }]],
  ]);
  const c = new AnnouncementsController(db);
  await assert.rejects(c.addParticipant(1, 7), /Plus de places disponibles/);
});

test('addParticipant rejects a duplicate participant', async () => {
  const db = fakeDb([[/SELECT id FROM annonce_participants/, () => [{ id: 3 }]]]);
  const c = new AnnouncementsController(db);
  await assert.rejects(c.addParticipant(1, 7), /déjà à cette annonce/);
});

test('addParticipant inserts then decrements places_disponibles', async () => {
  const db = fakeDb([
    [/SELECT id FROM annonce_participants/, () => []],
    [/SELECT places_disponibles FROM announcements/, () => [{ places_disponibles: 2 }]],
    [/INSERT INTO annonce_participants/, () => ({ insertId: 55 })],
    [/UPDATE announcements SET places_disponibles = places_disponibles - 1/, () => ({})],
  ]);
  const c = new AnnouncementsController(db);
  const r = await c.addParticipant(1, 7);
  assert.equal(r.id, 55);
  assert.ok(db.calls.some(q => /places_disponibles - 1/.test(q.sql)));
});

// ── updateAnnouncement : ownership + whitelist de colonnes ─────────────────
test('updateAnnouncement rejects a non-creator', async () => {
  const db = fakeDb([
    [/SELECT .*created_by.* FROM announcements|SELECT \* FROM announcements/, () => [{ id: 1, created_by: 42, status: 'active' }]],
  ]);
  const c = new AnnouncementsController(db);
  await assert.rejects(c.updateAnnouncement(1, 7, { description: 'x' }), /Seul le créateur/);
});

test('updateAnnouncement only updates whitelisted fields', async () => {
  let updateSql = null;
  const db = fakeDb([
    [/UPDATE announcements SET/, (params, sql) => { updateSql = sql; return {}; }],
    [/FROM announcements/, () => [{ id: 1, created_by: 42, status: 'active' }]],
  ]);
  const c = new AnnouncementsController(db);
  c.getAnnouncementById = async () => ({ id: 1 }); // isolé du SELECT final
  await c.updateAnnouncement(1, 42, { description: 'ok', places_total: 99, created_by: 1 });
  assert.ok(updateSql, 'UPDATE must run');
  assert.ok(updateSql.includes('description = ?'));
  assert.ok(!updateSql.includes('places_total'), 'non-whitelisted field must be ignored');
  assert.ok(!updateSql.includes('created_by ='), 'creator must not be overwritable');
});

// ── invitations ─────────────────────────────────────────────────────────────
test('declineInvitation rejects when nothing was updated', async () => {
  const db = fakeDb([[/UPDATE annonce_invitations SET status/, () => ({ affectedRows: 0 })]]);
  const c = new AnnouncementsController(db);
  await assert.rejects(c.declineInvitation(9, 7), /introuvable ou déjà traitée/);
});

test('declineInvitation resolves when the pending invitation is updated', async () => {
  const db = fakeDb([[/UPDATE annonce_invitations SET status/, () => ({ affectedRows: 1 })]]);
  const c = new AnnouncementsController(db);
  const r = await c.declineInvitation(9, 7);
  assert.equal(r.success, true);
});

test('checkIfFriends is true only for an accepted friendship (both directions)', async () => {
  const dbYes = fakeDb([[/FROM amis/, () => [{ id: 1 }]]]);
  const dbNo = fakeDb([[/FROM amis/, () => []]]);
  assert.equal(await new AnnouncementsController(dbYes).checkIfFriends(1, 2), true);
  assert.equal(await new AnnouncementsController(dbNo).checkIfFriends(1, 2), false);
});
