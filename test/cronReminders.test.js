const { test } = require('node:test');
const assert = require('node:assert');
const CronService = require('../src/services/cronService');
const { fakeDb } = require('./helpers/fakeDb');

// SMTP_HOST absent -> emailService loggue et résout : on asserte sur le flux db.

function reminderDb() {
  let reminded = false;
  return fakeDb([
    // 2e run : la résa a déjà reminder_sent_at -> plus rien à envoyer
    [/SELECT r\.id/, () => (reminded ? [] : [{
      id: 51, start_time: '2030-06-15 10:00:00', end_time: '2030-06-15 11:00:00',
      email: 'p@x.fr', user_name: 'Paul', terrain_name: 'Padel 1', club_name: 'Club Test',
    }])],
    [/UPDATE reservations SET reminder_sent_at/, () => { reminded = true; return { affectedRows: 1 }; }],
    [/[\s\S]*/, () => []],
  ]);
}

test('BK-PAY-13 rappel J-1 : envoyé une seule fois, reminder_sent_at posé', async () => {
  const db = reminderDb();
  const cron = new CronService(db);

  const first = await cron.sendReservationReminders();
  assert.equal(first.sent, 1);
  const update = db.calls.find(c => /UPDATE reservations SET reminder_sent_at/.test(c.sql));
  assert.ok(update, 'reminder_sent_at doit être posé');
  assert.deepEqual(update.params, [51]);

  const second = await cron.sendReservationReminders();
  assert.equal(second.sent, 0, 'deuxième run: zéro renvoi');
});

test('BK-INF-06 db-cleanup : purge slots libres passés + tokens expirés seulement', async () => {
  const db = fakeDb([
    [/DELETE FROM slots/, () => ({ affectedRows: 12 })],
    [/DELETE FROM password_resets/, () => ({ affectedRows: 3 })],
    [/[\s\S]*/, () => ({})],
  ]);
  const cron = new CronService(db);
  const out = await cron.cleanupDatabase();
  assert.deepEqual(out, { slots: 12, tokens: 3 });
  const slotSql = db.calls.map(c => c.sql).find(s => /DELETE FROM slots/.test(s));
  assert.match(slotSql, /status = 'free'/, 'ne purge JAMAIS les slots réservés');
  assert.match(slotSql, /date < CURDATE\(\)/);
});
