const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, paginationMeta } = require('../utils/apiResponse');
const { Order, Payment, Cart, WebhookEvent } = require('../models');
const env = require('../config/env');
const { releaseStock } = require('../services/inventory.service');
const { redeemForOrder, releaseForOrder } = require('../services/coupon.service');
const razorpay = require('../services/razorpay.service');
const razorpayWebhook = require('../services/razorpayWebhook.service');
const mailService = require('../services/mail.service');
const broadcast = require('../realtime/broadcast');
const logger = require('../utils/logger');

/**
 * GET /payments/config — public key + enabled flag for the checkout widget.
 *
 * `downtime` is whatever the downtime webhooks last reported as broken. Checkout
 * uses it to say "UPI is having trouble right now" *before* the shopper picks it,
 * which turns a failed payment they cannot explain into a choice they can make.
 * It is empty whenever those events are not subscribed to, and checkout simply
 * shows no warning — nothing depends on it being there.
 */
exports.getConfig = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Payment config fetched',
    data: {
      enabled: razorpay.isEnabled(),
      keyId: razorpay.keyId || null,
      currency: 'INR',
      downtime: razorpayWebhook.getActiveDowntimes(),
    },
  })
);

/** POST /payments/create-order  { orderId } */
exports.createPaymentOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.body.orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (String(order.user) !== String(req.user._id)) throw ApiError.forbidden();
  if (order.paymentStatus === 'paid') throw ApiError.badRequest('This order is already paid');
  if (order.orderStatus === 'cancelled') throw ApiError.badRequest('This order was cancelled');

  const rzpOrder = await razorpay.createOrder({
    amount: order.pricing.total,
    receipt: order.orderNumber,
    notes: { orderId: String(order._id), userId: String(req.user._id) },
  });

  const payment = await Payment.create({
    order: order._id,
    user: req.user._id,
    provider: 'razorpay',
    razorpayOrderId: rzpOrder.id,
    amount: order.pricing.total,
    status: 'created',
  });

  order.payment = payment._id;
  await order.save();

  return sendSuccess(res, {
    message: 'Payment initiated',
    data: {
      keyId: razorpay.keyId,
      razorpayOrderId: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      orderNumber: order.orderNumber,
      prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone || '' },
    },
  });
});

/**
 * POST /payments/verify — the client hands back what Razorpay's checkout returned.
 * Nothing is trusted until the HMAC signature matches.
 */
