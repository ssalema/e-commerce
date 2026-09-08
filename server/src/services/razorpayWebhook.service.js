const { Order, Payment, Cart } = require('../models');
const { redeemForOrder, releaseForOrder } = require('./coupon.service');
const mailService = require('./mail.service');
const broadcast = require('../realtime/broadcast');
const logger = require('../utils/logger');

/**
 * Razorpay webhook handlers, one per event this store subscribes to.
 *
 * Everything here runs *after* the controller has verified the HMAC signature and
 * claimed the event id, so a handler may assume two things it could not assume on
 * its own: the body genuinely came from Razorpay, and no other process is running
 * this same delivery. What a handler must still assume is that the outcome it is
 * reporting may already have been applied — the browser's own /payments/verify call
 * usually beats the webhook to a capture by a second or two. So every handler is
 * written to converge on the right state rather than to apply a delta, and says in
 * its return value whether it actually changed anything.
 *
 * A handler returns { status, note } where status is:
 *   processed — state moved because of this event
 *   ignored   — recognised and correct to do nothing (already applied, or about a
 *               payment this system never created)
 * and a throw means "could not apply it" — the controller answers 500 and Razorpay
 * redelivers, which is exactly what we want for a database blip.
 */

/** Razorpay speaks in paise everywhere in a webhook body. */
const toRupees = (paise) => (paise == null ? undefined : Number(paise) / 100);
const at = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000) : undefined);

const result = (status, note, extra = {}) => ({ status, note, ...extra });

/* ------------------------------------------------------------------ *
 * Shared: a payment succeeded
 * ------------------------------------------------------------------ */

/**
 * Settle a successful capture, whichever event reported it.
 *
 * `payment.captured` and `order.paid` describe the same money from two angles and
 * both are worth subscribing to — `order.paid` is the one that fires when an order
 * is completed by a payment we never saw authorised — so treating them as one code
 * path is what makes the pair safe to enable together.
 *
 * This is the safety net under the checkout page: a shopper whose browser died
 * between paying and /payments/verify gets their order confirmed, their cart
 * emptied and their receipt emailed from here instead.
 */
