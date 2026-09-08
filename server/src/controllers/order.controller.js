const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, paginationMeta } = require('../utils/apiResponse');
const { Order, Cart, Address, Coupon, CancellationReason, ReturnReason } = require('../models');
const { calculateTotals, eligibleSubtotal, lineTotal } = require('../services/pricing.service');
const { reserveStock, releaseStock } = require('../services/inventory.service');
const { redeemForOrder, releaseForOrder } = require('../services/coupon.service');
const { streamInvoice } = require('../services/invoice.service');
const { dateFilter } = require('../utils/dateFilter');
const mailService = require('../services/mail.service');
const broadcast = require('../realtime/broadcast');
const commerceSettings = require('../services/commerce.service');
const {
  STATUS_FLOW,
  CUSTOMER_CANCELLABLE,
  canMarkRefunded,
  RETURN_FLOW,
  RETURN_OPEN,
  RETURN_STATUS_STEPS,
  returnEligibility,
  invoiceAvailable,
} = require('../models/Order');

/**
 * Turns what the cancel dialog submitted into the one sentence stored on the
 * order: the label of a published reason, or the shopper's own words.
 *
 * The id is resolved server-side rather than trusting the label that came with
 * it, so a closed order can only ever quote a reason the store actually offers —
 * and a reason that has since been deactivated cannot be picked out of a stale
 * dialog left open in a tab.
 */
async function resolveCancellationReason({ reasonId, reason } = {}) {
  if (reasonId) {
    const picked = await CancellationReason.findOne({ _id: reasonId, isActive: true });
    if (!picked) throw ApiError.badRequest('That cancellation reason is no longer available');
    return picked.label;
  }

  const custom = (reason || '').trim();
  if (!custom) throw ApiError.badRequest('Please tell us why you are cancelling this order');
  return custom;
}

/**
 * The same resolution for the return dialog, against the return picklist.
 *
 * Kept separate from the cancellation one rather than parameterised, because the
 * two collections are separate on purpose — a shopper holding a damaged parcel
 * must never be offered "Wrong address selected".
 */
async function resolveReturnReason({ reasonId, reason } = {}) {
  if (reasonId) {
    const picked = await ReturnReason.findOne({ _id: reasonId, isActive: true });
    if (!picked) throw ApiError.badRequest('That return reason is no longer available');
    return picked.label;
  }

  const custom = (reason || '').trim();
  if (!custom) throw ApiError.badRequest('Please tell us why you are returning this order');
  return custom;
}

/**
 * Moves an order's status on the row itself, and reports whether *this* request is
 * the one that moved it.
 *
 * Every closing path here reads the order, checks its status in memory, and then
 * releases stock — three steps with two round trips between them, and the status
 * the check read is only a snapshot. Two requests arriving together (a double-tap
 * on Cancel, a shopper cancelling while staff cancel the same order, a retried
 * PATCH) both saw `confirmed`, both passed, and both restocked: one unit sold came
 * back as two, and the inflated count then oversells.
 *
 * The conditional update is what makes the transition exactly-once — the row moves
 * off `from` once, so only one caller sees `modifiedCount: 1` and only that caller
 * goes on to restock. It is the same guard `releaseForOrder` already applies to the
 * coupon slot, which is the half of the same race that was already covered.
 *
 * A same-status "transition" is deliberately not a claim: nothing moved, so
 * re-submitting `cancelled` on a cancelled order restocks nothing.
 */
async function claimOrderStatus(orderId, from, to) {
  if (from === to) return false;
  const claimed = await Order.updateOne(
    { _id: orderId, orderStatus: from },
    { $set: { orderStatus: to } }
  );
  return claimed.modifiedCount === 1;
}

/** The same guard for the return ladder, whose `refund_started` step is what restocks. */
async function claimReturnStatus(orderId, from, to) {
  if (from === to) return false;
  const claimed = await Order.updateOne(
    { _id: orderId, 'returnRequest.status': from },
    { $set: { 'returnRequest.status': to } }
  );
  return claimed.modifiedCount === 1;
}

/**
 * The sentence a shopper is shown when their return is refused, in the words that
 * answer the question they actually asked ("why can't I return this?").
 *
 * Both front-ends hide the button in these cases, so reaching one of these means
 * either a stale tab or a direct API call — but a refusal is a message either way,
 * not a bare 400.
 */