exports.verifyPayment = asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, signature, orderId } = req.body;

  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (String(order.user) !== String(req.user._id)) throw ApiError.forbidden();

  const payment = await Payment.findOne({ order: order._id, razorpayOrderId });
  if (!payment) throw ApiError.badRequest('No matching payment attempt found for this order');

  const valid = razorpay.verifySignature({ razorpayOrderId, razorpayPaymentId, signature });

  if (!valid) {
    payment.status = 'failed';
    payment.errorDescription = 'Signature verification failed';
    await payment.save();

    order.paymentStatus = 'failed';
    await order.save();

    broadcast.paymentUpdated(order, payment);
    throw ApiError.badRequest('Payment verification failed. If money was debited it will be refunded.');
  }

  /**
   * Confirm the amount with Razorpay directly rather than believing the client.
   *
   * A failed lookup is not a pass. The signature covers the order and payment ids
   * and nothing else — it says this pair is genuine, never that the right sum was
   * captured — so skipping the amount check when the fetch happened to fail was
   * the difference between "verified" and "signed". The order simply stays
   * pending: the webhook is the other half of this flow and settles it from
   * Razorpay's own account of what was captured, with no client in the middle.
   */
  let providerPayment = null;
  try {
    providerPayment = await razorpay.fetchPayment(razorpayPaymentId);
  } catch (err) {
    logger.warn(`Could not fetch Razorpay payment ${razorpayPaymentId}: ${err.message}`);
  }

  if (!providerPayment) {
    throw ApiError.serviceUnavailable(
      'We could not confirm this payment with the provider just now. If money was debited, ' +
        'your order will be updated automatically within a few minutes.'
    );
  }

  if (providerPayment.amount !== razorpay.toPaise(order.pricing.total)) {
    payment.status = 'failed';
    payment.errorDescription = 'Amount mismatch';
    await payment.save();
    throw ApiError.badRequest('Payment amount does not match the order total');
  }

  payment.razorpayPaymentId = razorpayPaymentId;
  payment.razorpaySignature = signature;
  payment.status = 'captured';
  payment.method = providerPayment?.method;
  payment.rawResponse = providerPayment || undefined;
  await payment.save();

  order.paymentStatus = 'paid';
  if (order.orderStatus === 'pending') {
    order.orderStatus = 'confirmed';
    order.statusHistory.push({
      status: 'confirmed',
      note: 'Payment received',
      changedBy: req.user._id,
      actor: 'customer',
    });
  }
  await order.save();

  // The money landed, so the order is earned and its coupon is now spent. The
  // flag inside redeemForOrder makes this exactly-once: a shopper who refreshes
  // into a second /verify, or a webhook that lands after this one, changes
  // nothing. If the coupon filled up store-wide while this shopper was paying we
  // honour the discount they were charged and only log it — refusing money that
  // has already been captured would be the worse failure.
  if ((await redeemForOrder(order)) === 'exhausted') {
    logger.warn(
      `Order ${order.orderNumber} paid with ${order.pricing.couponCode} after its usage limit filled; discount honoured`
    );
  }

  // Only the purchased lines leave the cart; "saved for later" survives checkout.
  await Cart.updateOne(
    { user: req.user._id },
    { $pull: { items: { savedForLater: { $ne: true } } }, $unset: { coupon: 1 } }
  );

  mailService
    .sendOrderConfirmationEmail({ to: req.user.email, name: req.user.name, order })
    .catch(() => {});

  broadcast.paymentUpdated(order, payment);
  broadcast.orderStatusChanged(order, 'Payment received');
  broadcast.cartUpdated(req.user._id, null, { originSocketId: req.get('x-socket-id') });

  return sendSuccess(res, { message: 'Payment successful', data: { order, payment } });
});

/** POST /payments/failed — records an abandoned/failed attempt and frees the stock. */
exports.recordFailure = asyncHandler(async (req, res) => {
  const { orderId, razorpayOrderId, code, description } = req.body;

  const order = await Order.findById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (String(order.user) !== String(req.user._id)) throw ApiError.forbidden();

  await Payment.updateOne(
    { order: order._id, ...(razorpayOrderId ? { razorpayOrderId } : {}) },
    { status: 'failed', errorCode: code, errorDescription: description }
  );

  if (order.paymentStatus !== 'paid') {
    order.paymentStatus = 'failed';
    await order.save();
    broadcast.paymentUpdated(order, null);
  }

  return sendSuccess(res, { message: 'Payment failure recorded', data: { order } });
});

/**
 * POST /payments/webhook — Razorpay's server-to-server callback.
 *
 * This is the authoritative account of what happened to the money. The browser's
 * /payments/verify call is faster and is what the shopper watches, but it only
 * exists while their tab does; this arrives regardless, is retried until it is
 * acknowledged, and is the only channel that reports refunds, chargebacks and
 * gateway downtime at all.
 *
 * Four things happen here and nothing else — the meaning of each event lives in
 * razorpayWebhook.service:
 *
 *   1. Verify the HMAC over the *raw* bytes. app.js mounts express.raw ahead of the
 *      JSON parser for this one path precisely so those bytes still exist: re-
 *      serialising a parsed object reorders keys and the signature stops matching.
 *   2. Claim the delivery by event id. The unique index on WebhookEvent.eventId is
 *      the lock, so two instances handed the same retry in the same second process
 *      it exactly once.
 *   3. Dispatch.
 *   4. Answer. 2xx means "we have it, stop retrying", and everything Razorpay could
 *      usefully retry — and only that — is answered 500.
 *
 * The status codes are deliberate. An invalid signature is 400 and is never
 * retried; an event we do not act on is still 200, because asking Razorpay to
 * redeliver something we will ignore again just burns its retry budget; a handler
 * that threw is 500, so the delivery comes back and the ledger row it left behind
 * is re-run rather than skipped as a duplicate.
 */
