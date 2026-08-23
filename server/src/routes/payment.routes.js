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

router.post('/:id/refund', protect, adminOnly, objectId('id'), paymentRefundRules, validate, ctrl.refund);

module.exports = router;
