const mongoose = require('mongoose');

const Counter = require('./Counter');

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'returned',
];

/**
 * Legal forward transitions. Orders may be cancelled up to (and including)
 * "out_for_delivery"; after delivery only a return is possible.
 *
 * This is the *staff* ladder. A shopper cancelling from the storefront is held to
 * the narrower window below — see CUSTOMER_CANCELLABLE.
 */
const STATUS_FLOW = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

/**
 * The statuses where nobody is still waiting on anything — the set account
 * deactivation is gated on.
 *
 * Not derived from STATUS_FLOW's leaves, because `delivered` is not one: a
 * delivered order can still become `returned`. That edge is a *new* decision the
 * customer may or may not take, not an outstanding obligation of ours — the
 * parcel arrived, which is the whole of what "still in progress" was asking
 * about. `returned` sits here for the mirror-image reason: it is only reachable
 * from `delivered`, so an order carrying it has been through the entire journey.
 */
const SETTLED_STATUSES = ['delivered', 'cancelled', 'returned'];

/** The complement: an order still on its way, or still waiting to be. */
const OPEN_STATUSES = ORDER_STATUSES.filter((status) => !SETTLED_STATUSES.includes(status));

/**
 * How far a shopper may cancel on their own: up to, but not including, the moment
 * the parcel leaves the warehouse. Once it is with a courier the money and the
 * goods are both in motion, and stopping that is a support decision — staff keep
 * the wider window STATUS_FLOW allows, because they can actually recall a parcel.
 *
 * Both front-ends mirror this list; the cancel endpoint is what enforces it.
 */
const CUSTOMER_CANCELLABLE = ['pending', 'confirmed', 'packed'];

/** Who ended an order. Recorded on the order and on the history entry alike. */
const CANCELLED_BY = ['customer', 'admin'];

/**
 * The return journey, which is a separate ladder from the order's own.
 *
 * A return does not replace the order's status while it is running: the parcel
 * was delivered, and it stays delivered until it has actually come back. So the
 * four steps below live on `order.returnRequest`, and the order only moves to
 * `returned` at the point the goods are back in our hands — which is
 * `refund_started`, the step that restocks the SKUs and queues the money.
 *
 *   requested       the shopper raised it; nothing has moved yet
 *   out_for_pickup  a courier is on the way to collect
 *   refund_started  collected and quality-checked; stock back, refund raised
 *   refund_success  the money has actually left our account
 *
 * `rejected` is the one branch off the path — a quality check that failed, or a
 * request staff decline. It ends the request without ending the order, and the
 * shopper may raise a fresh one while their window is still open.
 */
const RETURN_STATUSES = [
  'requested',
  'out_for_pickup',
  'refund_started',
  'refund_success',
  'rejected',
];

/** The four rows the storefront's return tracker draws, in order. */
const RETURN_STATUS_STEPS = ['requested', 'out_for_pickup', 'refund_started', 'refund_success'];

/** Legal forward moves. Staff drive every one of them; the shopper only opens the request. */
const RETURN_FLOW = {
  requested: ['out_for_pickup', 'rejected'],
  out_for_pickup: ['refund_started', 'rejected'],
  refund_started: ['refund_success'],
  refund_success: [],
  rejected: [],
};

/** A return that has ended, one way or the other. */
const RETURN_CLOSED = ['refund_success', 'rejected'];

/**
 * A return that is still running. While one of these is open the order shows the
 * tracker instead of the Return button, and a second request is refused.
 */
const RETURN_OPEN = RETURN_STATUSES.filter((status) => !RETURN_CLOSED.includes(status));