exports.webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody;

  if (!env.razorpay.webhookSecret) {
    // Answering 200 here would let a misconfigured deployment look healthy in the
    // dashboard while silently dropping every payment update.
    logger.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set');
    return res.status(503).json({ success: false, message: 'Webhook not configured' });
  }

  if (!rawBody || !razorpay.verifyWebhookSignature(rawBody, signature)) {
    logger.warn('Rejected Razorpay webhook with an invalid signature');
    return res.status(400).json({ success: false, message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logger.warn('Rejected Razorpay webhook with an unparseable body');
    return res.status(400).json({ success: false, message: 'Malformed payload' });
  }

  /**
   * Razorpay's own id for this delivery, stable across its retries. The digest
   * fallback covers hand-rolled test calls that omit the header — it dedupes
   * byte-identical replays, which is the most a body alone can tell us.
   */
  const eventId =
    req.headers['x-razorpay-event-id'] ||
    crypto.createHash('sha256').update(rawBody).digest('hex');

  const ledger = {
    eventId,
    event: event.event,
    accountId: event.account_id,
    occurredAt: event.created_at ? new Date(event.created_at * 1000) : new Date(),
    payload: event,
  };

  /**
   * Claim the delivery. `create` races with every other instance and only one wins;
   * the loser gets E11000 and looks at what the winner recorded.
   */
  let record;
  try {
    record = await WebhookEvent.create(ledger);
  } catch (err) {
    if (err?.code !== 11000) throw err;

    const seen = await WebhookEvent.findOneAndUpdate(
      { eventId },
      { $inc: { attempts: 1 } },
      { new: true }
    );

    /**
     * A previous attempt that *failed* is not a duplicate to skip — it is the
     * retry we asked for. Anything else has already been applied and re-running
     * it would, at best, resend a receipt.
     */
    if (seen && seen.status !== 'failed') {
      logger.debug(`Razorpay webhook ${eventId} (${event.event}) already handled — acknowledging`);
      return res.json({ success: true, duplicate: true });
    }
    record = seen;
  }

  try {
    const outcome = await razorpayWebhook.handleEvent(event);

    await WebhookEvent.updateOne(
      { _id: record._id },
      {
        status: outcome.status,
        note: outcome.note,
        order: outcome.order,
        payment: outcome.payment,
        razorpayOrderId: outcome.razorpayOrderId,
        razorpayPaymentId: outcome.razorpayPaymentId,
        processedAt: new Date(),
        $unset: { error: 1 },
      }
    );

    logger.info(`Razorpay webhook ${event.event}: ${outcome.status} — ${outcome.note}`);
    return res.json({ success: true });
  } catch (err) {
    await WebhookEvent.updateOne(
      { _id: record._id },
      { status: 'failed', error: err.message, processedAt: new Date() }
    );
    logger.error(`Razorpay webhook ${event.event} failed: ${err.stack || err.message}`);
    // 500 on purpose: Razorpay retries, and the ledger row above lets the retry
    // through rather than dismissing it as a duplicate.
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

/**
 * GET /payments/webhook-events (admin) — the delivery ledger.
 *
 * The screen support reaches for when a shopper says the money left their account
 * and the order still reads pending: it answers whether the event ever arrived
 * before anyone has to log into the gateway.
 */
exports.listWebhookEvents = asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.event) filter.event = req.query.event;
  if (req.query.search?.trim()) {
    const term = req.query.search.trim();
    filter.$or = [
      { razorpayOrderId: term },
      { razorpayPaymentId: term },
      { eventId: term },
    ];
  }

  const [events, total] = await Promise.all([
    WebhookEvent.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('order', 'orderNumber orderStatus paymentStatus')
      .lean(),
    WebhookEvent.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Webhook events fetched',
    data: { events },
    meta: paginationMeta({ total, page, limit }),
  });
});