function returnRefusal(check, windowDays) {
  switch (check.reason) {
    case 'not_delivered':
      return 'This order has not been delivered yet, so there is nothing to return.';
    case 'already_requested':
      return 'A return is already in progress for this order.';
    case 'already_returned':
      return 'This order has already been returned.';
    case 'returns_disabled':
      return 'Returns are not available for this store. Please contact support for help.';
    case 'window_closed':
      return `The ${windowDays}-day return window for this order closed on ${new Date(
        check.deadline
      ).toDateString()}. Please contact support for help.`;
    default:
      return 'This order is not eligible for a return. Please contact support for help.';
  }
}

/**
 * Rebuilds the order from server-side truth: live product prices, live stock,
 * a re-validated coupon. Nothing the client sends about money is trusted.
 */
async function buildOrderDraft({ userId, addressId, couponCode }) {
  const cart = await Cart.findOne({ user: userId })
    .populate({
      path: 'items.product',
      populate: [
        { path: 'category', select: 'name' },
        { path: 'subCategory', select: 'name' },
      ],
    })
    .populate('items.variant');

  const active = (cart?.items || []).filter((i) => !i.savedForLater);
  if (!active.length) throw ApiError.badRequest('Your cart is empty');

  const address = await Address.findOne({ _id: addressId, user: userId });
  if (!address) throw ApiError.badRequest('Please select a valid delivery address');

  const items = [];
  // Runs alongside `items`, line for line. The order document has no room for
  // catalogue ids beyond the product's, and a coupon pinned to a category needs
  // them, so the scoping keys ride here rather than in what gets persisted.
  const couponLines = [];
  for (const line of active) {
    const p = line.product;
    if (!p || p.status !== 'published') {
      throw ApiError.badRequest(`"${p?.name || 'An item'}" is no longer available. Please update your cart.`);
    }

    // Every number below comes from the exact SKU when the product is varied — its price,
    // its stock, its imagery, its shipping weight.
    const v = line.variant;
    if (p.hasVariants && (!v || !v.isActive)) {
      throw ApiError.badRequest(
        `The selected option for "${p.name}" is no longer available. Please update your cart.`
      );
    }

    const name = p.name;
    const label = v ? `${p.name} (${v.label})` : p.name;
    const stock = v ? v.stock : p.stock;
    if (stock < line.quantity) {
      throw ApiError.badRequest(
        `Only ${stock} unit(s) of "${label}" left in stock. Please update your cart.`
      );
    }

    const finalPrice = v ? v.finalPrice : p.finalPrice;

    items.push({
      product: p._id,
      variant: v?._id || null,
      variantSku: v?.sku,
      variantLabel: v?.label,
      variantAttributes: (v?.attributes || []).map((a) => ({ name: a.name, value: a.value })),
      weight: v?.weight?.value ? { value: v.weight.value, unit: v.weight.unit } : undefined,
      dimensions: v?.dimensions?.length || v?.dimensions?.width || v?.dimensions?.height
        ? {
            length: v.dimensions.length,
            width: v.dimensions.width,
            height: v.dimensions.height,
            unit: v.dimensions.unit,
          }
        : undefined,
      name,
      slug: p.slug,
      image:
        v?.images?.[0]?.url || p.images?.find((i) => i.isPrimary)?.url || p.images?.[0]?.url,
      brand: p.brand,
      categoryName: p.category?.name,
      subCategoryName: p.subCategory?.name,
      price: v ? v.price : p.price,
      discountPercent: v ? v.discountPercent : p.discountPercent,
      finalPrice,
      quantity: line.quantity,
      // Billed from the discounted price; `price` above is the MRP, for display.
      lineTotal: lineTotal({ finalPrice, quantity: line.quantity }),
    });

    couponLines.push({
      productId: p._id,
      categoryId: p.category?._id || p.category || null,
      finalPrice,
      quantity: line.quantity,
    });
  }

  // The coupon is measured against exactly what is being charged for the goods.
  const subtotal = eligibleSubtotal(items);

  let coupon = null;
  let couponDiscount = 0;
  const code = (couponCode || cart.coupon?.code || '').toUpperCase();
  if (code) {
    coupon = await Coupon.findOne({ code });
    const check = coupon?.check({ userId, subtotal, lines: couponLines });
    if (!coupon || !check.valid) throw ApiError.badRequest(check?.reason || 'Invalid coupon code');
    couponDiscount = coupon.computeDiscount(subtotal, couponLines);
  }

  const totals = calculateTotals(items, { couponDiscount });

  return { cart, address, items, coupon, totals };
}

/** POST /orders/checkout-summary — priced preview before payment starts. */
exports.getCheckoutSummary = asyncHandler(async (req, res) => {
  const { addressId, couponCode } = req.body;
  const draft = await buildOrderDraft({ userId: req.user._id, addressId, couponCode });

  return sendSuccess(res, {
    message: 'Checkout summary ready',
    data: {
      items: draft.items,
      address: draft.address,
      coupon: draft.coupon ? { code: draft.coupon.code, discount: draft.totals.couponDiscount } : null,
      totals: draft.totals,
    },
  });
});