/**
 * Whether a shopper may raise a return on this order right now — and if not, why.
 *
 * The window is measured from `deliveredAt` rather than from the order date,
 * because the promise made on the product page is "N days from delivery": a parcel
 * that took a week to arrive must not eat into the shopper's window. An order with
 * no `deliveredAt` (delivered before the field existed) falls back to its last
 * update, which is the moment it was marked delivered.
 *
 * Both front-ends mirror this rule to decide what to draw; the return endpoint is
 * what enforces it, and it is the only check a direct API call cannot walk around.
 *
 * @param {object} order
 * @param {number} windowDays  the admin's Return Threshold, in days
 * @param {Date}   [now]
 * @returns {{ eligible: boolean, reason?: string, deadline?: Date, daysLeft?: number }}
 */
function returnEligibility(order, windowDays, now = new Date()) {
  if (!order) return { eligible: false, reason: 'not_found' };

  // What the return itself says comes first. An order that has been through one
  // is no longer `delivered`, and answering "it has not been delivered yet" to
  // somebody asking about the parcel they sent back is the wrong sentence.
  const status = order.returnRequest?.status;
  if (status && RETURN_OPEN.includes(status)) return { eligible: false, reason: 'already_requested' };
  if (status === 'refund_success') return { eligible: false, reason: 'already_returned' };

  if (order.orderStatus !== 'delivered') return { eligible: false, reason: 'not_delivered' };

  const days = Number(windowDays);
  if (!Number.isFinite(days) || days <= 0) return { eligible: false, reason: 'returns_disabled' };

  const deliveredAt = order.deliveredAt || order.updatedAt;
  if (!deliveredAt) return { eligible: false, reason: 'no_delivery_date' };

  const deadline = new Date(new Date(deliveredAt).getTime() + days * 24 * 60 * 60 * 1000);
  if (now > deadline) return { eligible: false, reason: 'window_closed', deadline };

  return {
    eligible: true,
    deadline,
    daysLeft: Math.max(0, Math.ceil((deadline - now) / (24 * 60 * 60 * 1000))),
  };
}

const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refund_pending', 'refunded'];

/**
 * The payment status is maintained by the system, not by hand.
 *
 *   pending → paid            a verified Razorpay payment, or a COD order
 *                             reaching `delivered` — cash is collected on
 *                             handover, so delivery *is* the payment
 *   pending → failed          an abandoned or rejected gateway attempt
 *   paid → refund_pending     the order was cancelled or returned after payment
 *
 * Every one of those happens on its own, in the controller that owns the event.
 * That leaves exactly one thing a human has to decide: whether the refund has
 * actually left the account. Money moves through the gateway, not through a
 * status field, so nothing can know that but the person who raised it.
 *
 * Hence a single manual move, and no map: `refund_pending → refunded`.
 *
 * A cash-on-delivery order never reaches it. Cancelled before handover it
 * collected nothing and owes nothing back, so it simply stays `pending`;
 * delivered, it is marked paid without anyone touching it.
 */
const canMarkRefunded = (order) => order.paymentStatus === 'refund_pending';

/**
 * Order items are denormalised snapshots. A product being renamed, repriced or deleted
 * must never rewrite historical orders or invoices.
 */