/**
 * POST /payments/webhook-events/:id/replay (admin) — re-run a stored event.
 *
 * The manual half of the retry story. Razorpay gives up after its own retry window,
 * so an event that failed through a long outage can only be re-applied from the
 * copy kept here. Safe to press twice: it re-runs the same handlers, which are the
 * same ones a genuine redelivery would run, and they all converge rather than
 * accumulate.
 */
exports.replayWebhookEvent = asyncHandler(async (req, res) => {
  const record = await WebhookEvent.findById(req.params.id).select('+payload');
  if (!record) throw ApiError.notFound('Webhook event not found');

  const outcome = await razorpayWebhook.handleEvent(record.payload);

  record.status = outcome.status;
  record.note = `${outcome.note} (replayed by admin)`;
  record.order = outcome.order || record.order;
  record.payment = outcome.payment || record.payment;
  record.processedAt = new Date();
  record.error = undefined;
  await record.save();

  logger.info(`Admin replayed webhook ${record.eventId} (${record.event}): ${outcome.note}`);

  return sendSuccess(res, { message: 'Webhook event replayed', data: { event: record } });
});

/** POST /payments/:id/refund (admin) */
exports.refund = asyncHandler(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (!['captured', 'partially_refunded'].includes(payment.status)) {
    throw ApiError.badRequest('Only captured payments can be refunded');
  }

  /**
   * A refund may never exceed what is *left* of the capture. The gateway would
   * refuse it anyway, but refusing here means the ceiling is this system's own rule
   * rather than a remote error message staff have to interpret — and a mistyped
   * figure is caught before it reaches the money. Counting what has already gone
   * back is what makes the second partial refund on one payment safe.
   */
  const refundable = payment.amount - (payment.amountRefunded || 0);
  if (req.body.amount != null && req.body.amount > refundable) {
    throw ApiError.badRequest(`Refund cannot exceed the refundable amount of ${refundable}`);
  }

  const refund = await razorpay.refundPayment({
    paymentId: payment.razorpayPaymentId,
    amount: req.body.amount,
    notes: { reason: req.body.reason || 'Admin initiated refund' },
  });

  /**
   * Razorpay answers `processed` when the credit went out instantly and `pending`
   * when it is still moving through the bank. Believe that answer rather than
   * assuming success: the `refund.processed` / `refund.failed` webhooks are what
   * settle a pending one, and writing "refunded" here would leave staff with no
   * way to tell an actual credit from one that later bounced.
   */
  const processed = refund.status === 'processed';

  if (!payment.refunds) payment.refunds = [];
  payment.refunds.push({
    refundId: refund.id,
    amount: refund.amount / 100,
    status: refund.status,
    speed: refund.speed_processed || refund.speed_requested,
    reason: req.body.reason || 'Admin initiated refund',
    processedAt: processed ? new Date() : undefined,
  });
  payment.amountRefunded = payment.refunds
    .filter((r) => r.status === 'processed')
    .reduce((sum, r) => sum + (r.amount || 0), 0);

  payment.refund = {
    refundId: refund.id,
    amount: refund.amount / 100,
    status: refund.status,
    processedAt: processed ? new Date() : undefined,
  };
  if (processed) {
    payment.status = payment.amountRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
  }
  await payment.save();

  const fullyRefunded = payment.status === 'refunded';

  const order = await Order.findById(payment.order);
  if (order) {
    order.paymentStatus = fullyRefunded ? 'refunded' : 'refund_pending';
    if (fullyRefunded) {
      order.refundedAt = new Date();
      order.refundReference = refund.id;
    }
    await order.save();

    if (fullyRefunded) {
      // A refunded order is no longer a successful redemption.
      await releaseForOrder(order);

      // Refunding an order that never shipped should release its inventory.
      if (['pending', 'confirmed', 'packed'].includes(order.orderStatus)) {
        // Released against the exact SKU each line reserved.
        await Promise.all(order.items.map((item) => releaseStock(item)));
        broadcast.stockChanged(order.items, { reason: 'order_refunded' });
      }
    }
  }

  broadcast.paymentUpdated(order, payment);

  return sendSuccess(res, { message: 'Refund initiated', data: { payment } });
});