async function settleCapture(entity, eventName) {
  const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
  if (!payment) {
    return result('ignored', `No payment attempt stored for Razorpay order ${entity.order_id}`);
  }

  payment.razorpayPaymentId = entity.id;
  payment.method = entity.method;
  payment.bank = entity.bank || undefined;
  payment.wallet = entity.wallet || undefined;
  payment.vpa = entity.vpa || undefined;
  payment.fee = toRupees(entity.fee);
  payment.tax = toRupees(entity.tax);
  payment.lastWebhookEvent = eventName;
  payment.lastWebhookAt = new Date();
  // A live dispute or a refund already recorded outranks "captured" — neither is
  // undone by a redelivery of the capture that started it all.
  if (payment.status !== 'disputed' && !payment.refunds?.length) payment.status = 'captured';
  await payment.save();

  const current = await Order.findById(payment.order).select('orderStatus').lean();
  if (!current) return result('ignored', `Order ${payment.order} no longer exists`);

  /**
   * An order that was already cancelled or returned is deliberately not revived.
   *
   * Cancelling put the stock back and handed the coupon redemption back, so
   * forcing this to `confirmed` would resurrect an order nothing is reserved for.
   * Money that lands on a cancelled order is a refund to raise, not a sale — it is
   * flagged `refund_pending` for staff and left cancelled.
   */
  const settled = ['cancelled', 'returned'].includes(current.orderStatus);

  if (settled) {
    await Order.updateOne(
      { _id: payment.order, paymentStatus: { $ne: 'refunded' } },
      { paymentStatus: 'refund_pending' }
    );
    logger.warn(
      `Razorpay captured ${entity.id} for order ${payment.order}, which is already ` +
        `cancelled or returned — flagged for refund rather than confirmed.`
    );
  }

  /**
   * The promotion runs as a conditional update rather than a read-then-write so it
   * is atomic against /payments/verify doing the same thing a millisecond later:
   * `paymentStatus: { $ne: 'paid' }` means exactly one of the two gets a
   * modifiedCount, and that one owns the receipt email and the announcements. The
   * pipeline form keeps an order staff have already packed or shipped at the
   * status they moved it to.
   */
  const promoted = settled
    ? { modifiedCount: 0 }
    : await Order.updateOne({ _id: payment.order, paymentStatus: { $ne: 'paid' } }, [
        {
          $set: {
            paymentStatus: 'paid',
            orderStatus: {
              $cond: [{ $eq: ['$orderStatus', 'pending'] }, 'confirmed', '$orderStatus'],
            },
          },
        },
      ]);

  const order = await Order.findById(payment.order).populate('user', 'name email');
  if (!order) return result('ignored', `Order ${payment.order} no longer exists`);

  // Idempotent per order, so whichever of webhook/verify arrives second consumes
  // nothing. Skipped on a cancelled order: cancelling already gave the use back.
  if (!settled && (await redeemForOrder(order)) === 'exhausted') {
    logger.warn(
      `Order ${order.orderNumber} paid with ${order.pricing?.couponCode} after its usage ` +
        `limit filled; discount honoured`
    );
  }

  if (promoted.modifiedCount > 0) {
    if (
      order.orderStatus === 'confirmed' &&
      !order.statusHistory?.some((h) => h.status === 'confirmed')
    ) {
      order.statusHistory.push({
        status: 'confirmed',
        note: `Payment confirmed by Razorpay (${eventName})`,
        actor: 'system',
      });
      await order.save();
    }

    /**
     * Only the promoting event touches the cart and the inbox. /payments/verify
     * does both when the browser survives; doing them again here would empty a
     * cart the shopper has since refilled and send a duplicate receipt.
     * "Saved for later" lines survive checkout, as they do on the verify path.
     */
    const userId = order.user?._id || order.user;
    await Cart.updateOne(
      { user: userId },
      { $pull: { items: { savedForLater: { $ne: true } } }, $unset: { coupon: 1 } }
    );
    broadcast.cartUpdated(userId, null);

    if (order.user?.email) {
      mailService
        .sendOrderConfirmationEmail({ to: order.user.email, name: order.user.name, order })
        .catch((err) => logger.warn(`Order confirmation email failed: ${err.message}`));
    }

    broadcast.paymentUpdated(order, payment);
    broadcast.orderStatusChanged(order, 'Payment confirmed by provider');

    return result('processed', `Order ${order.orderNumber} marked paid`, {
      order: order._id,
      payment: payment._id,
    });
  }

  // Staff still need to see money that landed on an order nobody is fulfilling.
  if (settled) broadcast.paymentUpdated(order, payment);

  return result(
    settled ? 'processed' : 'ignored',
    settled
      ? `Order ${order.orderNumber} is ${current.orderStatus}; flagged refund_pending`
      : `Order ${order.orderNumber} was already paid`,
    { order: order._id, payment: payment._id }
  );
}

/* ------------------------------------------------------------------ *
 * Payment events
 * ------------------------------------------------------------------ */

/**
 * The bank is holding the money but it is not ours yet.
 *
 * Orders are created with `payment_capture: 1`, so capture normally follows within
 * the same second and this event is only ever a breadcrumb. It earns its place on
 * the days it does not: an authorization that never captures is money held against
 * a shopper's card for an order that reads pending, and this row is the only record
 * that the attempt ever got that far.
 */
async function onPaymentAuthorized(entity, eventName) {
  const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
  if (!payment) {
    return result('ignored', `No payment attempt stored for Razorpay order ${entity.order_id}`);
  }
  if (['captured', 'refunded', 'partially_refunded'].includes(payment.status)) {
    return result('ignored', `Payment already ${payment.status}`, { payment: payment._id });
  }

  payment.status = 'authorized';
  payment.razorpayPaymentId = entity.id;
  payment.method = entity.method;
  payment.lastWebhookEvent = eventName;
  payment.lastWebhookAt = new Date();
  await payment.save();

  return result('processed', `Payment ${entity.id} authorized`, {
    order: payment.order,
    payment: payment._id,
  });
}