const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    /**
     * The SKU that was actually shipped. Inventory, returns, warehouse picking and
     * per-SKU analytics all read this; `product` alone cannot tell Black/M from Blue/L.
     * Null for products that have no variants.
     */
    variant: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    variantSku: String,
    variantLabel: String, // "Black · M" — printed on invoices and packing slips
    /** Snapshot of the chosen pairs, so a later attribute rename can't rewrite history. */
    variantAttributes: {
      type: [
        {
          name: String,
          value: String,
          _id: false,
        },
      ],
      default: [],
    },
    /** Shipping data captured per SKU — a 256 GB unit may weigh differently to a 128 GB one. */
    weight: {
      value: Number,
      unit: String,
    },
    dimensions: {
      length: Number,
      width: Number,
      height: Number,
      unit: String,
    },
    name: { type: String, required: true },
    slug: String,
    image: String,
    brand: String,
    categoryName: String,
    subCategoryName: String,
    price: { type: Number, required: true }, // MRP at purchase time
    discountPercent: { type: Number, default: 0 },
    finalPrice: { type: Number, required: true }, // per-unit paid price
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: {
      type: [orderItemSchema],
      validate: { validator: (v) => v.length > 0, message: 'Order must contain at least one item' },
    },

    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      addressLine1: { type: String, required: true },
      addressLine2: String,
      landmark: String,
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      country: { type: String, default: 'India' },
    },

    /**
     * `subtotal − couponDiscount + shipping = total`, and that is the whole sum.
     * `mrpTotal` and `discount` describe the same money from the pre-discount
     * side for display; neither is a deduction still to be taken.
     */
    pricing: {
      /** Sum of the MRP line totals. Display only — the struck-through original. */
      mrpTotal: { type: Number, default: 0 },
      /** Sum of the discounted line totals — what the item table adds up to. */
      subtotal: { type: Number, required: true },
      /** MRP less `subtotal`: the saving already baked into the prices above. */
      discount: { type: Number, default: 0 },
      couponCode: String,
      /** Which coupon the code resolved to, so a redemption can be given back. */
      couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
      /** The one deduction from `subtotal`. */
      couponDiscount: { type: Number, default: 0 },
      shipping: { type: Number, default: 0 },
      total: { type: Number, required: true },
    },

    /**
     * True while this order holds one of its coupon's redemptions. Set when the
     * order is earned (COD placed, or a payment captured) and cleared when it is
     * cancelled or refunded — never by applying the code. Every counter change is
     * gated on flipping this, so one order can never consume a second redemption
     * however many times payment is retried, verified or webhooked.
     */
    couponRedeemed: { type: Boolean, default: false },

    paymentMethod: { type: String, enum: ['razorpay', 'cod'], default: 'razorpay' },
    paymentStatus: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: 'pending',
      index: true,
    },
    /** When staff confirmed the refund had actually been raised. */
    refundedAt: Date,
    /** The gateway/bank reference staff can quote to a shopper chasing it. */
    refundReference: String,
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

    orderStatus: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    statusHistory: [
      {
        status: { type: String, enum: ORDER_STATUSES },
        note: String,
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        /**
         * Which side made the move. `changedBy` names the account, but an admin
         * panel reading back a closed order needs to say "cancelled by customer"
         * without first resolving a user id against the staff list.
         */
        actor: { type: String, enum: ['customer', 'admin', 'system'], default: 'admin' },
        changedAt: { type: Date, default: Date.now },
      },
    ],

    trackingNumber: String,
    courierPartner: String,
    expectedDeliveryDate: Date,
    deliveredAt: Date,
    cancelledAt: Date,
    /**
     * The reason as it will be read back — the label of the predefined reason the
     * shopper picked, or the sentence they typed under "Other". Stored as text so
     * a later edit to the admin's reason list cannot rewrite a closed order.
     */
    cancellationReason: String,
    cancelledBy: { type: String, enum: CANCELLED_BY },
    cancelledByUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    /**
     * The live return, if this order has one. Absent until a shopper raises it,
     * and kept afterwards as the record of what happened — a rejected request
     * stays here, under its own history, even when a fresh one replaces it.
     *
     * `reason` is stored as text for the same reason `cancellationReason` is: a
     * later edit to the admin's picklist must not rewrite a settled return.
     */
    returnRequest: {
      status: { type: String, enum: RETURN_STATUSES, index: true },
      reason: String,
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      requestedAt: Date,
      pickedUpAt: Date,
      refundStartedAt: Date,
      refundCompletedAt: Date,
      rejectedAt: Date,
      /** Why staff turned it down — shown to the shopper on their order page. */
      rejectionReason: String,
      /** What is actually being refunded. Defaults to the order total. */
      refundAmount: Number,
      /** The courier collecting, and the reference a shopper can chase. */
      pickupPartner: String,
      pickupTrackingNumber: String,
      history: [
        {
          status: { type: String, enum: RETURN_STATUSES },
          note: String,
          changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          actor: { type: String, enum: ['customer', 'admin', 'system'], default: 'admin' },
          changedAt: { type: Date, default: Date.now },
        },
      ],
    },

    invoiceNumber: String,
    notes: String,
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
// The panel's returns queue reads this: open requests, most recent first.
orderSchema.index({ 'returnRequest.status': 1, 'returnRequest.requestedAt': -1 });

