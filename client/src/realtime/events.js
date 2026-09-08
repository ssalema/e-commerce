/**
 * Mirror of server/src/realtime/events.js — keep the two in step.
 * Importing the names rather than typing string literals means a rename breaks the
 * build instead of silently switching a listener off.
 */
export const EVENTS = {
  READY: 'realtime:ready',
  SUBSCRIBE: 'realtime:subscribe',
  UNSUBSCRIBE: 'realtime:unsubscribe',

  PRODUCT_CREATED: 'product:created',
  PRODUCT_UPDATED: 'product:updated',
  PRODUCT_DELETED: 'product:deleted',
  PRODUCT_STOCK_CHANGED: 'product:stock-changed',
  PRODUCT_VARIANTS_CHANGED: 'product:variants-changed',

  CATEGORY_CHANGED: 'category:changed',
  SUBCATEGORY_CHANGED: 'subcategory:changed',
  BRAND_CHANGED: 'brand:changed',
  BANNER_CHANGED: 'banner:changed',
  COUPON_CHANGED: 'coupon:changed',
  SETTINGS_UPDATED: 'settings:updated',
  CAREER_POSITION_CHANGED: 'career:position-changed',
  CAREER_EXPERIENCE_CHANGED: 'career:experience-changed',
  CANCELLATION_REASON_CHANGED: 'cancellation-reason:changed',

  REVIEW_CREATED: 'review:created',
  REVIEW_UPDATED: 'review:updated',
  REVIEW_DELETED: 'review:deleted',

  CART_UPDATED: 'cart:updated',
  WISHLIST_UPDATED: 'wishlist:updated',
  PROFILE_UPDATED: 'profile:updated',
  ACCOUNT_STATUS_CHANGED: 'account:status-changed',
  ADDRESS_CHANGED: 'address:changed',
  SESSIONS_CHANGED: 'sessions:changed',
  SESSION_REVOKED: 'session:revoked',

  ORDER_CREATED: 'order:created',
  ORDER_UPDATED: 'order:updated',
  ORDER_STATUS_CHANGED: 'order:status-changed',
  /** A return was raised on an order, or moved along its own ladder. */
  ORDER_RETURN_CHANGED: 'order:return-changed',
  PAYMENT_UPDATED: 'payment:updated',
};

/**
 * Catalogue changes that can alter *which* products belong in a list, or what a card
 * says beyond its stock — a product published, repriced, renamed, deleted, or its SKU
 * set regenerated. There is no way to answer these from the payload alone, so a list
 * that receives one has to re-read.
 *
 * All of them originate from an admin editing the catalogue, which is rare. That is
 * what makes refetching on them affordable, and it is why stock is deliberately not in
 * the list: see below.
 */
export const CATALOG_STRUCTURE_EVENTS = [
  EVENTS.PRODUCT_CREATED,
  EVENTS.PRODUCT_UPDATED,
  EVENTS.PRODUCT_DELETED,
  // A regenerated or repriced SKU set changes what a card and a selector should show.
  EVENTS.PRODUCT_VARIANTS_CHANGED,
];

/**
 * Everything above, plus stock.
 *
 * Reserved for the few listeners that are already narrowed to a handful of products by
 * a `filter` — the cart and the checkout, which care only about the lines they hold.
 * A whole-grid listener must not use this: `product:stock-changed` is emitted per line
 * item of every order placed, so binding a full-list refetch to it makes each sale
 * cost one expensive read per shopper currently browsing. Those screens subscribe to
 * `CATALOG_STRUCTURE_EVENTS` and patch stock in place instead — see
 * utils/stockPatch.js.
 */
export const CATALOG_EVENTS = [...CATALOG_STRUCTURE_EVENTS, EVENTS.PRODUCT_STOCK_CHANGED];

/** Anything that changes the shopper's own order history. */
export const ORDER_EVENTS = [
  EVENTS.ORDER_CREATED,
  EVENTS.ORDER_UPDATED,
  EVENTS.ORDER_STATUS_CHANGED,
  // A return raised or moved reshapes the same rows a status change does.
  EVENTS.ORDER_RETURN_CHANGED,
  EVENTS.PAYMENT_UPDATED,
];

export const REVIEW_EVENTS = [EVENTS.REVIEW_CREATED, EVENTS.REVIEW_UPDATED, EVENTS.REVIEW_DELETED];

export const rooms = {
  product: (id) => `product:${id}`,
  order: (id) => `order:${id}`,
};