/**
 * The attempt ended without money moving.
 *
 * The order is left alone beyond its payment status: a failed attempt is not a
 * cancelled order, and the shopper can pay again against the same one — which is
 * why nothing here releases stock.
 */
async function onPaymentFailed(entity, eventName) {
  const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
  if (!payment) {
    return result('ignored', `No payment attempt stored for Razorpay order ${entity.order_id}`);
  }
  // A capture that already landed outranks a failure notice for an earlier attempt
  // on the same order — Razorpay allows several tries against one order id.
  if (payment.status === 'captured') {
    return result('ignored', 'Payment already captured; failure notice is for an earlier attempt', {
      payment: payment._id,
    });
  }

  payment.status = 'failed';
  payment.razorpayPaymentId = entity.id || payment.razorpayPaymentId;
  payment.errorCode = entity.error_code;
  payment.errorDescription = entity.error_description || entity.error_reason;
  payment.lastWebhookEvent = eventName;
  payment.lastWebhookAt = new Date();
  await payment.save();

  const order = await Order.findById(payment.order);
  if (order && order.paymentStatus === 'pending') {
    order.paymentStatus = 'failed';
    await order.save();
  }
  if (order) broadcast.paymentUpdated(order, payment);

  return result('processed', `Payment failed: ${payment.errorDescription || payment.errorCode}`, {
    order: payment.order,
    payment: payment._id,
  });
}

/* ------------------------------------------------------------------ *
 * Dispute (chargeback) events
 * ------------------------------------------------------------------ */

/**
 * All six dispute events share one handler because they are one object moving
 * through its own states; the only per-event differences are the status written and
 * how loudly it is logged. `respond_by` is the field that matters operationally —
 * miss that deadline and the dispute is lost by default, whatever the merits.
 */
function applyDispute(payment, entity, status) {
  payment.dispute = {
    disputeId: entity.id,
    amount: toRupees(entity.amount),
    status: status || entity.status,
    phase: entity.phase,
    reasonCode: entity.reason_code,
    reasonDescription: entity.reason_description,
    respondBy: at(entity.respond_by),
    openedAt: at(entity.created_at) || payment.dispute?.openedAt,
    closedAt: ['won', 'lost', 'closed'].includes(status) ? new Date() : undefined,
  };
}

const disputeHandler = (status, { loud = false } = {}) =>
  async function onDispute(entity, eventName) {
    const payment = await Payment.findOne({ razorpayPaymentId: entity.payment_id });
    if (!payment) {
      return result('ignored', `No payment stored for disputed payment ${entity.payment_id}`);
    }

    applyDispute(payment, entity, status);
    // `won` and `closed` leave the money with us, so the payment goes back to captured.
    if (status === 'won' || status === 'closed') {
      if (payment.status === 'disputed') payment.status = 'captured';
    } else {
      payment.status = 'disputed';
    }
    payment.lastWebhookEvent = eventName;
    payment.lastWebhookAt = new Date();
    await payment.save();

    const order = await Order.findById(payment.order);

    /**
     * A lost dispute is money already debited back out of the merchant account —
     * final, not pending. The order is marked refunded with the dispute as its
     * reference and its coupon use handed back, so the books match the bank.
     */
    if (status === 'lost' && order) {
      order.paymentStatus = 'refunded';
      order.refundedAt = new Date();
      order.refundReference = entity.id;
      await order.save();
      await releaseForOrder(order);
    }

    const line =
      `Dispute ${entity.id} on payment ${entity.payment_id} ` +
      `(order ${order?.orderNumber || payment.order}) is now ${status || entity.status}` +
      (entity.respond_by ? ` — evidence due ${at(entity.respond_by).toISOString()}` : '');
    if (loud) logger.error(line);
    else logger.warn(line);

    if (order) broadcast.paymentUpdated(order, payment);

    return result('processed', line, { order: payment.order, payment: payment._id });
  };

