const mongoose = require('mongoose');

/**
 * Every Razorpay webhook this API has accepted, one document per delivery.
 *
 * Two jobs, and the first is the reason the collection exists at all:
 *
 * 1. Idempotency. Razorpay retries a webhook until it gets a 2xx, and it will
 *    happily deliver the same event twice on its own — so "did I already act on
 *    this?" cannot be answered from the order alone. `eventId` carries a unique
 *    index and the insert is what claims an event: whichever process wins the
 *    insert runs the handler, and a duplicate key means somebody already did.
 *    That is a database-level lock, so two dyno instances receiving the same
 *    retry in the same second still process it exactly once.
 *
 * 2. Reconciliation. When a shopper says the money left their account and the
 *    order still reads pending, this is the record that says whether the event
 *    ever arrived, what it contained and why it did not land — which is
 *    otherwise a support ticket answered by reading the gateway dashboard.
 *
 * Documents expire after 180 days: long enough to outlive a dispute window,
 * short enough that the payload never becomes a permanent store of card
 * metadata nobody reads.
 */
const webhookEventSchema = new mongoose.Schema(
  {
    /**
     * Razorpay's `x-razorpay-event-id` header — its identifier for this delivery,
     * stable across every retry of the same event. When the header is missing
     * (only ever seen from hand-rolled test calls) the controller falls back to a
     * digest of the raw body, which dedupes byte-identical replays just as well.
     */
    eventId: { type: String, required: true, unique: true },

    /** e.g. `payment.captured`, `refund.processed`, `payment.dispute.lost`. */
    event: { type: String, required: true, index: true },
    accountId: String,

    /**
     * processed — a handler ran and changed something.
     * ignored   — recognised, but nothing here to do (an event for a payment this
     *             system never created, or a family we acknowledge but do not act on).
     * unhandled — no handler is registered for this event name.
     * failed    — a handler threw. Razorpay is told so, and retries.
     */
    status: {
      type: String,
      enum: ['processed', 'ignored', 'unhandled', 'failed'],
      default: 'processed',
      index: true,
    },
    /** One line for a human reading the ledger: what was done, or why not. */
    note: String,
    error: String,

    /** How many deliveries of this event id we have seen, retries included. */
    attempts: { type: Number, default: 1 },

    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', index: true },
    /** Gateway ids, so an event can be found by what support has in front of them. */
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String, index: true },

    /** When Razorpay says the event happened, as opposed to when we stored it. */
    occurredAt: Date,
    processedAt: Date,

    /**
     * The full delivered body. `select: false` so it is never in a list response
     * by accident — it is fetched deliberately, for one event, during a replay or
     * an investigation.
     */
    payload: { type: mongoose.Schema.Types.Mixed, select: false },
  },
  { timestamps: true }
);

/** Housekeeping: an unbounded ledger of raw gateway payloads is a liability. */
webhookEventSchema.index({ createdAt: -1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
