/**
 * Applying a `product:stock-changed` broadcast to cards already on screen, instead
 * of asking the server for the whole list again.
 *
 * Every order placed emits one of these per line item to the public room, so on a
 * busy day this is the highest-frequency event the storefront receives — and it was
 * wired to `refetch`. That meant every shopper with the home page open re-requested
 * the home feed, the single most expensive read in the API, within the same quarter
 * second of somebody else's checkout. The more shoppers there were, the more each
 * sale cost: exactly backwards.
 *
 * The payload already carries absolute values rather than deltas (see
 * server/src/realtime/broadcast.js), which is what makes patching safe — applying
 * the same event twice lands on the same answer, and an event missed while the tab
 * was asleep is corrected by the next one rather than compounding.
 *
 * Only stock is patched here. A product created, repriced or unpublished still
 * refetches: those come from an admin editing the catalogue, they are rare, and they
 * can change which products belong in a list at all.
 */

/*
 * Absolute values make an event idempotent, but they do not make a stream of them
 * ordered: two sales of one product a moment apart send two absolute counts, and
 * applying them in the wrong order leaves the card showing the earlier, higher
 * number — with nothing on the way to correct it. Out-of-order delivery is not the
 * normal case on one socket, but a reconnect that replays, a second emitter, or a
 * room and a public broadcast racing all produce it.
 *
 * So each payload carries the moment its figures were read (see
 * server/src/realtime/broadcast.js), and anything older than what has already been
 * applied for that product is dropped.
 */

/** @type {Map<string, number>} product id → `at` of the newest event applied. */
const appliedAt = new Map();

/** Ids tracked before the oldest is forgotten. A shopper sees far fewer than this. */
const MAX_TRACKED = 500;

/**
 * Whether this event still has something to say about its product, and records it as
 * the newest seen when it does.
 *
 * Re-applying the *same* event is allowed: several screens reduce one broadcast
 * independently, and the reducers are idempotent, so only a strictly older event is
 * refused.
 */
export function isCurrentStockEvent(payload) {
  if (!payload?.at || !payload?.productId) return true;
  const id = String(payload.productId);
  const seen = appliedAt.get(id);
  if (seen !== undefined && payload.at < seen) return false;
  if (appliedAt.size >= MAX_TRACKED && seen === undefined) {
    appliedAt.delete(appliedAt.keys().next().value);
  }
  appliedAt.set(id, payload.at);
  return true;
}

/** Fields a card reads that this event can speak to. Everything else is left alone. */
function nextCard(product, payload) {
  const variants = payload.variants;

  const patched = { ...product, stock: payload.stock };

  /*
   * A varied product's tile reads the rollup, not the parent's stock, so the count
   * has to move with it — otherwise a size selling out leaves the card advertising
   * options that are gone.
   */
  if (variants && product.variantSummary) {
    patched.variantSummary = {
      ...product.variantSummary,
      inStockCount: variants.filter((v) => v.inStock).length,
    };
  }

  return patched;
}

/**
 * One card, patched. Returns the *same object* when the event is not about this
 * product or changes nothing it shows, so a memoised `<ProductCard>` does not
 * re-render for somebody else's purchase.
 */
export function applyStockToProduct(product, payload) {
  if (!product || !payload) return product;
  if (String(product._id) !== String(payload.productId)) return product;
  if (!isCurrentStockEvent(payload)) return product;
  if (product.stock === payload.stock && !payload.variants) return product;
  return nextCard(product, payload);
}

/**
 * One list of cards, patched.
 *
 * A product the event reports as no longer published is dropped: it has been
 * archived or unpublished mid-session and must not stay on a storefront grid.
 * Returns the same array reference when nothing matched.
 */
export function applyStockToList(products, payload) {
  if (!Array.isArray(products) || !payload) return products;

  const id = String(payload.productId);
  if (!products.some((p) => String(p._id) === id)) return products;
  if (!isCurrentStockEvent(payload)) return products;

  if (payload.status && payload.status !== 'published') {
    return products.filter((p) => String(p._id) !== id);
  }

  let changed = false;
  const next = products.map((p) => {
    const patched = applyStockToProduct(p, payload);
    if (patched !== p) changed = true;
    return patched;
  });

  return changed ? next : products;
}

/*
 * The two response envelopes the storefront actually holds. Both return the previous
 * state object untouched when nothing matched, so a `setData` with one of these is a
 * no-op render for every product on the site except the one that sold.
 */

/** `{ data: { products: [...] } }` — the listing, related, wishlist and by-ids reads. */
export function applyStockToListResponse(prev, payload) {
  const products = prev?.data?.products;
  const next = applyStockToList(products, payload);
  return next === products ? prev : { ...prev, data: { ...prev.data, products: next } };
}

/**
 * Either envelope, whichever this response happens to be.
 *
 * Used to sweep the whole response cache, where the shape of any given entry is not
 * known at the call site — a listing, a feed and a single product all sit in it side
 * by side. Anything it does not recognise is returned untouched.
 */
export function applyStockToAnyResponse(prev, payload) {
  if (!prev?.data) return prev;
  if (Array.isArray(prev.data.sections)) return applyStockToFeedResponse(prev, payload);
  if (Array.isArray(prev.data.products)) return applyStockToListResponse(prev, payload);
  if (prev.data.product) {
    const product = applyStockToProduct(prev.data.product, payload);
    return product === prev.data.product ? prev : { ...prev, data: { ...prev.data, product } };
  }
  return prev;
}

/** `{ data: { sections: [{ products: [...] }] } }` — the home feed. */
export function applyStockToFeedResponse(prev, payload) {
  const sections = prev?.data?.sections;
  if (!Array.isArray(sections)) return prev;

  let changed = false;
  const next = sections.map((section) => {
    const products = applyStockToList(section.products, payload);
    if (products === section.products) return section;
    changed = true;
    return { ...section, products };
  });

  return changed ? { ...prev, data: { ...prev.data, sections: next } } : prev;
}
