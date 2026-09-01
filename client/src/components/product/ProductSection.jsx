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

/**
 * A homepage product band: heading, a plain responsive grid, and a "Load more"
 * button — no horizontal scrolling and no arrows.
 *
 * The feed endpoint sends the first ten products of each band with the page. Past
 * that the section pages through /products itself using `moreQuery` — the filter and
 * sort that define the band — so "load more" keeps going until the catalogue is
 * genuinely exhausted rather than until the feed payload runs out. That is also why
 * there is no "View all" link: the whole listing is reachable here, in place.
 */
export default function ProductSection({
  title,
  subtitle,
  products = NO_PRODUCTS,
  loading = false,
  moreQuery,
  skeletonCount = INITIAL_COUNT,
}) {
  const { t } = useTranslation();

  // Products fetched by this component, appended after the ones the feed sent.
  const [extra, setExtra] = useState([]);
  const [visible, setVisible] = useState(INITIAL_COUNT);
  const [busy, setBusy] = useState(false);
  // No `moreQuery` means the caller owns the whole list — reveal it and stop.
  const [exhausted, setExhausted] = useState(!moreQuery);

  // Where the next /products request starts. Counts rows *received*, not rows kept,
  // so duplicates dropped below are not asked for a second time.
  const offsetRef = useRef(0);

  /*
   * A refetch (language switch, a live catalogue event) replaces the feed's copy of
   * the band. Anything paged in on top of it was ranked against the old list, so it
   * is dropped rather than merged — keeping it risks showing a product twice.
   */
  useEffect(() => {
    setExtra([]);
    setVisible(INITIAL_COUNT);
    setExhausted(!moreQuery);
    offsetRef.current = 0;
  }, [products, moreQuery]);

  const pool = useMemo(() => products.concat(extra), [products, extra]);

  const loadMore = useCallback(async () => {
    const want = visible + STEP;

    // Already fetched and simply not shown yet.
    if (pool.length >= want || exhausted) {
      setVisible(Math.min(want, pool.length));
      return;
    }

    setBusy(true);
    const seen = new Set(pool.map((p) => p._id));
    const added = [];
    let done = false;

    try {
      while (pool.length + added.length < want && !done) {
        const res = await productApi.list({
          ...moreQuery,
          limit: FETCH_SIZE,
          offset: offsetRef.current,
        });
        const rows = res?.data?.products || [];
        const total = res?.meta?.total;

        offsetRef.current += rows.length;
        if (rows.length < FETCH_SIZE || (total != null && offsetRef.current >= total)) done = true;

        rows.forEach((product) => {
          if (seen.has(product._id)) return;
          seen.add(product._id);
          added.push(product);
        });
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
  }, [exhausted, moreQuery, pool, visible]);

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
  const hasMore = visible < pool.length || !exhausted;
  // A full batch is what was asked for; the last one on a short catalogue may land
  // smaller, which shows for the moment the request is in flight and no longer.
  const incoming = STEP;

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
