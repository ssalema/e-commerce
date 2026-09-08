import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { catalogApi, productApi } from '../api/endpoints';
import { getAccessToken } from '../api/client';
import useFetch from '../hooks/useFetch';
import { useLiveRefetch, useLiveStockPatch } from '../realtime/useRealtime';
import { CATALOG_STRUCTURE_EVENTS, EVENTS } from '../realtime/events';
import { applyStockToFeedResponse, applyStockToListResponse } from '../utils/stockPatch';
import { fetchCategories, refreshCategories } from '../store/catalogSlice';
import { getRecentlyViewed } from '../utils/recentlyViewed';
import useSettings from '../settings/useSettings';
import useLanguage from '../i18n/useLanguage';
import { consumeWelcomePending } from '../i18n/welcomePrompt';
import Seo from '../components/common/Seo';
import HeroSlider from '../components/home/HeroSlider';
import CategoryStrip from '../components/home/CategoryStrip';
import ProductSection from '../components/product/ProductSection';
import ErrorState from '../components/common/ErrorState';
import SectionError from '../components/common/SectionError';

/**
 * The home page is three independent loads — banners, the category taxonomy and the
 * product rails — and they are kept independent on purpose: one of them failing
 * leaves the other two on screen, each reporting only itself.
 *
 * What they share is the retry. Whichever band the shopper clicks "Try again" on
 * re-runs *every* band that is currently failing, because "the page didn't load" is
 * one problem to the person looking at it, and repairing a third of it per click was
 * the bug that made a browser refresh feel mandatory.
 */
