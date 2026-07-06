const { test } = require('node:test');
const assert = require('node:assert');
const sseHub = require('../src/services/sseHub');

function fakeRes() {
  const frames = [];
  return { frames, write: (f) => frames.push(f) };
}

test('push delivers an SSE frame to every connection of a user', () => {
  const a = fakeRes();
  const b = fakeRes();
  sseHub.addClient(101, a);
  sseHub.addClient(101, b);
  sseHub.push(101, 'notification', { type: 'x' });
  for (const r of [a, b]) {
    assert.equal(r.frames.length, 1);
    assert.ok(r.frames[0].startsWith('event: notification\n'));
    assert.ok(r.frames[0].includes('"type":"x"'));
  }
  sseHub.removeClient(101, a);
  sseHub.removeClient(101, b);
});

test('push is a no-op for offline users', () => {
  assert.doesNotThrow(() => sseHub.push(999999, 'message', { chat_id: 1 }));
});

test('removeClient stops further delivery and prunes the user', () => {
  const r = fakeRes();
  sseHub.addClient(202, r);
  sseHub.removeClient(202, r);
  sseHub.push(202, 'message', {});
  assert.equal(r.frames.length, 0);
});

test('a failing write on one connection does not block the others', () => {
  const bad = { write: () => { throw new Error('closed'); } };
  const good = fakeRes();
  sseHub.addClient(303, bad);
  sseHub.addClient(303, good);
  assert.doesNotThrow(() => sseHub.push(303, 'notification', {}));
  assert.equal(good.frames.length, 1);
  sseHub.removeClient(303, bad);
  sseHub.removeClient(303, good);
});
