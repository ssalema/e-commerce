const mongoose = require('mongoose');

/**
 * One refund raised against this payment.
 *
 * A list rather than a single object because a payment can be refunded in parts —
 * one returned line today, another next week — and each part travels its own
 * `created → processed | failed` path at the gateway. The refund webhooks are what
 * move a row along it, so the row has to exist per refund id or the second refund
 * would overwrite the first one's outcome.
 */
const refundSchema = new mongoose.Schema(
  {
    refundId: { type: String, index: true },
    amount: Number, // rupees
    /** created → processed (money left) | failed (it did not). */
    status: String,
    /** `normal` or `optimum` — Razorpay's instant-refund tier, if one applied. */
    speed: String,
    reason: String,
    /** Bank reference a shopper can quote when chasing the credit. */
    referenceId: String,
    processedAt: Date,
  },
  { _id: false }
);

/**
 * A chargeback the cardholder's bank has raised against this payment.
 *
 * Kept on the payment rather than the order because a dispute is an argument about
 * the money, not about the goods, and it outlives the order's own status: an order
 * can be delivered and closed while the dispute is still open.
 */
const disputeSchema = new mongoose.Schema(
  {
    disputeId: { type: String, index: true },
    amount: Number, // rupees
    /** open → under_review → won | lost, or closed if it was withdrawn. */
    status: String,
    /** `chargeback`, `pre_arbitration`, `arbitration` — how far it has escalated. */
    phase: String,
    reasonCode: String,
    reasonDescription: String,
    /** The deadline Razorpay gives us to upload evidence. Miss it and it is lost by default. */
    respondBy: Date,
    openedAt: Date,
    closedAt: Date,
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, enum: ['razorpay', 'cod'], default: 'razorpay' },

    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String, index: true },
    razorpaySignature: String,

    amount: { type: Number, required: true }, // rupees
    currency: { type: String, default: 'INR' },
    /**
     * created           — an attempt exists at the gateway, nothing has moved.
     * authorized        — the bank has held the money but it is not ours yet.
     * captured          — the money is ours.
     * failed            — the attempt ended without money moving.
     * partially_refunded / refunded — some or all of it has been given back.
     * disputed          — a chargeback is live against it; the money may be pulled.
     */
    status: {
      type: String,
      enum: [
        'created',
        'authorized',
        'captured',
        'failed',
        'partially_refunded',
        'refunded',
        'disputed',
      ],
      default: 'created',
      index: true,
    },
    method: String, // card / upi / netbanking — as reported by Razorpay
    /** `hdfc`, `upi`, the wallet's name — whichever of these Razorpay reports for the method. */
    bank: String,
    wallet: String,
    vpa: String,
    /** What Razorpay kept. Needed to reconcile a settlement against the order total. */
    fee: Number,
    tax: Number,
    errorCode: String,
    errorDescription: String,

    /** The most recent refund, kept flat for the order screens that read one value. */
    refund: {
      refundId: String,
      amount: Number,
      status: String,
      processedAt: Date,
    },
    /** Every refund, in the order they were raised. */
    refunds: { type: [refundSchema], default: undefined },
    /** Rupees given back so far, across all processed refunds. */
    amountRefunded: { type: Number, default: 0 },

    dispute: disputeSchema,

    /** Razorpay's payout reference once this payment reaches the bank account. */
    settlement: {
      settlementId: String,
      utr: String,
      settledAt: Date,
    },

    /**
     * The last webhook that touched this record, and when. Two rows that answer
     * "is this document current, or is it what the browser told us three retries
     * ago?" without opening the event ledger.
     */
    lastWebhookEvent: String,
    lastWebhookAt: Date,

    // Trimmed provider payload kept for reconciliation/disputes.
    rawResponse: { type: mongoose.Schema.Types.Mixed, select: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