/**
 * POST /orders — creates the order and decrements stock atomically.
 * For COD the order is immediately confirmed; for Razorpay it stays `pending`
 * until /payments/verify succeeds.
 */
exports.createOrder = asyncHandler(async (req, res) => {
  const { addressId, couponCode, paymentMethod = 'razorpay', notes } = req.body;
  const userId = req.user._id;

  const draft = await buildOrderDraft({ userId, addressId, couponCode });
  const { items, address, coupon, totals } = draft;

  let order;

  const placeOrder = async (session) => {
    const opts = session ? { session } : {};

    // Conditional decrement: if another shopper drained the stock between the
    // draft and here, matchedCount is 0 and we abort.
    const decremented = [];
    for (const item of items) {
      const reserved = await reserveStock(item, opts);
      if (!reserved) {
        // Without a transaction we must undo the decrements we already made.
        if (!session) await Promise.all(decremented.map((d) => releaseStock(d)));
        throw ApiError.conflict(
          `"${item.variantLabel ? `${item.name} (${item.variantLabel})` : item.name}" just went out of stock. Please review your cart.`
        );
      }
      decremented.push(item);
    }

    const [created] = await Order.create(
      [
        {
          user: userId,
          items,
          shippingAddress: {
            fullName: address.fullName,
            phone: address.phone,
            addressLine1: address.addressLine1,
            addressLine2: address.addressLine2,
            landmark: address.landmark,
            city: address.city,
            state: address.state,
            pincode: address.pincode,
            country: address.country,
          },
          pricing: {
            mrpTotal: totals.mrpTotal,
            subtotal: totals.subtotal,
            discount: totals.discount,
            couponCode: coupon?.code,
            couponId: coupon?._id,
            couponDiscount: totals.couponDiscount,
            shipping: totals.shipping,
            total: totals.total,
          },
          paymentMethod,
          paymentStatus: 'pending',
          orderStatus: paymentMethod === 'cod' ? 'confirmed' : 'pending',
          statusHistory: [
            {
              status: paymentMethod === 'cod' ? 'confirmed' : 'pending',
              note: paymentMethod === 'cod' ? 'Order placed (cash on delivery)' : 'Awaiting payment',
              changedBy: userId,
              actor: 'customer',
            },
          ],
          notes,
        },
      ],
      opts
    );
    order = created;

    // COD is placed confirmed, so this is the moment the order is earned and the
    // moment its coupon is consumed. A prepaid order has earned nothing yet — it
    // holds stock, not a redemption — so its coupon is claimed by /payments/verify
    // (or the webhook) once money is actually captured. An abandoned or failed
    // attempt therefore leaves the coupon exactly as the shopper found it.
    if (paymentMethod === 'cod') {
      if ((await redeemForOrder(created, opts)) === 'exhausted') {
        // Another shopper took the last slot between the draft and here.
        if (!session) {
          await Promise.all(decremented.map((d) => releaseStock(d)));
          await Order.deleteOne({ _id: created._id });
        }
        throw ApiError.conflict(
          `"${coupon.code}" has just been fully claimed. Please remove it and try again.`
        );
      }

      // COD needs no payment step, so the cart can be emptied right away.
      // Prepaid carts are cleared after verification instead.
      await Cart.updateOne(
        { user: userId },
        { $pull: { items: { savedForLater: { $ne: true } } }, $unset: { coupon: 1 } },
        opts
      );
    }
  };

  // Transactions need a replica set. Local single-node MongoDB is common in dev,
  // so fall back to the compensating (non-transactional) path when unsupported.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => placeOrder(session));
  } catch (err) {
    const unsupported =
      err?.code === 20 ||
      /Transaction numbers are only allowed|replica set|not supported/i.test(err?.message || '');
    if (!unsupported) throw err;
    await placeOrder(null);
  } finally {
    await session.endSession();
  }

  if (paymentMethod === 'cod') {
    mailService
      .sendOrderConfirmationEmail({ to: req.user.email, name: req.user.name, order })
      .catch(() => {});
  }

  // Admins see the order land; every open product page sees the stock it consumed.
  broadcast.orderCreated(order);
  broadcast.stockChanged(items, { reason: 'order_placed' });
  if (paymentMethod === 'cod') {
    broadcast.cartUpdated(userId, null, { originSocketId: req.get('x-socket-id') });
  }

  return sendSuccess(res, {
    statusCode: 201,
    message: 'Order placed successfully',
    data: { order },
  });
});

