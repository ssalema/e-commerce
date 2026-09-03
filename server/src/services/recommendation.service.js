const mongoose = require('mongoose');
const { Product, Order, Cart, Wishlist } = require('../models');
const { createTtlCache } = require('../utils/ttlCache');

/**
 * The two curated homepage rails, computed instead of curated.
 *
 * "Top Selling" and "Products For You" used to be two booleans an admin ticked on
 * the product form. That made them a snapshot of whatever someone believed last
 * time they opened the form: a product that stopped selling stayed on the rail,
 * a runaway hit never reached it, and "For You" was the same ten products for
 * every shopper in the country.
 *
 * Both are now derived from what actually happened in the shop:
 *
 *   Top Selling — units shipped in the last 90 days, straight off the orders
 *                 collection. Cancelled and returned orders do not count; a sale
 *                 that came back was not a sale.
 *   For You     — the shopper's own signals (cart, wishlist, past orders and the
 *                 ids their browser remembers viewing) turned into an affinity for
 *                 categories, sub-categories, brands and tags, then matched against
 *                 the catalogue.
 *
 * Neither rail is ever allowed to come back empty. Each one falls through a chain
 * of weaker sources — window sales → lifetime sales → popularity — so a shop on
 * its first day, with no orders and no signed-in shopper, still renders a full
 * homepage.
 *
 * Both are *ranked lists*, not queries, which is what makes "load more" work on
 * them: the ranking is computed once, cached, and every page of the rail is a slice
 * of that one list. Paging a personalised or sales-ranked rail through the ordinary
 * `/products` sort was the bug this replaced — the continuation was ordered by
 * something else entirely, so it repeated products the shopper had already seen and
 * silently skipped others.
 */

/** How far back a sale still counts as "currently selling". */
const SALES_WINDOW_DAYS = 90;

/** A cancelled or returned order is not a sale and must not rank a product. */
const DEAD_ORDER_STATUSES = ['cancelled', 'returned'];

/**
 * How loudly each signal speaks for the shopper. Money committed outranks
 * intent, which outranks a glance: something in the cart is a stronger statement
 * of taste than something looked at once on the way past.
 */
const SIGNAL_WEIGHT = { cart: 4, order: 3, wishlist: 3, viewed: 1 };

/**
 * What a match on each facet is worth. A sub-category ("Soft-close hinges") says
 * far more about what someone is shopping for than its category ("Hardware"),
 * and a tag is the loosest hint of the four.
 */
const FACET_WEIGHT = { subCategory: 3, category: 2, brand: 2, tag: 1 };

/** How many rows to pull before scoring. Wide enough to re-rank, small enough to stay cheap. */
const POOL_SIZE = 60;

/**
 * How deep either computed rail can be paged. It is a ceiling on the ranked list,
 * so it is also the honest answer to "how many products could this rail ever show" —
 * the storefront stops offering "load more" once the shopper reaches it.
 *
 * Ranking is cheap per row (ids only) but not free, and nobody pages a homepage rail
 * a hundred products deep; the other three rails page the catalogue without a limit.
 */
const RAIL_DEPTH = 100;

/** Signals older than this stop describing what the shopper wants today. */
const SIGNAL_ORDER_LIMIT = 5; // most recent orders read for taste
const SIGNAL_ID_LIMIT = 40; // hard ceiling on source products, newest first

const DAY_MS = 24 * 60 * 60 * 1000;

/** viewCount is needed for scoring but is not part of any card payload. */
const SCORE_FIELDS = ' viewCount soldCount ratings createdAt category subCategory brand tags';

const toId = (value) => String(value?._id || value);

const asObjectIds = (ids) =>
  [...new Set(ids.map(toId))]
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

/**
 * Popularity on a 0–1 scale, relative to the pool it was drawn from — an absolute
 * scale is meaningless when one shop sells ten units a month and another ten
 * thousand. Rating is discounted by how many people left one, so a lone five-star
 * review cannot outrank a product with forty fours.
 */
function scorePool(pool) {
  const maxSold = Math.max(...pool.map((p) => p.soldCount || 0), 1);
  const maxViews = Math.max(...pool.map((p) => p.viewCount || 0), 1);
  const fresh = Date.now() - 30 * DAY_MS;

  return pool.map((product) => {
    const rating = (product.ratings?.average || 0) / 5;
    const confidence = Math.min(product.ratings?.count || 0, 10) / 10;
    const score =
      0.45 * ((product.soldCount || 0) / maxSold) +
      0.35 * ((product.viewCount || 0) / maxViews) +
      0.2 * rating * confidence +
      (new Date(product.createdAt).getTime() > fresh ? 0.1 : 0);
    return { product, score };
  });
}

