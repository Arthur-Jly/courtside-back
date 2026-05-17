const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const paymentsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = function paymentsRouter(db) {
  const router = express.Router();
  const controller = require('../controllers/payments.controller')(db);

  router.post('/payments/create-checkout-session', requireAuth, paymentsLimiter, asyncHandler(controller.createCheckoutSession));
  router.post('/payments/confirm-payment', optionalAuth, paymentsLimiter, asyncHandler(controller.confirmPayment));
  router.get('/payments/session/:sessionId', requireAuth, paymentsLimiter, asyncHandler(controller.getSessionDetails));

  return router;
};

// Webhook mounted separately with raw body before express.json().
module.exports.webhook = function webhookRouter(db) {
  const router = express.Router();
  const controller = require('../controllers/payments.controller')(db);
  router.post(
    '/payments/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    asyncHandler(controller.handleWebhook),
  );
  return router;
};