/** GET /orders — the signed-in shopper's order history. */
exports.getMyOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Number(req.query.limit) || 10);

  const filter = { user: req.user._id };
  if (req.query.status && req.query.status !== 'all') filter.orderStatus = req.query.status;
  // The shopper's own returns filter, the same shape the panel's returns queue
  // uses: ?returnStatus=any for every order a return was ever raised on, or one
  // named return status. It is a filter of its own rather than another order
  // status because the order underneath stays Delivered while its return runs.
  //
  // ?returnStatus=none is its complement, and it is what the shopper's own
  // "Delivered" tab asks with: a delivered order that has raised a return is
  // listed under Returns, so leaving it in Delivered too would show one parcel in
  // two places and bury the journey that is still moving. `null` matches an
  // absent `returnRequest` as well as an explicitly null status.
  if (req.query.returnStatus && req.query.returnStatus !== 'all') {
    filter['returnRequest.status'] =
      req.query.returnStatus === 'any'
        ? { $ne: null }
        : req.query.returnStatus === 'none'
          ? null
          : req.query.returnStatus;
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean({ virtuals: true }),
    Order.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Orders fetched',
    data: { orders },
    meta: paginationMeta({ total, page, limit }),
  });
});

/** GET /orders/:id — owner or admin. */
exports.getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('user', 'name email phone')
    .populate('payment', 'status method razorpayPaymentId amount createdAt');

  if (!order) throw ApiError.notFound('Order not found');
  if (req.user.role !== 'admin' && String(order.user._id) !== String(req.user._id)) {
    throw ApiError.forbidden('You cannot view this order');
  }

  // Only the panel names the person behind each move; a shopper's own order page
  // has no business learning which member of staff touched it. The return has a
  // history of its own and it is read on the same page, so it is named the same
  // way — without this the panel's return ladder could only say "our team".
  if (req.user.role === 'admin') {
    await order.populate([
      { path: 'statusHistory.changedBy', select: 'name role' },
      { path: 'returnRequest.history.changedBy', select: 'name role' },
    ]);
  }

  // Whether the Return button is drawn, decided by the same function the return
  // endpoint enforces with — so the page and the API can never disagree about a
  // window that closes while the tab is open.
  const { returnWindowDays } = commerceSettings.get();

  return sendSuccess(res, {
    message: 'Order fetched',
    data: {
      order,
      returnPolicy: { windowDays: returnWindowDays, ...returnEligibility(order, returnWindowDays) },
      // Sent rather than recomputed on the client, for the same reason as the
      // return policy above: one rule, stated once, so the button and the
      // endpoint cannot disagree about an order that ships while the tab is open.
      invoiceAvailable: invoiceAvailable(order),
    },
  });
});

/** GET /orders/:id/invoice — streams a PDF. */
exports.downloadInvoice = asyncHandler(async (req, res) => {
  // The payment document comes with it: an online invoice prints the gateway
  // reference, which is the only number a shopper can quote back to their bank.
  const order = await Order.findById(req.params.id).populate('payment', 'razorpayPaymentId');
  if (!order) throw ApiError.notFound('Order not found');
  if (req.user.role !== 'admin' && String(order.user) !== String(req.user._id)) {
    throw ApiError.forbidden('You cannot download this invoice');
  }
  // Two rules, one per payment method — see invoiceAvailable(). The refusal has
  // to name the right one: telling a prepaid shopper to wait for dispatch, or a
  // COD shopper to complete a payment they make at the door, is a dead end.
  if (!invoiceAvailable(order)) {
    throw ApiError.badRequest(
      order.paymentMethod === 'cod'
        ? 'Invoice is available once the order has been dispatched'
        : 'Invoice is available once payment is complete'
    );
  }

  // The issue date, stamped the first time the document is actually produced and
  // never afterwards — a reprint a year from now has to carry the date the
  // invoice was issued, not the date it was reprinted. The write is conditional
  // on the field still being empty, so two clicks in the same second cannot give
  // the second one a later date; the read back is what that loser then prints.
  if (!order.invoicedAt) {
    await Order.updateOne({ _id: order._id, invoicedAt: null }, { $set: { invoicedAt: new Date() } });
    const issued = await Order.findById(order._id).select('invoicedAt').lean();
    order.invoicedAt = issued?.invoicedAt;
  }

  // Awaited: the PDF resolves its branding, artwork and QR before it writes a
  // byte, so a failure there is still a JSON error rather than a truncated file.
  await streamInvoice(order, res);
});

/**
 * PATCH /orders/:id/cancel — shopper-initiated.
 *
 * The storefront hides the action once an order has shipped, but the window is
 * enforced here: this is the only check a direct API call cannot walk around.
 * Staff keep the wider STATUS_FLOW window and go through /status instead.
 */
