const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/apiResponse');
const { ReturnReason, Setting } = require('../models');
const broadcast = require('../realtime/broadcast');
const { DEFAULT_REASONS } = require('../models/ReturnReason');
const {
  nextDisplayOrder,
  parseRequestedOrder,
  resequence,
  placeAndResequence,
} = require('../utils/displayOrder');

/**
 * The twin of cancellationReason.controller.js, deliberately line for line: the
 * two picklists are curated through one admin component and read by two dialogs
 * that behave identically, so the endpoints behind them answer the same calls in
 * the same order.
 *
 * Plants the starter list the very first time anybody asks for it, so the return
 * dialog is usable before an admin has opened the screen. The flag lives on the
 * settings singleton rather than being inferred from "the collection is empty" —
 * otherwise an admin who deliberately cleared the list would find it back on the
 * next page load.
 */
let seedChecked = false;

async function seedOnce() {
  // The flag is durable; this one just saves a settings read per request once the
  // process has already established that the planting is done.
  if (seedChecked) return;

  const settings = await Setting.getSingleton();
  if (settings.seeded?.returnReasons) {
    seedChecked = true;
    return;
  }

  if ((await ReturnReason.estimatedDocumentCount()) === 0) {
    await ReturnReason.insertMany(
      DEFAULT_REASONS.map((label, index) => ({ label, displayOrder: index }))
    );
  }

  settings.set('seeded.returnReasons', true);
  await settings.save();
  seedChecked = true;
}

/**
 * GET /return-reasons — the shopper's picklist.
 *
 * `?adminView=true` from an admin returns the inactive rows too, which is what
 * the management screen edits. Everyone else sees only what they may pick.
 */
exports.listReasons = asyncHandler(async (req, res) => {
  await seedOnce();

  const isAdminView = req.query.adminView === 'true' && req.user?.role === 'admin';

  // Rows written before the numbering was enforced can still carry gaps or a
  // shared number. The management screen is the only place those figures are
  // visible, so healing them as it opens costs nothing. A no-op once clean.
  if (isAdminView) await resequence(ReturnReason);

  const reasons = await ReturnReason.find(isAdminView ? {} : { isActive: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .lean();

  return sendSuccess(res, { message: 'Return reasons fetched', data: { reasons } });
});

/**
 * POST /return-reasons (admin)
 *
 * A position another reason already holds is an instruction, not a clash: the
 * newcomer takes it and the incumbent — with everything below — slides down one.
 * Sending no order lands the reason at the end, which is what the panel proposes.
 */
exports.createReason = asyncHandler(async (req, res) => {
  const { label, isActive } = req.body;

  const requestedOrder = parseRequestedOrder(req.body.displayOrder);
  const reason = await ReturnReason.create({
    label,
    isActive,
    displayOrder: requestedOrder ?? (await nextDisplayOrder(ReturnReason)),
  });

  await placeAndResequence(ReturnReason, {}, reason, requestedOrder);
  broadcast.returnReasonChanged('created', reason);

  return sendSuccess(res, { statusCode: 201, message: 'Reason added', data: { reason } });
});

/** PATCH /return-reasons/:id (admin) */
exports.updateReason = asyncHandler(async (req, res) => {
  const reason = await ReturnReason.findById(req.params.id);
  if (!reason) throw ApiError.notFound('Reason not found');

  // A patch that never mentions the order is not a move — the status chip flips
  // the switch alone, and that must not shuffle the list.
  const requestedOrder = parseRequestedOrder(req.body.displayOrder);

  const { label, isActive } = req.body;
  if (label !== undefined) reason.label = label;
  if (isActive !== undefined) reason.isActive = isActive;
  await reason.save();

  await placeAndResequence(ReturnReason, {}, reason, requestedOrder);
  broadcast.returnReasonChanged('updated', reason);

  return sendSuccess(res, { message: 'Reason updated', data: { reason } });
});

/**
 * DELETE /return-reasons/:id (admin)
 *
 * Returns that already quoted this reason keep their own copy of the text, so
 * removing a row only changes what future shoppers are offered.
 */
exports.deleteReason = asyncHandler(async (req, res) => {
  const reason = await ReturnReason.findById(req.params.id);
  if (!reason) throw ApiError.notFound('Reason not found');

  await reason.deleteOne();
  await resequence(ReturnReason);
  broadcast.returnReasonChanged('deleted', reason);

  return sendSuccess(res, { message: 'Reason deleted' });
});
