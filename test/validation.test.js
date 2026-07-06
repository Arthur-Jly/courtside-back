const { test } = require('node:test');
const assert = require('node:assert');
const { schemas } = require('../src/middleware/validation');

test('register schema accepts a valid payload', () => {
  const { error, value } = schemas.register.validate({
    first_name: 'Léa', last_name: 'Marchand',
    email: 'LEA@Example.com', password: 'motdepasse1',
    role: 'player', username: 'lea123',
  });
  assert.equal(error, undefined);
  assert.equal(value.email, 'lea@example.com'); // lowercased
});

test('register schema rejects weak passwords', () => {
  for (const password of ['court1', 'sanschiffres', '12345678']) {
    const { error } = schemas.register.validate({
      first_name: 'Léa', last_name: 'Marchand',
      email: 'lea@example.com', password,
      role: 'player', username: 'lea123',
    });
    assert.ok(error, `expected "${password}" to be rejected`);
  }
});

test('register schema rejects unknown roles', () => {
  const { error } = schemas.register.validate({
    first_name: 'A', last_name: 'B',
    email: 'a@b.com', password: 'motdepasse1',
    role: 'super_admin', username: 'abc',
  });
  assert.ok(error);
});

test('forgotPassword schema requires a valid email', () => {
  assert.equal(schemas.forgotPassword.validate({ email: 'a@b.fr' }).error, undefined);
  assert.ok(schemas.forgotPassword.validate({ email: 'nope' }).error);
});

test('resetPassword schema requires a 64-char hex token and strong password', () => {
  const token = 'a'.repeat(64);
  assert.equal(schemas.resetPassword.validate({ token, password: 'motdepasse1' }).error, undefined);
  assert.ok(schemas.resetPassword.validate({ token: 'short', password: 'motdepasse1' }).error);
  assert.ok(schemas.resetPassword.validate({ token, password: 'faible' }).error);
});

test('validation strips unknown fields', () => {
  const { value } = schemas.login.validate(
    { email: 'a@b.fr', password: 'x', injected: 'evil' },
    { stripUnknown: true }
  );
  assert.equal(value.injected, undefined);
});