exports.cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email');
  if (!order) throw ApiError.notFound('Order not found');
  if (String(order.user?._id || order.user) !== String(req.user._id)) {
    throw ApiError.forbidden('You cannot cancel this order');
  }
  if (!CUSTOMER_CANCELLABLE.includes(order.orderStatus)) {
    // `pending` sits *before* the window rather than after it, so it gets its own
    // sentence — "already pending" would read as though the order had moved on.
    throw ApiError.badRequest(
      order.orderStatus === 'cancelled'
        ? 'This order has already been cancelled'
        : order.orderStatus === 'pending'
          ? 'This order is still waiting on its payment and has not been placed yet, so there is nothing to cancel.'
          : `This order is already ${order.orderStatus.replace(/_/g, ' ')} and can no longer be cancelled online. Please contact support for help.`
    );
  }

  // A reason is part of the contract, not a nicety: it is what the confirmation
  // email quotes back and what staff read on the order.
  const reason = await resolveCancellationReason(req.body);

  // Everything above read a snapshot; this is where the order is actually closed.
  // Whoever loses the claim did not cancel anything, so it must not restock.
  if (!(await claimOrderStatus(order._id, order.orderStatus, 'cancelled'))) {
    throw ApiError.conflict('This order has already been cancelled');
  }

  // Cancelling returns the reserved units to the exact SKU they were taken from,
  // and hands back the coupon redemption the order was holding — a cancelled order
  // must not spend one of the shopper's uses, nor one of the store's.
  await Promise.all(order.items.map((item) => releaseStock(item)));
  await releaseForOrder(order);

  order.orderStatus = 'cancelled';
  order.cancelledAt = new Date();
  order.cancellationReason = reason;
  order.cancelledBy = 'customer';
  order.cancelledByUser = req.user._id;
  order.statusHistory.push({
    status: 'cancelled',
    note: reason,
    changedBy: req.user._id,
    actor: 'customer',
  });
  // Cancelling does not move money — it only puts the order in the queue for a
  // refund an admin actually raises through the gateway.
  if (order.paymentStatus === 'paid') order.paymentStatus = 'refund_pending';
  await order.save();

  broadcast.orderStatusChanged(order, reason);
  broadcast.stockChanged(order.items, { reason: 'order_cancelled' });

  // The same status mail an admin cancellation sends. A shopper who cancels from
  // one device still wants the record in their inbox.
  if (order.user?.email) {
    mailService
      .sendOrderStatusEmail({ to: order.user.email, name: order.user.name, order })
      .catch(() => {});
  }

  return sendSuccess(res, { message: 'Order cancelled', data: { order } });
});

/**
 * PATCH /orders/:id/return — shopper-initiated.
 *
 * The window is the admin's Return Threshold, measured from the delivery date.
 * The storefront hides the button outside it, but this is where it is *enforced*:
 * a tab left open past midnight on the last day, or a direct call, gets the same
 * refusal as anybody else.
 *
 * Nothing about the order changes here beyond opening the request. The parcel is
 * still with the shopper, the stock is still theirs and the money is still ours —
 * all three move at `refund_started`, once the goods are actually back.
 */
exports.requestReturn = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email');
  if (!order) throw ApiError.notFound('Order not found');
  if (String(order.user?._id || order.user) !== String(req.user._id)) {
    throw ApiError.forbidden('You cannot return this order');
  }

  const { returnWindowDays } = commerceSettings.get();
  const check = returnEligibility(order, returnWindowDays);
  if (!check.eligible) throw ApiError.badRequest(returnRefusal(check, returnWindowDays));

  // A reason is part of the contract, not a nicety: it is what the pickup agent
  // is briefed with and what staff read when the quality check is done.
  const reason = await resolveReturnReason(req.body);

  // A previously rejected request keeps its history — the row below is appended
  // to it, so the trail of "you asked, we declined, you asked again" survives.
  // Every dated field is cleared explicitly: `returnRequest` is a nested path, so
  // an assignment merges rather than replaces, and a rejection's timestamps would
  // otherwise be read as this request's.
  order.set('returnRequest.status', 'requested');
  order.set('returnRequest.reason', reason);
  order.set('returnRequest.requestedBy', req.user._id);
  order.set('returnRequest.requestedAt', new Date());
  order.set('returnRequest.refundAmount', order.pricing?.total);
  for (const field of ['pickedUpAt', 'refundStartedAt', 'refundCompletedAt', 'rejectedAt', 'rejectionReason', 'pickupPartner', 'pickupTrackingNumber']) {
    order.set(`returnRequest.${field}`, undefined);
  }
  order.returnRequest.history.push({
    status: 'requested',
    note: reason,
    changedBy: req.user._id,
    actor: 'customer',
  });
  await order.save();

  broadcast.orderReturnChanged(order, reason);

  // The receipt for a return, on the same status template every other move uses —
  // it reads `returnRequest` and draws the return tracker rather than the
  // fulfilment row. A shopper who raises this from one device still wants the
  // record in their inbox, exactly as a cancellation gives them one.
  if (order.user?.email) {
    mailService
      .sendOrderStatusEmail({ to: order.user.email, name: order.user.name, order })
      .catch(() => {});
  }

  return sendSuccess(res, { message: 'Return requested', data: { order } });
});

