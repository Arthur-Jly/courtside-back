const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const paymentsModule = require('../src/routes/payments');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

const noopDb = { query(sql, params, cb) { (cb || params)(null, []); } };

test('webhook returns 503 when Stripe is not configured', async () => {
  delete process.env.PRIVATE_STRIPE_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const app = express();
  app.use('/api', paymentsModule.webhook(noopDb));
  const { server, url } = await listen(app);
  try {
    const res = await fetch(`${url}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 503);
  } finally { server.close(); }
});

test('webhook rejects an invalid Stripe signature with 400', async () => {
  process.env.PRIVATE_STRIPE_KEY = 'sk_test_dummy_key_for_tests';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy_secret';
  const app = express();
  app.use('/api', paymentsModule.webhook(noopDb));
  const { server, url } = await listen(app);
  try {
    // Sans header stripe-signature valide, constructEvent doit jeter -> 400.
    const res = await fetch(`${url}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=forged' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Invalid signature/);
  } finally {
    server.close();
    delete process.env.PRIVATE_STRIPE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});