/* ------------------------------------------------------------------ *
 * Downtime events
 * ------------------------------------------------------------------ */

/**
 * Which payment methods Razorpay currently reports as down, keyed by downtime id.
 *
 * Deliberately in memory and not in Mongo: it is a live status with a lifetime of
 * minutes that Razorpay re-announces from scratch, so a process restart losing it
 * costs nothing, while a stale row in a collection would have the checkout page
 * warning about an outage that ended last week. `getActiveDowntimes()` feeds
 * /payments/config, which is how checkout can say "UPI is having trouble right now,
 * try a card" instead of letting the shopper fail and guess why.
 */
const downtimes = new Map();

function onDowntimeChanged(entity) {
  downtimes.set(entity.id, {
    id: entity.id,
    method: entity.method,
    status: entity.status, // started | resolved
    severity: entity.severity,
    instrument: entity.instrument,
    begin: at(entity.begin),
    updatedAt: new Date(),
  });
  logger.warn(
    `Razorpay downtime ${entity.status} for ${entity.method} (${entity.severity || 'severity unknown'})`
  );
  return result('processed', `Downtime ${entity.status} for ${entity.method}`);
}

function onDowntimeResolved(entity) {
  downtimes.delete(entity.id);
  logger.info(`Razorpay downtime resolved for ${entity.method}`);
  return result('processed', `Downtime resolved for ${entity.method}`);
}

/** Anything older than an hour is treated as stale — a missed `resolved` must not stick. */
function getActiveDowntimes() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const active = [];
  for (const [id, d] of downtimes) {
    if (d.updatedAt.getTime() < cutoff) downtimes.delete(id);
    else if (d.status !== 'resolved') active.push({ method: d.method, severity: d.severity });
  }
  return active;
}

/* ------------------------------------------------------------------ *
 * Refund events
 * ------------------------------------------------------------------ */

/** Merge one refund entity into the payment's refund list, keyed by refund id. */
function upsertRefund(payment, entity, status) {
  if (!payment.refunds) payment.refunds = [];
  const row = {
    refundId: entity.id,
    amount: toRupees(entity.amount),
    status: status || entity.status,
    speed: entity.speed_processed || entity.speed_requested,
    reason: entity.notes?.reason,
    referenceId: entity.acquirer_data?.arn || entity.acquirer_data?.rrn,
    processedAt: status === 'processed' ? at(entity.created_at) || new Date() : undefined,
  };

  const existing = payment.refunds.find((r) => r.refundId === entity.id);
  if (existing) Object.assign(existing, row);
  else payment.refunds.push(row);

  payment.amountRefunded = payment.refunds
    .filter((r) => r.status === 'processed')
    .reduce((sum, r) => sum + (r.amount || 0), 0);

  // The flat `refund` field is what the order screens read; keep it on the latest.
  payment.refund = {
    refundId: row.refundId,
    amount: row.amount,
    status: row.status,
    processedAt: row.processedAt,
  };
  return row;
}