/**
 * PATCH /orders/:id/return/status (admin) — moves a return along its ladder.
 *
 * The three consequences of a return all land on one step, `refund_started`,
 * because that is the step that means "the goods are back and they passed the
 * check": the SKUs go back to stock, the coupon redemption goes back to the
 * shopper, and the order finally becomes `returned`. Splitting them across the
 * pickup and the refund would restock a parcel that had not arrived.
 *
 * `refund_success` is the same human decision `markRefunded` is — money moves
 * through a gateway, not through a status field — so it is the one step that
 * settles the payment.
 */
exports.updateReturnStatus = asyncHandler(async (req, res) => {
  const { status, note, pickupPartner, pickupTrackingNumber, refundReference, refundAmount } = req.body;

  const order = await Order.findById(req.params.id).populate('user', 'name email');
  if (!order) throw ApiError.notFound('Order not found');

  const current = order.returnRequest?.status;
  if (!current) throw ApiError.badRequest('There is no return request on this order');
  if (!RETURN_FLOW[current]?.includes(status)) {
    throw ApiError.badRequest(
      `Cannot move a return from "${current.replace(/_/g, ' ')}" to "${status.replace(
        /_/g,
        ' '
      )}". Allowed: ${RETURN_FLOW[current]?.map((s) => s.replace(/_/g, ' ')).join(', ') || 'none'}`
    );
  }

  /*
   * `refund_started` is the step that puts the goods back into stock, so the move
   * onto it has to be exactly-once for the same reason a cancellation does: two
   * admins closing one return together would otherwise each restock the parcel.
   * Claimed on the row before anything is given back.
   */
  if (!(await claimReturnStatus(order._id, current, status))) {
    throw ApiError.conflict(
      'This return was moved by someone else while this dialog was open. Reload to see where it stands.'
    );
  }

  const now = new Date();
  const request = order.returnRequest;
  request.status = status;
  if (pickupPartner !== undefined) request.pickupPartner = pickupPartner || undefined;
  if (pickupTrackingNumber !== undefined) {
    request.pickupTrackingNumber = pickupTrackingNumber || undefined;
  }
  if (refundAmount !== undefined && refundAmount !== null) request.refundAmount = refundAmount;

  if (status === 'out_for_pickup') {
    request.pickedUpAt = undefined;
  }

  if (status === 'refund_started') {
    request.pickedUpAt = request.pickedUpAt || now;
    request.refundStartedAt = now;

    // The goods are back: the exact SKUs that left return to stock, and the
    // coupon redemption the order was holding goes back to the shopper — a
    // returned order must not spend one of their uses, nor one of the store's.
    await Promise.all(order.items.map((item) => releaseStock(item)));
    await releaseForOrder(order);

    order.orderStatus = 'returned';
    order.statusHistory.push({
      status: 'returned',
      note: request.reason,
      changedBy: req.user._id,
      actor: 'admin',
    });
    // Queued for a refund, not refunded — exactly as a cancellation is.
    if (order.paymentStatus === 'paid') order.paymentStatus = 'refund_pending';
  }

  if (status === 'refund_success') {
    request.refundCompletedAt = now;
    order.paymentStatus = 'refunded';
    order.refundedAt = now;
    if (refundReference) order.refundReference = refundReference;
  }

  if (status === 'rejected') {
    request.rejectedAt = now;
    request.rejectionReason = (note || '').trim() || 'The return could not be accepted.';
  }

  request.history.push({
    status,
    note: (note || '').trim() || undefined,
    changedBy: req.user._id,
    actor: 'admin',
  });
  await order.save();

  broadcast.orderReturnChanged(order, note, { originSocketId: req.get('x-socket-id') });
  if (status === 'refund_started') broadcast.stockChanged(order.items, { reason: 'order_returned' });

  /*
   * Every step of a return is mailed, on the same status template an order move
   * uses — it reads `returnRequest` and draws the return's own tracker in place
   * of the fulfilment row, so each message says where the *money* is.
   *
   * All four are worth an email in a way the fulfilment steps are not: a shopper
   * who has sent their goods away and is waiting on a refund has nothing in hand,
   * and "we have it, the refund is on its way" is the whole reassurance.
   */
  if (order.user?.email) {
    mailService
      .sendOrderStatusEmail({ to: order.user.email, name: order.user.name, order })
      .catch(() => {});
  }

  return sendSuccess(res, {
    message: `Return marked as ${status.replace(/_/g, ' ')}`,
    data: { order },
  });
});

