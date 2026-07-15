const { test } = require('node:test');
const assert = require('node:assert');
const CronService = require('../src/services/cronService');

// SMTP_HOST absent -> emailService loggue et résout : on asserte sur le flux db.

function reminderDb() {
  let reminded = false;
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      calls.push({ sql, params });
      if (/SELECT r\.id/.test(sql)) {
        // 2e run : la résa a déjà reminder_sent_at -> plus rien à envoyer
        return cb(null, reminded ? [] : [{
          id: 51, start_time: '2030-06-15 10:00:00', end_time: '2030-06-15 11:00:00',
          email: 'p@x.fr', user_name: 'Paul', terrain_name: 'Padel 1', club_name: 'Club Test',
        }]);
      }
      if (/UPDATE reservations SET reminder_sent_at/.test(sql)) {
        reminded = true;
        return cb(null, { affectedRows: 1 });
      }
      cb(null, []);
    },
  };
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
  const calls = [];
  const db = {
    query(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      calls.push(sql);
      if (/DELETE FROM slots/.test(sql)) return cb(null, { affectedRows: 12 });
      if (/DELETE FROM password_resets/.test(sql)) return cb(null, { affectedRows: 3 });
      cb(null, {});
    },
  };
  const cron = new CronService(db);
  const out = await cron.cleanupDatabase();
  assert.deepEqual(out, { slots: 12, tokens: 3 });
  const slotSql = calls.find(s => /DELETE FROM slots/.test(s));
  assert.match(slotSql, /status = 'free'/, 'ne purge JAMAIS les slots réservés');
  assert.match(slotSql, /date < CURDATE\(\)/);
});