/**
 * The generic "what is doing well right now" list, used wherever a personalised or
 * sales-ranked answer runs short. Drawn from the most-viewed and best-selling rows,
 * then re-ranked on the blend above so it is not a duplicate of any single sort.
 *
 * The pool has to be at least as wide as the answer being asked for, or a deep rail
 * would be re-ranking fewer rows than it needs to return.
 */
async function getTrending({ select, limit, exclude = [] }) {
  const pool = await Product.find({ status: 'published', _id: { $nin: asObjectIds(exclude) } })
    .select(select + SCORE_FIELDS)
    .sort({ viewCount: -1, soldCount: -1, createdAt: -1 })
    .limit(Math.max(POOL_SIZE, limit * 2))
    .lean({ virtuals: true });

  if (!pool.length) return [];

  return scorePool(pool)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.product);
}

/**
 * The ranking is the same list for every visitor and it is derived from a 90-day
 * window, so recomputing it per homepage hit buys nothing: a sale placed one minute
 * ago cannot meaningfully reorder ninety days of them.
 *
 * It is cached here rather than left to the HTTP layer because the home-feed URL
 * carries the visitor's own `?seen=` ids — every browser asks for a different URL,
 * so `cache.catalogue` in front of the route almost never hits for this endpoint.
 * That left an `$unwind`/`$group` over the orders collection, plus its round trip,
 * on the critical path of every single home page load.
 */
const salesRankingCache = createTtlCache({ ttlMs: 60 * 1000, max: 4 });

/**
 * Units shipped per product inside the window. Returns ids in rank order — the
 * documents themselves are fetched separately, because an order item is a frozen
 * snapshot and may name a product that has since been unpublished or deleted.
 */
