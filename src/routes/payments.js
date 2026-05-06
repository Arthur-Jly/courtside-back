const express = require('express');

module.exports = function(db){
  const router = express.Router();
  const controller = require('../controllers/payments.controller')(db);

  // Créer une session de paiement Stripe Checkout
  router.post('/payments/create-checkout-session', controller.createCheckoutSession);

  // Webhook pour recevoir les événements Stripe
  router.post('/payments/webhook', express.raw({ type: 'application/json' }), controller.handleWebhook);

  // Route de callback après paiement (pour dev sans webhook)
  router.post('/payments/confirm-payment', controller.confirmPayment);

  // Récupérer les détails d'une session
  router.get('/payments/session/:sessionId', controller.getSessionDetails);

  return router;
};
