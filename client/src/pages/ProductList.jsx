import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { productApi } from '../api/endpoints';
import useFetch from '../hooks/useFetch';
import useMediaQuery from '../hooks/useMediaQuery';
import { useLiveRefetch, useLiveStockPatch } from '../realtime/useRealtime';
import { CATALOG_STRUCTURE_EVENTS } from '../realtime/events';
import { applyStockToListResponse } from '../utils/stockPatch';
import { PRODUCT_GRID_COLUMNS, SORT_OPTIONS } from '../utils/constants';
import Seo from '../components/common/Seo';
import Icon from '../components/common/Icon';
import Breadcrumb from '../components/common/Breadcrumb';
import Pagination from '../components/common/Pagination';
import Modal from '../components/common/Modal';
import ErrorState from '../components/common/ErrorState';
import ProductGrid from '../components/product/ProductGrid';
import FilterSidebar from '../components/product/FilterSidebar';

const FILTER_KEYS = [
  'category', 'subCategory', 'brand', 'minPrice', 'maxPrice',
  'minDiscount', 'minRating', 'availability', 'search',
];

/**
 * The URL is the single source of truth for filters, so a filtered view is
 * shareable, bookmarkable and survives a refresh or a back-button press.
 */
export default function ProductList() {
  const { t } = useTranslation(['shop', 'common']);
  const [searchParams, setSearchParams] = useSearchParams();
  const categories = useSelector((s) => s.catalog.categories);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Mirrors the lg:hidden on the button that opens it — see the dialog below.
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const filters = useMemo(() => {
    const result = {};
    FILTER_KEYS.forEach((key) => {
      const value = searchParams.get(key);
      if (value) result[key] = value;
    });
    return result;
  }, [searchParams]);

  const page = Number(searchParams.get('page')) || 1;
  const sort = searchParams.get('sort') || 'newest';

  const queryParams = useMemo(() => ({ ...filters, page, sort, limit: 12 }), [filters, page, sort]);

  /*
   * Both are keyed into the shared response cache. Paging forward and back, and
   * returning to the grid from a product, are the two things shoppers do most on this
   * screen, and both were full round trips for a list the tab had just been given.
   * The sidebar's facets change far less often than the page number, so they are keyed
   * on the filters alone and survive paging untouched.
   */
  const { data, loading, error, refetch, setData } = useFetch(
    useCallback(() => productApi.list(queryParams), [queryParams]),
    [queryParams],
    { cacheKey: ['products', JSON.stringify(queryParams)] }
  );

  const metaQuery = useFetch(
    useCallback(() => productApi.filterMeta(filters), [filters]),
    [filters],
    { cacheKey: ['filter-meta', JSON.stringify(filters)] }
  );

  /*
   * The grid and the sidebar counts are both derived from the same catalogue, so a
   * product added, repriced or withdrawn re-reads both.
   *
   * A stock change re-reads neither. It arrives on every order placed, to every
   * visitor, and these two requests — a filtered listing and a `$facet` over the whole
   * matching set — are among the more expensive the API answers. The grid patches the
   * affected card from the payload instead; the sidebar's counts are per brand and
   * sub-category and do not move with stock at all.
   */
  useLiveRefetch(refetch, CATALOG_STRUCTURE_EVENTS);
  useLiveRefetch(metaQuery.refetch, CATALOG_STRUCTURE_EVENTS);
  useLiveStockPatch(setData, applyStockToListResponse);

  const products = data?.data?.products || [];
  const meta = data?.meta;
  const filterMeta = metaQuery.data?.data;

  const updateParams = (patch, { resetPage = true } = {}) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '' || value === null) next.delete(key);
      else next.set(key, String(value));
    });
    if (resetPage) next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const resetFilters = () => {
    const next = new URLSearchParams();
    // A search term is the user's intent, not a filter — it survives "reset all".
    if (filters.search) next.set('search', filters.search);
    setSearchParams(next, { replace: true });
  };

  const activeCategory = categories.find((c) => c.slug === filters.category);
  const activeSubCategory = activeCategory?.subCategories?.find((s) => s.slug === filters.subCategory);

  const heading = filters.search
    ? t('list.resultsFor', { term: filters.search })
    : activeSubCategory?.name || activeCategory?.name || t('common:nav.allProducts');

  const crumbs = [
    { label: t('common:nav.products'), to: '/products' },
    ...(activeCategory ? [{ label: activeCategory.name, to: `/products?category=${activeCategory.slug}` }] : []),
    ...(activeSubCategory ? [{ label: activeSubCategory.name }] : []),
  ];

  /*
   * Chip labels: values that come from a fixed set get a translation, everything
   * else is catalogue data (a brand or category slug) and is shown as authored.
   */
  const chipLabel = (key, value) => {
    if (key === 'availability') return t(`filters.availability.${value}`, String(value));
    if (key === 'minPrice') return t('filters.chipMinPrice', { value });
    if (key === 'maxPrice') return t('filters.chipMaxPrice', { value });
    if (key === 'minDiscount') return t('filters.chipDiscount', { value });
    if (key === 'minRating') return t('filters.chipRating', { value });
    return String(value).replace(/_/g, ' ');
  };

  const activeChips = Object.entries(filters)
    .filter(([key]) => key !== 'search')
    .map(([key, value]) => ({ key, value }));

  return (
    <>
      <Seo
        title={heading}
        description={activeCategory?.description || t('list.seoDescription', { heading })}
        path={`/products?${searchParams.toString()}`}
      />

      <div className="container-page py-5">
        <Breadcrumb items={crumbs} className="mb-4" />

        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="section-title">{heading}</h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {loading ? t('list.loading') : t('list.found', { count: meta?.total ?? 0 })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(true)}
              className="btn-outline lg:hidden"
            >
              <Icon name="filter" size={16} />
              {t('filters.title')}
              {activeChips.length > 0 && (
                <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">
                  {activeChips.length}
                </span>
              )}
            </button>

            <label className="flex items-center gap-2 text-sm">
              <span className="hidden text-ink-500 sm:block">{t('list.sortBy')}</span>
              <select
                value={sort}
                onChange={(e) => updateParams({ sort: e.target.value })}
                className="input input-sm input-auto"
                aria-label={t('list.sortAria')}
              >
                {SORT_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`sort.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {activeChips.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {activeChips.map(({ key, value }) => (
              <button
                key={key}
                type="button"
                onClick={() => updateParams({ [key]: undefined })}
                aria-label={t('filters.removeFilter', { name: chipLabel(key, value) })}
                className="badge bg-brand-50 text-brand-700 ring-brand-200 hover:bg-brand-100"
              >
                {chipLabel(key, value)}
                <Icon name="close" size={12} className="ml-1.5" />
              </button>
            ))}
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs font-semibold text-ink-500 underline hover:text-danger"
            >
              {t('common:actions.clearAll')}
            </button>
          </div>
        )}

        <div className="flex gap-6">
          <div className="hidden w-64 shrink-0 lg:block">
            <div className="card sticky top-[152px] max-h-[calc(100vh-172px)] overflow-y-auto px-4 py-3">
              <FilterSidebar
                filters={filters}
                onChange={updateParams}
                onReset={resetFilters}
                meta={filterMeta}
              />
            </div>
          </div>

          <div className="min-w-0 flex-1">
            {error ? (
              <ErrorState message={error.message} onRetry={refetch} />
            ) : (
              <>
                <ProductGrid
                  products={products}
                  loading={loading}
                  skeletonCount={12}
                  columns={PRODUCT_GRID_COLUMNS.withSidebar}
                  emptyTitle={t('list.emptyTitle')}
                  emptyMessage={t('list.emptyMessage')}
                  emptyAction={{ label: t('filters.reset'), onClick: resetFilters }}
                />

                {meta?.totalPages > 1 && (
                  <Pagination
                    page={page}
                    totalPages={meta.totalPages}
                    onChange={(next) => updateParams({ page: next }, { resetPage: false })}
                    className="mt-8"
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/*
       * The filters are a dialog like every other dialog, so they are <Modal>
       * rather than a second hand-built sheet. This one used to reimplement the
       * overlay, the panel and the close button, and in doing so shipped without
       * the three things Modal does that are not visible: the focus trap, the
       * Escape key, and the dialog role that tells a screen reader the grid
       * behind has been covered.
       *
       * `!isDesktop` is the `lg:hidden` the old wrapper carried — a portalled
       * dialog cannot be hidden by a class on an ancestor, so the rule moves to
       * whether it opens at all.
       */}
      <Modal
        open={mobileFiltersOpen && !isDesktop}
        onClose={() => setMobileFiltersOpen(false)}
        title={t('filters.title')}
        size="lg"
        footer={
          <button
            type="button"
            onClick={() => setMobileFiltersOpen(false)}
            className="btn-primary w-full"
          >
            {t('filters.showCount', { count: meta?.total ?? 0 })}
          </button>
        }
      >
        <FilterSidebar
          filters={filters}
          onChange={updateParams}
          onReset={resetFilters}
          meta={filterMeta}
        />
      </Modal>
    </>
  );
}
