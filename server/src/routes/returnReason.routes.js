const express = require('express');
const ctrl = require('../controllers/returnReason.controller');
const validate = require('../middleware/validate');
const { protect, adminOnly } = require('../middleware/auth');
const { returnReasonRules, objectId } = require('../validators');

const router = express.Router();

// Signed in, but not admin-only: the storefront's return dialog reads this list.
router.use(protect);
router.get('/', ctrl.listReasons);

router.use(adminOnly);
router.post('/', returnReasonRules, validate, ctrl.createReason);
router.patch('/:id', objectId('id'), returnReasonRules, validate, ctrl.updateReason);
router.delete('/:id', objectId('id'), validate, ctrl.deleteReason);

module.exports = router;