export default function Home() {
  // `shop` streams in with this route chunk; `common` is already resolved.
  const { t } = useTranslation(['shop', 'common']);
  const dispatch = useDispatch();
  const {
    categories,
    loading: categoriesLoading,
    loaded: categoriesLoaded,
    error: categoriesError,
  } = useSelector((s) => s.catalog);
  const { siteName } = useSettings();
  const { openWelcome } = useLanguage();

  // The far end of the sign-up: a shopper who has just created and verified an
  // account is asked which language they want. An ordinary visit — first or
  // hundredth — leaves the flag unset and this does nothing.
  useEffect(() => {
    if (consumeWelcomePending()) openWelcome();
  }, [openWelcome]);

  /*
   * Categories are fetched once for the whole app in <App>, which means a load that
   * failed during boot has no second chance — the effect there depends on `dispatch`
   * alone and never runs again, so the strip stayed empty until a manual refresh.
   *
   * Asking again here costs nothing: the thunk's condition guard drops the dispatch
   * once the taxonomy is in the store, so this only does work when there is nothing
   * to show, which is exactly the case that was stuck.
   */
  useEffect(() => {
    dispatch(fetchCategories());
  }, [dispatch]);

  /*
   * `cacheKey` opts these three into the shared response cache in useFetch. The home
   * page is where a shopper returns after every product they look at, and it was
   * rebuilding itself from scratch each time. Now it paints from the last answer and
   * revalidates behind the paint.
   */
  const banners = useFetch(useCallback(() => catalogApi.banners('hero'), []), [], {
    cacheKey: 'banners:hero',
  });

  // Recently viewed is resolved from localStorage ids, so it survives logout. Read
  // once into state so the list is a stable dependency rather than a new array on
  // every render.
  const [recentIds] = useState(getRecentlyViewed);

  /*
   * The "For You" rail is computed per shopper, so the feed carries both halves of
   * who is asking: the session (sent automatically, read server-side from the cart,
   * wishlist and past orders) and these ids, which are the only taste signal a
   * signed-out visitor has. Signing in or out therefore has to re-ask — the rail it
   * returned a moment ago was built for somebody else.
   */
  /*
   * Who is asking is read from the access token rather than from `auth.isAuthenticated`,
   * and that distinction is the whole point.
   *
   * The rail used to wait for `/auth/me` to come back before it would ask for anything.
   * The reasoning was sound as far as it went — a signed-in visitor's store says
   * "anonymous" for as long as that call is in flight, so asking early fetched a rail
   * built for nobody and then immediately fetched it again under the real identity.
   * But waiting put the site's two slowest calls in a queue on the critical path of
   * first paint, and the shopper watched an empty page for the length of both.
   *
   * Neither is necessary, because the store was never the right thing to read. The
   * token is restored from localStorage synchronously at module load and the request
   * interceptor attaches it, so a feed requested on the very first frame is *already*
   * authenticated — the server builds the right shopper's rail whether or not
   * `/auth/me` has answered yet. Reading the token directly gives a value that is
   * correct from the first render and changes only on a real sign-in or sign-out, so
   * the two requests now go out together and neither answer is thrown away.
   */
  // Subscribing to the store is what re-renders this component when a sign-in or a
  // sign-out changes the token underneath it; the token is what is read, because it is
  // correct a full round trip before the store is.
  const isAuthenticated = useSelector((s) => s.auth.isAuthenticated);
  const identity = getAccessToken() || isAuthenticated ? 'auth' : 'anon';

  const feed = useFetch(
    useCallback(() => productApi.homeFeed(recentIds), [recentIds]),
    [recentIds, identity],
    {
      // Both halves of who is asking are in the key, so the rail a signed-in shopper
      // was shown is never painted for the anonymous visitor who follows them.
      cacheKey: ['home-feed', identity, recentIds.join(',')],
    }
  );

  /*
   * Every rail is derived from the catalogue, so a product published, repriced or
   * withdrawn genuinely reshuffles them and the feed has to be re-read. Those are
   * admin edits, and they are rare enough to afford it.
   *
   * Stock is deliberately not among them. It moves on every order, it is broadcast to
   * every visitor, and refetching this endpoint — the most expensive read the API
   * serves — on each one meant a single checkout cost a full rebuild for every shopper
   * browsing at that moment. The broadcast carries absolute stock, so the rails are
   * corrected in place instead.
   */
  useLiveRefetch(feed.refetch, CATALOG_STRUCTURE_EVENTS);
  useLiveStockPatch(feed.setData, applyStockToFeedResponse);
  useLiveRefetch(banners.refetch, EVENTS.BANNER_CHANGED);

  const recent = useFetch(
    useCallback(() => productApi.byIds(recentIds), [recentIds]),
    [recentIds],
    { enabled: recentIds.length > 0, cacheKey: ['by-ids', recentIds.join(',')] }
  );

  // Same treatment for the recently-viewed strip: it renders the same cards, so it
  // needs the same correction and has the same reason not to re-request the list.
  useLiveStockPatch(recent.setData, applyStockToListResponse);

  const sections = feed.data?.data?.sections || [];
  const slides = banners.data?.data?.banners || [];
  const recentProducts = recent.data?.data?.products || [];

  const { error: bannersError, refetch: refetchBanners } = banners;
  const { error: feedError, refetch: refetchFeed } = feed;

  /*
   * A band counts as failed only when it has nothing to render. A live refetch that
   * fails behind an already-populated rail is not worth replacing that rail with an
   * apology — the shopper keeps the slightly stale copy and the next socket event or
   * revisit corrects it.
   */
  const bannersFailed = Boolean(bannersError) && !slides.length;
  const categoriesFailed = Boolean(categoriesError) && !categories.length;
  const feedFailed = Boolean(feedError) && !sections.length;

  const retryFailed = useCallback(() => {
    if (bannersError) refetchBanners();
    if (feedError) refetchFeed();
    /*
     * `refreshCategories` rather than `fetchCategories`: the cached-already guard on
     * the latter is the wrong instinct for a button whose entire job is "ask again".
     * It has no guard of its own though, so the in-flight check lives here — a retry
     * fired for a *different* band must not stack a second categories request on top
     * of one that is already running.
     */
    if (!categoriesLoading && (categoriesError || !categoriesLoaded)) {
      dispatch(refreshCategories());
    }
  }, [
    bannersError,
    refetchBanners,
    feedError,
    refetchFeed,
    categoriesError,
    categoriesLoaded,
    categoriesLoading,
    dispatch,
  ]);

  const seoJsonLd = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: siteName,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${window.location.origin}/products?search={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    }),
    [siteName]
  );

  return (
    <>
      <Seo
        title={t('home.seoTitle')}
        description={t('home.seoDescription')}
        path="/"
        jsonLd={seoJsonLd}
      />

      {/* The hero carries the page visually, so the heading is for the machines and
          the screen readers only — without it this route's outline opened at <h2>,
          which is the one heading level that is supposed to have a parent. */}
      <h1 className="sr-only">{`${siteName} — ${t('home.seoTitle')}`}</h1>

      {bannersFailed ? (
        <SectionError
          className="pt-4"
          title={t('home.bannersError')}
          message={bannersError.message}
          onRetry={retryFailed}
        />
      ) : (
        <HeroSlider slides={slides} loading={banners.loading} />
      )}

      {categoriesFailed ? (
        <SectionError
          className="py-6"
          title={t('home.categoriesError')}
          message={categoriesError}
          onRetry={retryFailed}
        />
      ) : (
        <CategoryStrip categories={categories} loading={categoriesLoading && !categories.length} />
      )}

      {feedFailed ? (
        <ErrorState
          title={t('home.feedError')}
          message={feedError.message}
          onRetry={retryFailed}
        />
      ) : /* No gap to cover any more: the feed is requested on the first frame rather
             than after the session call, so its own loading flag is up from the start. */
      feed.loading && !sections.length ? (
        <>
          <ProductSection title={t('home.forYou')} loading />
          <ProductSection title={t('home.topSelling')} loading />
        </>
      ) : (
        sections.map((section) => (
          <div key={section.key}>
            {/* The API sends a stable `key` plus English copy; the heading itself is
                interface text, so it is translated here and the server's title is
                only the fallback. */}
            <ProductSection
              title={t(`home.sections.${section.key}.title`, section.title)}
              subtitle={t(`home.sections.${section.key}.subtitle`, section.subtitle)}
              products={section.products}
              /* Each band continues from the server-side rail it opened with — the
                 same ranking, the same filter, the same personalisation — so "load
                 more" appends what comes next in *this* band rather than the next
                 page of a listing query that merely resembles it. */
              railKey={section.key}
              railSeen={recentIds}
              total={section.total}
            />
          </div>
        ))
      )}

      {/* The quietest band on the page: it is a convenience built from ids this
          browser already had, so a failure just leaves it out rather than asking
          the shopper to do anything about it. */}
      {/* Grid like every band above it — the homepage reads as one layout rather
          than a grid page with one rail left over. It has no `railKey` because the
          list is finite by definition: it is what this browser remembers. */}
      {recentProducts.length > 0 && (
        <ProductSection
          title={t('home.recentlyViewed')}
          subtitle={t('home.recentlyViewedSubtitle')}
          products={recentProducts}
        />
      )}
    </>
  );
}
