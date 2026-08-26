export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Premium Store Admin';
export const STOREFRONT_URL = import.meta.env.VITE_STOREFRONT_URL || 'http://localhost:5173';

/**
 * How long a search box waits before it asks the server, everywhere in the panel.
 *
 * It was 400ms on the list pages and 350ms in the Inbox tabs — close enough that
 * nobody would name the difference, and far enough that the same typing speed
 * fired a different number of requests depending on which screen you were on.
 */
export const SEARCH_DEBOUNCE_MS = 350;

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'returned',
];

/** Mirrors the server's STATUS_FLOW so the UI only offers legal transitions. */
export const STATUS_FLOW = {
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
 * The fulfilment path a timeline draws, and the names it draws it under —
 * mirrors ORDER_STATUS_STEPS and the `detail.steps` copy in the storefront, so
 * the panel and the customer's own order page never name a step differently.
 */
export const ORDER_STATUS_STEPS = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
];

export const ORDER_STEP_LABELS = {
  pending: 'Order Placed',
  confirmed: 'Confirmed',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
};

/**
 * The return's own ladder — mirrors RETURN_FLOW in server/src/models/Order.js, so
 * the panel only ever offers a move the API will accept.
 *
 * `requested` is not a value staff can set: the shopper is the only one who opens
 * a return. Everything after it is theirs.
 */
export const RETURN_STATUS_FLOW = {
  requested: ['out_for_pickup', 'rejected'],
  out_for_pickup: ['refund_started', 'rejected'],
  refund_started: ['refund_success'],
  refund_success: [],
  rejected: [],
};

/** The four rows the tracker draws, in order. `rejected` is a branch, not a step. */
export const RETURN_STATUS_STEPS = [
  'requested',
  'out_for_pickup',
  'refund_started',
  'refund_success',
];

/** A return still in flight — the order shows it as outstanding work. */
export const RETURN_OPEN_STATUSES = ['requested', 'out_for_pickup', 'refund_started'];

/** Named exactly as the storefront names them, so staff and shopper read one thing. */
export const RETURN_STATUS_LABELS = {
  requested: 'Return Requested',
  out_for_pickup: 'Out for Pickup',
  refund_started: 'Refund Started',
  refund_success: 'Refund Success',
  rejected: 'Return Declined',
};

/**
 * A return's five states in the panel's own palette — read by StatusChip as the
 * `return` kind, so these chips are drawn by the same component, at the same
 * size and weight, as every other status in the panel.
 *
 * Named colours rather than hand-mixed tints on purpose: a chip with its own
 * shape or its own tint reads as a different kind of object from the Delivered
 * and Refunded chips it stands next to, whatever its hue. The meanings still
 * line up with the storefront's — amber while it waits on someone, green when
 * the money is back, red when it was refused — the panel simply says them in its
 * own voice, the way it does for every order and payment status.
 */
export const RETURN_STATUS_COLOR = {
  requested: 'warning',
  out_for_pickup: 'info',
  refund_started: 'secondary',
  refund_success: 'success',
  rejected: 'error',
};

/**
 * What each move actually does, spelled out for the person about to make it.
 * `refund_started` is the consequential one — it is the step that restocks the
 * SKUs, gives the coupon redemption back and closes the order as returned.
 */
export const RETURN_STATUS_EFFECT = {
  out_for_pickup: 'The customer is told a courier is on the way to collect the item.',
  refund_started:
    'Confirms the item is back and passed the quality check: its SKUs return to stock, the coupon redemption is given back, and the order is closed as Returned with the refund queued.',
  refund_success: 'Marks the money as actually sent. This settles the payment as Refunded.',
  rejected:
    'Declines the return. The order stays Delivered, nothing is restocked, and the customer may raise a fresh return while their window is still open.',
};

export const ORDER_STATUS_COLOR = {
  pending: 'warning',
  confirmed: 'info',
  packed: 'info',
  shipped: 'secondary',
  out_for_delivery: 'primary',
  delivered: 'success',
  cancelled: 'error',
  returned: 'default',
};

export const PAYMENT_STATUS_COLOR = {
  pending: 'warning',
  paid: 'success',
  failed: 'error',
  // Money owed back is outstanding, the same as money still owed.
  refund_pending: 'warning',
  refunded: 'default',
};

/**
 * The one payment decision staff make — mirrors `canMarkRefunded` in
 * server/src/models/Order.js.
 *
 * A verified payment, a failed attempt and cash collected on delivery all move
 * the payment status on their own; cancelling a prepaid order parks it at
 * `refund_pending`. Whether the refund has actually left the account is the only
 * part no system can know, so it is the only part with a button.
 *
 * A cash-on-delivery order never gets one: cancelled before handover it stays
 * `pending`, and delivered it is marked paid without anyone lifting a finger.
 */
export const canMarkRefunded = (order) => order.paymentStatus === 'refund_pending';

export const PRODUCT_STATUS_COLOR = {
  draft: 'default',
  published: 'success',
  archived: 'warning',
};

export const MAX_PRODUCT_IMAGES = 5;
/**
 * What a *picked* photo may weigh. Uploads are downscaled in the browser first
 * (see utils/media.js), so the file that actually leaves is far smaller than this.
 */
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];

/** Mirrors VIDEO_ALLOWED / VIDEO_MAX_BYTES in server/src/middleware/upload.js. */
export const MAX_PRODUCT_VIDEOS = 2;
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
export const ACCEPTED_VIDEO_TYPES = ['video/mp4'];
