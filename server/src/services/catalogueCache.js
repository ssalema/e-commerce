/**
 * Memo for the three catalogue reads that cost far more than the payload they return.
 *
 * All three are driven by the shopper rather than by an admin, so they are asked
 * constantly, and none of them can be answered from an index alone:
 *
 *   filters   `GET /products/filters` is a four-branch `$facet`. Only the leading
 *             `$match` uses an index; each branch then walks the matched set again.
 *             The sidebar asks for it on every filter change, alongside the listing
 *             query it accompanies.
 *   counts    the `countDocuments` that rides with every listing page. Under a text
 *             search it is a second full pass over the same regex the find just ran.
 *   search    the header's live suggestions, which fire per keystroke and match with
 *             an unanchored case-insensitive regex — unindexable by construction.
 *
 * Same shape as `dashboardCache`: correctness rests on the invalidation, and the TTL
 * is the backstop for whatever reaches the database without passing through a
 * broadcast (a seed run, an edit in Atlas, another instance of this process).
 *
 * It lives in its own module rather than in the controller because `realtime/broadcast`
 * has to clear it, and a broadcast requiring a controller would close a cycle.
 *
 * Deliberately *not* cleared on a stock change. Stock moves on every order placed, so
 * clearing there would empty the cache continuously and leave it doing nothing at all
 * on exactly the busy day it is for. The cost of that choice is bounded and small: for
 * up to one TTL an `availability` filter's counts can lag, which is a number beside a
 * checkbox, not the buy box — the listing rows themselves are re-read either way.
 */

const { createTtlCache } = require('../utils/ttlCache');

/*
 * Windows are short because these answers are visibly derived from the catalogue, and
 * generous entry ceilings because the keys are per filter combination and per search
 * term — a cache that evicts faster than shoppers arrive is a cache that never hits.
 */
const filterMetaCache = createTtlCache({ ttlMs: 60 * 1000, max: 300 });
const countCache = createTtlCache({ ttlMs: 30 * 1000, max: 500 });
const searchCache = createTtlCache({ ttlMs: 60 * 1000, max: 500 });

/**
 * A stable string for a Mongo filter, so two requests that mean the same thing share
 * an entry. Keys are sorted at every level: `?brand=x&category=y` and
 * `?category=y&brand=x` are one query and must not be two rows.
 */
function cacheKey(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(cacheKey).join(',')}]`;
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${cacheKey(value[k])}`)
      .join(',')}}`;
  }
  return String(value);
}

const resolveFilterMeta = (key, loader) => filterMetaCache.resolve(key, loader);
const resolveCount = (key, loader) => countCache.resolve(key, loader);
const resolveSearch = (key, loader) => searchCache.resolve(key, loader);

/**
 * Drops everything. Called from the catalogue broadcasts — a product created, edited,
 * withdrawn or re-variantised can change any facet, any count and any suggestion, and
 * working out which is not worth the bookkeeping for an admin action that happens a
 * few times a day.
 */
function clearAll() {
  filterMetaCache.clear();
  countCache.clear();
  searchCache.clear();
}

module.exports = { cacheKey, resolveFilterMeta, resolveCount, resolveSearch, clearAll };