/**
 * GET /orders/admin/return-statuses — drives the panel's return dropdown, the
 * same way /admin/statuses drives the order one.
 */
exports.getReturnStatusOptions = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Return status options fetched',
    data: {
      statuses: Object.keys(RETURN_FLOW),
      steps: RETURN_STATUS_STEPS,
      flow: RETURN_FLOW,
      windowDays: commerceSettings.get().returnWindowDays,
    },
  })
);

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

/** GET /orders/admin/all */
exports.listAllOrders = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 15);

  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.orderStatus = req.query.status;
  if (req.query.paymentStatus && req.query.paymentStatus !== 'all') {
    filter.paymentStatus = req.query.paymentStatus;
  }
  // The returns queue: ?returnStatus=requested for what is waiting on staff,
  // "any" for every order that has ever had one raised on it, or "none" for the
  // orders with no return at all — which is what the panel's Delivered filter
  // asks with, so a delivered parcel that has started a return is listed against
  // the return it is in and not against the delivery it has moved past.
  if (req.query.returnStatus && req.query.returnStatus !== 'all') {
    filter['returnRequest.status'] =
      req.query.returnStatus === 'any'
        ? { $ne: null }
        : req.query.returnStatus === 'none'
          ? null
          : req.query.returnStatus;
  }
  // The panel's shared Date control — ?range=month|year|all, or from/to for a custom
  // window — the same helper the Inbox lists and the dashboard use, so "this month"
  // means one thing across the admin. It also reads the day boundaries in the
  // server's own timezone; the hand-rolled pair this replaced pinned them to UTC,
  // which dropped the first five and a half hours of the "from" day for an IST store.
  const created = dateFilter(req.query);
  if (created) filter.createdAt = created;
  // One account's history, for the Users screen asking "what did this person buy?".
  // A malformed id is refused rather than cast-thrown, so a stale link reads as a
  // bad request instead of a 500.
  if (req.query.user) {
    if (!mongoose.isValidObjectId(req.query.user)) throw ApiError.badRequest('Invalid user id');
    filter.user = req.query.user;
  }
  if (req.query.search) {
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [
      { orderNumber: rx },
      { 'items.name': rx },
      { 'shippingAddress.fullName': rx },
      { 'shippingAddress.phone': rx },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate('user', 'name email phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean({ virtuals: true }),
    Order.countDocuments(filter),
  ]);

  return sendSuccess(res, {
    message: 'Orders fetched',
    data: { orders },
    meta: paginationMeta({ total, page, limit }),
  });
});

