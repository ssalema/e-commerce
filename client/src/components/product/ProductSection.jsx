import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { productApi } from '../../api/endpoints';
import { PRODUCT_GRID_COLUMNS } from '../../utils/constants';
import ProductCard from './ProductCard';
import Spinner from '../common/Spinner';
import { Skeleton, ProductCardSkeleton, ProductGridSkeleton } from '../common/Skeleton';

/** First screenful: two rows of five on a wide screen. */
const INITIAL_COUNT = 10;
/** Every "Load more" after that. */
const STEP = 15;
/**
 * What one request to /products asks for. Larger than STEP on purpose: rows the
 * rail is already showing are filtered out of the answer, so a batch of exactly
 * 15 would frequently reveal fewer than 15 new cards.
 */
const FETCH_SIZE = 30;

/** Stable identity: the reset effect below keys on `products`, so the empty default
 *  must not be a new array on every render. */
const NO_PRODUCTS = [];
const NO_IDS = [];

/**
 * A homepage product band: heading, a plain responsive grid, and a "Load more"
 * button — no horizontal scrolling and no arrows.
 *
 * The feed endpoint sends the first ten products of each band with the page. Past
 * that the section asks the same server-side rail for its next page by `railKey`, so
 * the products that arrive are the continuation of *this* band — ranked and filtered
 * exactly as its first ten were — rather than a listing query that resembles it. A
 * band with no `railKey` owns its whole list and never asks for more.
 *
 * It is also why there is no "View all" link: the whole rail is reachable here, in
 * place, without losing the shopper's position.
 */
export default function ProductSection({
  title,
  subtitle,
  products = NO_PRODUCTS,
  loading = false,
  railKey,
  railSeen = NO_IDS,
  total,
  skeletonCount = INITIAL_COUNT,
}) {
  const { t } = useTranslation();

  // Products fetched by this component, appended after the ones the feed sent.
  const [extra, setExtra] = useState([]);
  const [visible, setVisible] = useState(INITIAL_COUNT);
  const [busy, setBusy] = useState(false);
  // No `railKey` means the caller owns the whole list — reveal it and stop.
  const [exhausted, setExhausted] = useState(!railKey);

  /*
   * Where the next request into the rail starts: after the rows the feed already sent,
   * which are that rail's own first page. It counts rows *received*, not rows kept, so
   * anything dropped as a duplicate below is not asked for a second time.
   */
  const offsetRef = useRef(products.length);

  /*
   * A refetch (language switch, a live catalogue event) replaces the feed's copy of
   * the band. Anything paged in on top of it was ranked against the old list, so it
   * is dropped rather than merged — keeping it risks showing a product twice.
   */
  useEffect(() => {
    setExtra([]);
    setVisible(INITIAL_COUNT);
    setExhausted(!railKey);
    offsetRef.current = products.length;
  }, [products, railKey]);

  const pool = useMemo(() => products.concat(extra), [products, extra]);

  const loadMore = useCallback(async () => {
    const want = visible + STEP;

    // Already fetched and simply not shown yet.
    if (pool.length >= want || exhausted) {
      setVisible(Math.min(want, pool.length));
      return;
    }

    setBusy(true);
    // The rail hands back a slice of one ordered list, so a repeat should not happen;
    // this is the belt to that braces, and it also covers the rail being re-ranked
    // server-side between two clicks.
    const seen = new Set(pool.map((p) => p._id));
    const added = [];
    let done = false;

    try {
      while (pool.length + added.length < want && !done) {
        const res = await productApi.rail(railKey, {
          offset: offsetRef.current,
          limit: FETCH_SIZE,
          seen: railSeen,
        });
        const rows = res?.data?.products || [];
        const railTotal = res?.meta?.total;

        offsetRef.current += rows.length;
        if (rows.length < FETCH_SIZE || (railTotal != null && offsetRef.current >= railTotal)) {
          done = true;
        }

        rows.forEach((product) => {
          if (seen.has(product._id)) return;
          seen.add(product._id);
          added.push(product);
        });

        // The ceiling the feed sent with the band, in case the rail's own is stale.
        if (total != null && pool.length + added.length >= total) done = true;
      }
    } catch {
      // A failed page is not worth an error panel under a band that is still full:
      // the button simply stops offering more.
      done = true;
    }

    setExtra((current) => current.concat(added));
    setVisible(Math.min(want, pool.length + added.length));
    if (done) setExhausted(true);
    setBusy(false);
  }, [exhausted, railKey, railSeen, pool, total, visible]);

  if (loading) {
    return (
      <section className="py-6">
        <div className="container-page">
          {/* Mirrors the real header below — same block, same spacing — so the
              band does not shift when the products land. */}
          <div className="mb-4">
            <Skeleton className="mb-2 h-7 w-48" />
            <Skeleton className="h-3.5 w-32" />
          </div>
          <ProductGridSkeleton count={skeletonCount} columns={PRODUCT_GRID_COLUMNS.full} />
        </div>
      </section>
    );
  }

  if (!pool.length) return null;

  const shown = pool.slice(0, visible);

  /*
   * The button is offered only when there is something behind it. `total` is what the
   * band could ever show, counted server-side against the same filter this component
   * pages with — a band of two products on a two-product shop therefore never offers
   * it. Without a `total` (the recently-viewed band, which owns its whole list) the
   * only question left is whether anything fetched is still hidden.
   */
  const remaining = total != null ? total - shown.length : null;
  const hasMore =
    shown.length < pool.length || (!exhausted && (remaining == null ? false : remaining > 0));

  // The batch being fetched, never more than what is left to fetch.
  const incoming = Math.min(STEP, remaining ?? STEP);

  return (
    <section className="py-6">
      <div className="container-page">
        {/* No "View all": the band pages through the whole catalogue in place, so
            sending the shopper to a listing page would only lose their position. */}
        <div className="mb-4">
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
        </div>

        <div className={`grid gap-4 ${PRODUCT_GRID_COLUMNS.full}`}>
          {shown.map((product) => (
            <ProductCard key={product._id} product={product} />
          ))}

          {/* The batch being fetched, drawn in place: the rows the shopper just asked
              for appear immediately as placeholders and fill in where they stand,
              rather than the page staying still until the request lands. */}
          {busy &&
            Array.from({ length: incoming }).map((_, i) => (
              <ProductCardSkeleton key={`pending-${i}`} />
            ))}
        </div>

        {hasMore && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={busy}
              className="btn-outline btn-lg px-10"
            >
              {/* The app's busy convention everywhere else: the label stays put and
                  a spinner joins it. `.btn` already dims a disabled button. */}
              {busy && <Spinner size={14} />}
              {t('actions.loadMore')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