const refundHandler = (status) =>
  async function onRefund(entity, eventName) {
    const payment = await Payment.findOne({ razorpayPaymentId: entity.payment_id });
    if (!payment) {
      return result('ignored', `No payment stored for refunded payment ${entity.payment_id}`);
    }

    upsertRefund(payment, entity, status);

    /**
     * `partially_refunded` vs `refunded` is decided by the arithmetic, not by the
     * event name: a second partial refund that happens to close the gap is a full
     * refund, and Razorpay does not say so in the event. A failed refund leaves the
     * payment where it was — the money never left.
     */
    if (status === 'processed') {
      payment.status = payment.amountRefunded >= payment.amount ? 'refunded' : 'partially_refunded';
    }
    payment.lastWebhookEvent = eventName;
    payment.lastWebhookAt = new Date();
    await payment.save();

    const order = await Order.findById(payment.order);
    if (order) {
      if (status === 'processed' && payment.status === 'refunded') {
        order.paymentStatus = 'refunded';
        order.refundedAt = new Date();
        order.refundReference = entity.acquirer_data?.arn || entity.acquirer_data?.rrn || entity.id;
        await order.save();
        // A refunded order is no longer a successful redemption.
        await releaseForOrder(order);
      } else if (status === 'created' && order.paymentStatus === 'paid') {
        // Raised, but not yet in the shopper's account — the state staff chase.
        order.paymentStatus = 'refund_pending';
        await order.save();
      } else if (status === 'failed') {
        logger.error(
          `Refund ${entity.id} FAILED for order ${order.orderNumber} — it must be raised again`
        );
      }
      broadcast.paymentUpdated(order, payment);
    }

    return result('processed', `Refund ${entity.id} ${status}`, {
      order: payment.order,
      payment: payment._id,
    });
  };

/**
 * The instant-refund tier changed after the refund was raised — Razorpay downgrades
 * `optimum` to `normal` when the bank will not take an instant credit. Nothing about
 * the money changes, only how long the shopper waits, so this only updates the row.
 */
async function onRefundSpeedChanged(entity, eventName) {
  const payment = await Payment.findOne({ razorpayPaymentId: entity.payment_id });
  if (!payment) return result('ignored', `No payment stored for refund ${entity.id}`);

  upsertRefund(payment, entity, entity.status);
  payment.lastWebhookEvent = eventName;
  payment.lastWebhookAt = new Date();
  await payment.save();

  return result('processed', `Refund ${entity.id} speed is now ${entity.speed_processed}`, {
    order: payment.order,
    payment: payment._id,
  });
}

/* ------------------------------------------------------------------ *
 * Settlement events
 * ------------------------------------------------------------------ */

/**
 * A payout of captured money reached the bank account.
 *
 * There is nothing to change on an order — the shopper was told they had paid days
 * ago — so this is recorded rather than applied. What it buys is the accounting
 * answer to "which of this money do we actually hold?", from the event ledger,
 * without opening the dashboard.
 */
