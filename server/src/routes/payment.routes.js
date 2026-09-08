const express = require('express');
const ctrl = require('../controllers/payment.controller');
const validate = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { verifyPaymentRules, paymentRefundRules, objectId } = require('../validators');

const router = express.Router();

router.get('/config', ctrl.getConfig);

router.post('/create-order', protect, ctrl.createPaymentOrder);
router.post('/verify', protect, verifyPaymentRules, validate, ctrl.verifyPayment);
router.post('/failed', protect, ctrl.recordFailure);

/**
 * The webhook delivery ledger. Read-only for support, plus a replay for the case
 * Razorpay's own retries have already given up on.
 *
 * Declared before `/:id/refund` so `webhook-events` is never swallowed by the
 * ObjectId route below it.
 *
 * The webhook endpoint itself is NOT mounted here: it needs the raw request body
 * for signature verification, so app.js mounts it ahead of the JSON parser.
 */
router.get('/webhook-events', protect, adminOnly, ctrl.listWebhookEvents);
router.post(
  '/webhook-events/:id/replay',
  protect,
  adminOnly,
  objectId('id'),
  ctrl.replayWebhookEvent
);

router.post('/:id/refund', protect, adminOnly, objectId('id'), paymentRefundRules, validate, ctrl.refund);

module.exports = router;
