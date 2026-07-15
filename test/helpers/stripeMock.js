/**
 * Mock du module 'stripe' par injection dans require.cache.
 * - checkout.sessions.create/retrieve : spies fournis par le test
 * - webhooks : le VRAI module de signature Stripe (constructEvent +
 *   generateTestHeaderString) — on teste la vraie vérification de signature
 *   avec un secret de test connu.
 *
 * À installer AVANT d'appeler la factory du routeur payments (le contrôleur
 * fait require('stripe') à l'exécution de sa factory).
 */
const stripePath = require.resolve('stripe');
const realStripeFactory = require('stripe');

function installStripeMock({ create, retrieve } = {}) {
  const realInstance = realStripeFactory('sk_test_dummy_key_for_tests');
  const calls = { create: [], retrieve: [] };
  const instance = {
    checkout: {
      sessions: {
        create: async (payload) => {
          calls.create.push(payload);
          if (create) return create(payload);
          return { id: 'cs_test_mock_session_0001', url: 'https://checkout.stripe.com/pay/cs_test_mock' };
        },
        retrieve: async (id) => {
          calls.retrieve.push(id);
          if (retrieve) return retrieve(id);
          throw new Error('retrieve not stubbed');
        },
      },
    },
    webhooks: realInstance.webhooks, // vraie crypto de signature
  };
  require.cache[stripePath].exports = () => instance;
  return {
    instance,
    calls,
    uninstall() { require.cache[stripePath].exports = realStripeFactory; },
  };
}

/** Signature Stripe VALIDE pour un payload donné (secret de test). */
function signedHeader(payloadString, secret) {
  const real = realStripeFactory('sk_test_dummy_key_for_tests');
  return real.webhooks.generateTestHeaderString({ payload: payloadString, secret });
}

module.exports = { installStripeMock, signedHeader };