orderSchema.virtual('itemCount').get(function itemCount() {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

/**
 * Whether the *shopper* may still cancel this themselves. The storefront reads
 * this to decide what its Cancel button does; staff go by STATUS_FLOW instead.
 */
orderSchema.virtual('isCancellable').get(function isCancellable() {
  return CUSTOMER_CANCELLABLE.includes(this.orderStatus);
});

/** The return's own status, or null when this order has never had one. */
orderSchema.virtual('returnStatus').get(function returnStatus() {
  return this.returnRequest?.status || null;
});

/**
 * ORD<yy><mm><5 digit serial> — "ORD260800001" is the first order of Aug 2026.
 *
 * The serial is a per-month counter, so it is the running order count for the
 * month rather than an opaque id: readable over the phone, sortable as text, and
 * it tells staff at a glance where in the month an order sits. The invoice takes
 * the same serial under an INV prefix, keeping the pair obviously related.
 *
 * The counter is claimed inside whatever session the save is running under, so a
 * checkout that aborts (out of stock, payment never started) returns its number.
 */
orderSchema.pre('validate', async function assignNumbers(next) {
  if (!this.isNew || this.orderNumber) return next();

  try {
    const now = new Date();
    const ym = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const seq = await Counter.next(`order:${ym}`, this.$session());
    const serial = String(seq).padStart(5, '0');

    this.orderNumber = `ORD${ym}${serial}`;
    this.invoiceNumber = `INV${ym}${serial}`;
    return next();
  } catch (err) {
    return next(err);
  }
});

orderSchema.statics.ORDER_STATUSES = ORDER_STATUSES;
orderSchema.statics.STATUS_FLOW = STATUS_FLOW;
orderSchema.statics.CUSTOMER_CANCELLABLE = CUSTOMER_CANCELLABLE;
orderSchema.statics.SETTLED_STATUSES = SETTLED_STATUSES;
orderSchema.statics.OPEN_STATUSES = OPEN_STATUSES;
orderSchema.statics.PAYMENT_STATUSES = PAYMENT_STATUSES;
orderSchema.statics.canMarkRefunded = canMarkRefunded;
orderSchema.statics.canTransition = (from, to) => Boolean(STATUS_FLOW[from]?.includes(to));
orderSchema.statics.RETURN_STATUSES = RETURN_STATUSES;
orderSchema.statics.RETURN_STATUS_STEPS = RETURN_STATUS_STEPS;
orderSchema.statics.RETURN_FLOW = RETURN_FLOW;
orderSchema.statics.RETURN_OPEN = RETURN_OPEN;
orderSchema.statics.RETURN_CLOSED = RETURN_CLOSED;
orderSchema.statics.returnEligibility = returnEligibility;
orderSchema.statics.canTransitionReturn = (from, to) => Boolean(RETURN_FLOW[from]?.includes(to));

module.exports = mongoose.model('Order', orderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;
module.exports.STATUS_FLOW = STATUS_FLOW;
module.exports.CUSTOMER_CANCELLABLE = CUSTOMER_CANCELLABLE;
module.exports.SETTLED_STATUSES = SETTLED_STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
module.exports.CANCELLED_BY = CANCELLED_BY;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
module.exports.canMarkRefunded = canMarkRefunded;
module.exports.RETURN_STATUSES = RETURN_STATUSES;
module.exports.RETURN_STATUS_STEPS = RETURN_STATUS_STEPS;
module.exports.RETURN_FLOW = RETURN_FLOW;
module.exports.RETURN_OPEN = RETURN_OPEN;
module.exports.RETURN_CLOSED = RETURN_CLOSED;
module.exports.returnEligibility = returnEligibility;