function onSettlementProcessed(entity) {
  const line =
    `Settlement ${entity.id} processed: ${toRupees(entity.amount)} INR ` +
    `(fees ${toRupees(entity.fees) || 0}, tax ${toRupees(entity.tax) || 0}, UTR ${entity.utr || 'n/a'})`;
  logger.info(line);
  return result('processed', line);
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/**
 * Where in the delivered body each event family keeps its entity. Razorpay nests it
 * under the resource name, and `payment.downtime` is the one key with a dot in it —
 * which is why this is a lookup table rather than a guess from the event name.
 */
const ENTITY_PATHS = {
  payment: (p) => p.payment?.entity,
  order: (p) => p.order?.entity,
  refund: (p) => p.refund?.entity,
  dispute: (p) => p.payment?.dispute?.entity || p.dispute?.entity,
  downtime: (p) => p['payment.downtime']?.entity,
  settlement: (p) => p.settlement?.entity,
};

/**
 * Every event this store acts on. The names match the Razorpay dashboard's
 * "Active Events" list exactly — see docs/WEBHOOKS.md for which of these to tick.
 */
const HANDLERS = {
  /* Payment */
  'payment.authorized': { entity: 'payment', handler: onPaymentAuthorized },
  'payment.captured': { entity: 'payment', handler: settleCapture },
  'payment.failed': { entity: 'payment', handler: onPaymentFailed },

  /* Disputes */
  'payment.dispute.created': { entity: 'dispute', handler: disputeHandler('open', { loud: true }) },
  'payment.dispute.under_review': { entity: 'dispute', handler: disputeHandler('under_review') },
  'payment.dispute.action_required': {
    entity: 'dispute',
    handler: disputeHandler('action_required', { loud: true }),
  },
  'payment.dispute.won': { entity: 'dispute', handler: disputeHandler('won') },
  'payment.dispute.lost': { entity: 'dispute', handler: disputeHandler('lost', { loud: true }) },
  'payment.dispute.closed': { entity: 'dispute', handler: disputeHandler('closed') },

  /* Downtime */
  'payment.downtime.started': { entity: 'downtime', handler: onDowntimeChanged },
  'payment.downtime.updated': { entity: 'downtime', handler: onDowntimeChanged },
  'payment.downtime.resolved': { entity: 'downtime', handler: onDowntimeResolved },

  /**
   * `order.paid` carries the payment entity alongside the order entity, and it is
   * the same money `payment.captured` describes — so it settles through the same
   * function, which is what makes the pair safe to subscribe to together.
   */
  'order.paid': { entity: 'payment', handler: settleCapture },

  /* Refunds */
  'refund.created': { entity: 'refund', handler: refundHandler('created') },
  'refund.processed': { entity: 'refund', handler: refundHandler('processed') },
  'refund.failed': { entity: 'refund', handler: refundHandler('failed') },
  'refund.speed_changed': { entity: 'refund', handler: onRefundSpeedChanged },

  /* Settlement */
  'settlement.processed': { entity: 'settlement', handler: onSettlementProcessed },
};

/**
 * Events that belong to Razorpay products this store does not use — Invoices,
 * Payment Links, QR codes, Smart Collect fund accounts, Route sub-accounts and
 * RazorpayX Engage rewards.
 *
 * They are listed rather than left to fall through so that ticking one of them in
 * the dashboard by accident is a logged no-op instead of an "unhandled" row that
 * reads like a bug. Nothing in this codebase creates these objects, so there is
 * genuinely nothing to apply.
 */
const ACKNOWLEDGED = new Set([
  'order.notification.delivered',
  'order.notification.failed',
  'invoice.paid',
  'invoice.partially_paid',
  'invoice.expired',
  'qr_code.created',
  'qr_code.closed',
  'qr_code.credited',
  'fund_account.validation.completed',
  'fund_account.validation.failed',
  'account.instantly_activated',
  'account.activated_kyc_pending',
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.expired',
  'payment_link.cancelled',
  'engage.rewards.disabled',
  'engage.rewards.enabled',
  'engage.rewards.denomination_disabled',
  'engage.rewards.denomination_enabled',
  'engage.rewards.denomination_updated',
  'engage.rewards.discount_updated',
  'engage.rewards.termsandconditions_updated',
  'engage.rewards.instructions_updated',
  'engage.inventory.low_stock',
  'engage.balance.low_balance',
]);

/**
 * Dispatch one verified event. The controller owns signature checking, dedupe and
 * the HTTP response; this owns what the event means.
 */
async function handleEvent(event) {
  const name = event.event;
  const registered = HANDLERS[name];

  if (!registered) {
    if (ACKNOWLEDGED.has(name)) {
      return result('ignored', `${name} belongs to a Razorpay product this store does not use`);
    }
    logger.warn(`Unhandled Razorpay webhook event: ${name}`);
    return result('unhandled', `No handler registered for ${name}`);
  }

  const entity = ENTITY_PATHS[registered.entity](event.payload || {});
  if (!entity) {
    return result('ignored', `${name} arrived without a ${registered.entity} entity`);
  }

  const out = await registered.handler(entity, name);
  return {
    ...out,
    razorpayOrderId: entity.order_id || undefined,
    razorpayPaymentId:
      entity.payment_id || (registered.entity === 'payment' ? entity.id : undefined),
  };
}

module.exports = {
  handleEvent,
  getActiveDowntimes,
  /** Exported so the docs and a test can assert the dashboard list matches the code. */
  SUBSCRIBED_EVENTS: Object.keys(HANDLERS),
  ACKNOWLEDGED_EVENTS: [...ACKNOWLEDGED],
};