/** PATCH /orders/:id/status (admin) */
exports.updateOrderStatus = asyncHandler(async (req, res) => {
  const { status, note, reasonId, trackingNumber, courierPartner, expectedDeliveryDate } = req.body;

  const order = await Order.findById(req.params.id).populate('user', 'name email');
  if (!order) throw ApiError.notFound('Order not found');

  if (order.orderStatus !== status && !STATUS_FLOW[order.orderStatus]?.includes(status)) {
    throw ApiError.badRequest(
      `Cannot move an order from "${order.orderStatus}" to "${status}". Allowed: ${
        STATUS_FLOW[order.orderStatus]?.join(', ') || 'none'
      }`
    );
  }

  /*
   * An order is never marked `returned` from this dialog — STATUS_FLOW has no
   * edge into it, and this catches the one case that slips past that check: a
   * re-submit on an order already sitting at `returned`, which would restock
   * the goods a second time.
   *
   * Returns are closed *through* the return request, which at `refund_started`
   * restocks, releases the coupon, queues the refund and moves the order — all
   * the things a bare status change would miss, plus a tracker the shopper can
   * actually watch. A return handled off-system needs a request raised for it,
   * so that it goes through that same machinery.
   */
  if (status === 'returned') {
    throw ApiError.badRequest(
      RETURN_OPEN.includes(order.returnRequest?.status)
        ? 'This order has a return in progress. Close it from the Return request card — marking it returned here would leave the customer\'s return tracker out of step with their refund.'
        : 'An order is marked returned by closing its return request, not from here. Raise a return request for this order and take it to Refund started — that is what restocks the items and queues the refund.'
    );
  }

  // A staff cancellation quotes the same picklist the storefront offers when the
  // admin picked from it, and falls back to whatever they typed in the note.
  // Only cancellations reach here — `returned` is refused above, and the return
  // ladder does its own restocking at `refund_started`.
  let historyNote = note;
  if (status === 'cancelled') {
    // Resolved before anything is claimed or given back: a reason that has since
    // been deactivated is a refused request, not a half-cancelled order.
    const cancellationReason = reasonId
      ? await resolveCancellationReason({ reasonId })
      : note || 'Cancelled by admin';

    // The same claim the storefront cancellation makes, for the same reason: this
    // dialog and that one can land on one order at the same moment, and only the
    // request that actually closed the order may put its units back.
    if (!(await claimOrderStatus(order._id, order.orderStatus, 'cancelled'))) {
      throw ApiError.conflict(
        'This order was cancelled by someone else while this dialog was open. Reload to see where it stands.'
      );
    }

    // Released against the exact SKU each line reserved — a cancelled Black/M
    // must never make Blue/L look available.
    await Promise.all(order.items.map((item) => releaseStock(item)));
    // The coupon goes back too, on the same terms as a shopper cancellation.
    await releaseForOrder(order);
    // Queued for a refund, not refunded — see cancelOrder above.
    if (order.paymentStatus === 'paid') order.paymentStatus = 'refund_pending';
    order.cancelledAt = new Date();
    order.cancellationReason = cancellationReason;
    order.cancelledBy = 'admin';
    order.cancelledByUser = req.user._id;
    historyNote = order.cancellationReason;
  }

  order.orderStatus = status;
  if (trackingNumber !== undefined) order.trackingNumber = trackingNumber;
  if (courierPartner !== undefined) order.courierPartner = courierPartner;
  if (expectedDeliveryDate) order.expectedDeliveryDate = new Date(expectedDeliveryDate);
  if (status === 'delivered') {
    order.deliveredAt = new Date();
    // Cash is collected on handover, so delivery is the moment COD becomes paid.
    if (order.paymentMethod === 'cod') order.paymentStatus = 'paid';
  }

  order.statusHistory.push({ status, note: historyNote, changedBy: req.user._id, actor: 'admin' });
  await order.save();

  broadcast.orderStatusChanged(order, historyNote);
  if (status === 'cancelled') {
    broadcast.stockChanged(order.items, { reason: 'order_cancelled' });
  }

  if (order.user?.email) {
    mailService
      .sendOrderStatusEmail({ to: order.user.email, name: order.user.name, order })
      .catch(() => {});
  }

  return sendSuccess(res, { message: `Order marked as ${status.replace(/_/g, ' ')}`, data: { order } });
});

/**
 * PATCH /orders/:id/mark-refunded (admin)
 *
 * The one payment decision a human makes. Cancelling a prepaid order parks it at
 * `refund_pending`; this is where staff confirm the money has actually left the
 * account, which nothing but the person who raised the refund can know.
 *
 * Everything else the payment status does — a verified payment, a failed
 * attempt, cash collected on delivery — the system does for itself.
 */
exports.markRefunded = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id).populate('user', 'name email');
  if (!order) throw ApiError.notFound('Order not found');

  if (order.paymentStatus === 'refunded') {
    throw ApiError.badRequest('This refund has already been marked as sent');
  }
  if (!canMarkRefunded(order)) {
    // Everything that is not awaiting a refund is the system's business, not an
    // admin's: an unpaid COD order collected nothing, and a live order's payment
    // moves on its own when it is verified or handed over.
    throw ApiError.badRequest(
      order.paymentMethod === 'cod' && order.paymentStatus === 'pending'
        ? 'Nothing was collected on this cash-on-delivery order, so there is nothing to refund'
        : 'This order is not awaiting a refund'
    );
  }

  order.paymentStatus = 'refunded';
  order.refundedAt = new Date();
  if (req.body.refundReference !== undefined) {
    order.refundReference = req.body.refundReference || undefined;
  }
  await order.save();

  broadcast.orderChanged(order, { note: 'Refund sent' });

  return sendSuccess(res, { message: 'Refund marked as sent', data: { order } });
});

/** GET /orders/admin/statuses — drives the admin status dropdown. */
exports.getStatusOptions = asyncHandler(async (_req, res) =>
  sendSuccess(res, {
    message: 'Status options fetched',
    data: { statuses: Object.keys(STATUS_FLOW), flow: STATUS_FLOW },
  })
);

exports.buildOrderDraft = buildOrderDraft;
