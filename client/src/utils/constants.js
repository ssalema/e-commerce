export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Premium Store';
export const SITE_URL = import.meta.env.VITE_SITE_URL || 'http://localhost:5173';
/** Blank when Google sign-in isn't configured — the UI hides the button in that case. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

/*
 * These carry the API's values only — their labels are translation keys resolved
 * at the point of render (`shop:sort.*`, `checkout:track.*`), so a language switch
 * updates them like every other string.
 */
export const SORT_OPTIONS = [
  'newest',
  'popular',
  'price_asc',
  'price_desc',
  'discount',
  'rating',
  'name_asc',
];

export const DISCOUNT_FILTERS = [10, 20, 30, 40, 50];
export const RATING_FILTERS = [4, 3, 2, 1];

/*
 * The two product-grid widths, named once.
 *
 * A listing gives a column to its filter rail, so it fits one tile fewer than a
 * page that runs the full width. Both the grid and the skeleton standing in for
 * it read from here — when the two disagreed, the placeholder shimmered at five
 * across and the products landed at four, and the whole page jumped on load.
 */
export const PRODUCT_GRID_COLUMNS = {
  full: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  withSidebar: 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4',
};

export const ORDER_STATUS_STEPS = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
];

/**
 * How far a shopper may cancel on their own — mirrors CUSTOMER_CANCELLABLE in
 * server/src/models/Order.js. Once the parcel is with a courier the button stays
 * on screen but explains itself instead of cancelling; the endpoint enforces the
 * same window, so this list only decides what the page says.
 */
export const CUSTOMER_CANCELLABLE_STATUSES = ['pending', 'confirmed', 'packed'];

/** Statuses that end an order — nothing follows them on the timeline. */
export const ORDER_CLOSED_STATUSES = ['cancelled', 'returned'];

export const ORDER_STATUS_STYLES = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  confirmed: 'bg-brand-50 text-brand-700 ring-brand-200',
  packed: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  shipped: 'bg-violet-50 text-violet-700 ring-violet-200',
  out_for_delivery: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  delivered: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  cancelled: 'bg-red-50 text-red-700 ring-red-200',
  returned: 'bg-ink-100 text-ink-700 ring-ink-200',
};

export const PAYMENT_STATUS_STYLES = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-red-50 text-red-700 ring-red-200',
  // Money owed back reads as outstanding, the same as money still owed; only a
  // completed refund goes quiet.
  refund_pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  refunded: 'bg-ink-100 text-ink-700 ring-ink-200',
};

/*
 * The shop's commerce rules, as they stand before the settings document has been
 * read — nothing more than the schema defaults in server/src/models/Setting.js,
 * repeated here so the first paint has numbers rather than blanks.
 *
 * The live values come from `useSettings().commerce`, which is the admin's own
 * Organization → Commerce rules. These used to be VITE_ env vars that had to be
 * kept in step with the server's by hand; now there is one figure behind both the
 * price checkout charges and the price the policy pages describe.
 */
export const COMMERCE_DEFAULTS = {
  freeShippingThreshold: 499,
  shippingFlatRate: 49,
  returnWindowDays: 7,
};

/**
 * The four rows the return tracker draws — mirrors RETURN_STATUS_STEPS in
 * server/src/models/Order.js. `rejected` is not among them: it is a branch off
 * the path, drawn as a closing row rather than a step along it.
 */
export const RETURN_STATUS_STEPS = [
  'requested',
  'out_for_pickup',
  'refund_started',
  'refund_success',
];

/** A return that is still running — the order shows its tracker, not the button. */
export const RETURN_OPEN_STATUSES = ['requested', 'out_for_pickup', 'refund_started'];

export const RETURN_STATUS_STYLES = {
  requested: 'bg-amber-50 text-amber-700 ring-amber-200',
  out_for_pickup: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  refund_started: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  refund_success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rejected: 'bg-red-50 text-red-700 ring-red-200',
};

/**
 * When the policy pages were last revised. Bumped by hand whenever the copy in a
 * `legal` translation bundle changes in a way a shopper would care about — it is
 * the date printed under every policy heading.
 */
export const POLICY_LAST_UPDATED = '2026-08-17';

/*
 * What a shopper may attach to a review. Mirrored by the API — server/src/
 * middleware/upload.js holds the same mime lists and size caps, and Review.MAX_MEDIA
 * the same count — so these only decide what the picker offers and what it rejects
 * before spending a round trip.
 */
export const REVIEW_MEDIA_MAX = 5;
export const REVIEW_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
export const REVIEW_VIDEO_TYPES = ['video/mp4'];
export const MAX_REVIEW_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REVIEW_VIDEO_BYTES = 30 * 1024 * 1024;

export const RECENTLY_VIEWED_KEY = 'ps_recently_viewed';
export const MAX_RECENTLY_VIEWED = 12;