function recentSalesRanking(limit) {
  return salesRankingCache.resolve(String(limit), async () => {
    const since = new Date(Date.now() - SALES_WINDOW_DAYS * DAY_MS);

    const rows = await Order.aggregate([
      { $match: { createdAt: { $gte: since }, orderStatus: { $nin: DEAD_ORDER_STATUSES } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product', units: { $sum: '$items.quantity' } } },
      { $sort: { units: -1 } },
      // Over-fetch: some of these will be unpublished by the time they are resolved.
      { $limit: limit * 3 },
    ]);

    return rows.map((row) => row._id).filter(Boolean);
  });
}

/** Re-orders documents to match a ranked list of ids, dropping any that no longer resolve. */
function orderByIds(products, ids) {
  const byId = new Map(products.map((p) => [toId(p), p]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

/**
 * Turns one page of a ranked id list into card payloads, in rank order.
 *
 * Ranking is done on ids alone; the documents are only fetched for the slice the
 * shopper is actually about to see, so paging a rail costs one small `$in` read
 * rather than re-reading everything above it.
 */
async function fetchRanked(ids, select) {
  if (!ids.length) return [];
  const docs = await Product.find({ _id: { $in: asObjectIds(ids) }, status: 'published' })
    .select(select)
    .lean({ virtuals: true });
  return orderByIds(docs, ids);
}

/**
 * The ranked list behind "Top Selling Products" — real sales, most recent 90 days
 * first — as ids.
 *
 * The fallback chain matters on a young shop: no orders in the window falls back to
 * lifetime `soldCount`, and no sales at all falls back to trending, so the rail is
 * populated from the first day rather than waiting for the first delivery.
 *
 * Cached for the same reason the sales aggregate is: it is the same list for every
 * visitor, and every page of the rail — the first one and each "load more" after it —
 * must be a slice of the *same* ranking or the shopper sees products twice.
 */
const topSellingCache = createTtlCache({ ttlMs: 60 * 1000, max: 4 });

function rankTopSelling({ depth = RAIL_DEPTH } = {}) {
  return topSellingCache.resolve(String(depth), async () => {
    const rankedIds = await recentSalesRanking(depth);

    let products = [];
    if (rankedIds.length) {
      // An order item is a frozen snapshot: some of the ids it names are unpublished
      // or deleted by now, so the ranking is intersected with the live catalogue.
      const found = await Product.find({ _id: { $in: rankedIds }, status: 'published' })
        .select('_id')
        .lean();
      products = orderByIds(found, rankedIds).slice(0, depth);
    }

    if (products.length < depth) {
      const topUp = await Product.find({
        status: 'published',
        soldCount: { $gt: 0 },
        _id: { $nin: asObjectIds(products) },
      })
        .select('_id')
        // `_id` breaks ties: without it two products on the same sold count have no
        // defined order, and a ranking that reshuffles between pages is the same bug
        // in a smaller costume.
        .sort({ soldCount: -1, 'ratings.average': -1, _id: -1 })
        .limit(depth - products.length)
        .lean();
      products = products.concat(topUp);
    }

    if (products.length < depth) {
      const topUp = await getTrending({
        select: '_id',
        limit: depth - products.length,
        exclude: products,
      });
      products = products.concat(topUp);
    }

    return products.map(toId);
  });
}

/**
 * One page of "Top Selling Products".
 *
 * `total` is the depth of the ranking, not the size of the catalogue — it is what the
 * storefront needs to decide whether "load more" has anything behind it.
 */
async function getTopSelling({ select, limit = 10, offset = 0 }) {
  const ids = await rankTopSelling();
  return {
    products: await fetchRanked(ids.slice(offset, offset + limit), select),
    total: ids.length,
  };
}

/**
 * Everything this shopper has told us about their taste, without asking them anything.
 *
 * Signed in, that is their cart, their wishlist and their recent orders. Signed out —
 * which is most visitors — it is the recently-viewed ids their own browser keeps and
 * sends with the request. A visitor who has done none of the four has no taste to read
 * and gets the trending rail instead.
 */
async function collectSignals(userId, seenIds) {
  const weights = new Map();
  const add = (productId, weight) => {
    if (!productId) return;
    const key = toId(productId);
    if (!mongoose.isValidObjectId(key)) return;
    weights.set(key, Math.max(weights.get(key) || 0, weight));
  };

  (seenIds || []).slice(0, 20).forEach((id) => add(id, SIGNAL_WEIGHT.viewed));

  if (userId) {
    const [cart, wishlist, orders] = await Promise.all([
      Cart.findOne({ user: userId }).select('items.product items.savedForLater').lean(),
      Wishlist.findOne({ user: userId }).select('products.product').lean(),
      Order.find({ user: userId, orderStatus: { $nin: DEAD_ORDER_STATUSES } })
        .select('items.product')
        .sort({ createdAt: -1 })
        .limit(SIGNAL_ORDER_LIMIT)
        .lean(),
    ]);

    (cart?.items || []).forEach((item) => add(item.product, SIGNAL_WEIGHT.cart));
    (wishlist?.products || []).forEach((row) => add(row.product, SIGNAL_WEIGHT.wishlist));
    orders.forEach((order) => (order.items || []).forEach((item) => add(item.product, SIGNAL_WEIGHT.order)));
  }

  return [...weights.entries()].slice(0, SIGNAL_ID_LIMIT).map(([id, weight]) => ({ id, weight }));
}

/**
 * Turns the source products into weighted facet maps — "this shopper is worth 7 of
 * Hardware, 4 of Hettich, 3 of soft-close". The weight of the signal carries through,
 * so a category reached from the cart pulls harder than one reached from a glance.
 */
function buildAffinity(sources, weightById) {
  const facets = { category: new Map(), subCategory: new Map(), brand: new Map(), tag: new Map() };
  const bump = (map, key, amount) => {
    if (!key) return;
    map.set(String(key), (map.get(String(key)) || 0) + amount);
  };

  sources.forEach((product) => {
    const weight = weightById.get(toId(product)) || 1;
    bump(facets.category, product.category, weight);
    bump(facets.subCategory, product.subCategory, weight);
    bump(facets.brand, product.brand, weight);
    (product.tags || []).slice(0, 5).forEach((tag) => bump(facets.tag, tag, weight));
  });

  return facets;
}

/**
 * The ranked list behind "Products For You" — the catalogue filtered to what this
 * shopper keeps coming back to, ranked by how strongly it matches plus how well it is
 * doing generally — as ids.
 *
 * Source products are excluded from the result: recommending the item already sitting
 * in their cart, or the one they are looking at, is the failure mode this rail exists
 * to avoid. `excludeIds` lets the caller keep the rail distinct from Top Selling above it.
 *
 * Cached per shopper for a minute, keyed on everything that shapes the answer. That is
 * partly cost — this is the most expensive read on the homepage — but mainly
 * correctness: "load more" is a slice of this list, and a ranking recomputed between
 * pages (a wishlist add, a cart change) would drop products out from under the shopper
 * or repeat them.
 */
const forYouCache = createTtlCache({ ttlMs: 60 * 1000, max: 200 });

function rankForYou({ userId, seenIds = [], excludeIds = [], depth = RAIL_DEPTH }) {
  const key = [
    userId ? toId(userId) : 'anon',
    [...seenIds].map(toId).sort().join(','),
    [...excludeIds].map(toId).sort().join(','),
    depth,
  ].join('|');

  return forYouCache.resolve(key, () => buildForYou({ userId, seenIds, excludeIds, depth }));
}

async function buildForYou({ userId, seenIds, excludeIds, depth }) {
  const limit = depth;
  const select = '_id';
  const signals = await collectSignals(userId, seenIds);

  // Nothing known about this visitor — trending is the honest answer.
  if (!signals.length) {
    return (await getTrending({ select, limit, exclude: excludeIds })).map(toId);
  }

  const weightById = new Map(signals.map((s) => [s.id, s.weight]));
  const sources = await Product.find({ _id: { $in: asObjectIds(signals.map((s) => s.id)) } })
    .select('category subCategory brand tags')
    .lean();

  const facets = buildAffinity(sources, weightById);
  const categories = asObjectIds([...facets.category.keys()]);
  const subCategories = asObjectIds([...facets.subCategory.keys()]);
  const brands = [...facets.brand.keys()];
  const tags = [...facets.tag.keys()];

  // Everything the shopper has already engaged with, plus whatever the caller reserved.
  const excluded = asObjectIds([...signals.map((s) => s.id), ...excludeIds.map(toId)]);

  const or = [];
  if (subCategories.length) or.push({ subCategory: { $in: subCategories } });
  if (categories.length) or.push({ category: { $in: categories } });
  if (brands.length) or.push({ brand: { $in: brands } });
  if (tags.length) or.push({ tags: { $in: tags } });

  let products = [];
  if (or.length) {
    const pool = await Product.find({ status: 'published', _id: { $nin: excluded }, $or: or })
      .select(select + SCORE_FIELDS)
      .sort({ soldCount: -1, viewCount: -1, _id: -1 })
      // Wide enough to still be re-ranking rather than just returning, at any depth.
      .limit(Math.max(POOL_SIZE, limit * 2))
      .lean({ virtuals: true });

    /*
     * Affinity decides the order, popularity only breaks ties. A shopper who has been
     * pricing plywood all week should see plywood first even if a drill outsells it
     * ten to one — the popular rails elsewhere on the page already cover the drill.
     */
    const maxFacet = Math.max(
      ...[facets.category, facets.subCategory, facets.brand, facets.tag].flatMap((m) => [...m.values()]),
      1
    );

    products = scorePool(pool)
      .map(({ product, score }) => {
        const affinity =
          FACET_WEIGHT.subCategory * (facets.subCategory.get(toId(product.subCategory)) || 0) +
          FACET_WEIGHT.category * (facets.category.get(toId(product.category)) || 0) +
          FACET_WEIGHT.brand * (facets.brand.get(product.brand) || 0) +
          FACET_WEIGHT.tag * (product.tags || []).reduce((sum, tag) => sum + (facets.tag.get(tag) || 0), 0);
        // Normalised so the popularity blend stays a tiebreak rather than a second opinion.
        return { product, total: affinity / (maxFacet * 8) + score * 0.3 };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
      .map((row) => row.product);
  }

  // A shopper whose taste is one tiny corner of the catalogue still gets a full rail.
  if (products.length < limit) {
    const topUp = await getTrending({
      select,
      limit: limit - products.length,
      exclude: [...excludeIds, ...products.map(toId), ...signals.map((s) => s.id)],
    });
    products = products.concat(topUp);
  }

  return products.map(toId);
}

/**
 * One page of "Products For You". `total` is the depth of the ranking — see
 * `getTopSelling` — so the storefront only offers "load more" while there is more of
 * *this shopper's* list to show.
 */
async function getForYou({ userId, seenIds = [], excludeIds = [], select, limit = 10, offset = 0 }) {
  const ids = await rankForYou({ userId, seenIds, excludeIds });
  return {
    products: await fetchRanked(ids.slice(offset, offset + limit), select),
    total: ids.length,
  };
}

module.exports = { getTopSelling, getForYou, getTrending, rankTopSelling, RAIL_DEPTH };
