import { useCallback, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { fetchWishlist, productStockChanged } from '../store/wishlistSlice';
import { useLiveRefetch, useRealtimeEvent } from '../realtime/useRealtime';
import { CATALOG_STRUCTURE_EVENTS, EVENTS } from '../realtime/events';
import { PRODUCT_GRID_COLUMNS } from '../utils/constants';
import { isCurrentStockEvent } from '../utils/stockPatch';
import Seo from '../components/common/Seo';
import Breadcrumb from '../components/common/Breadcrumb';
import ProductGrid from '../components/product/ProductGrid';
import ErrorState from '../components/common/ErrorState';

export default function Wishlist() {
  const { t } = useTranslation(['checkout', 'common']);
  const dispatch = useDispatch();
  const { items, loading, error } = useSelector((s) => s.wishlist);

  useEffect(() => {
    dispatch(fetchWishlist());
  }, [dispatch]);

  // The list itself arrives over the socket, but a saved product's price and copy are
  // catalogue state — an admin editing one needs a re-read here.
  useLiveRefetch(
    useCallback(() => dispatch(fetchWishlist()), [dispatch]),
    CATALOG_STRUCTURE_EVENTS
  );

  // Stock is the exception: it moves on every order in the shop, and re-reading the
  // whole wishlist because a stranger bought something unrelated is a request nobody
  // needed. The broadcast carries the new absolute value, so the row is corrected.
  //
  // Absolute values are only safe in the order they were read, so an event older than
  // one already applied for that product is dropped rather than dispatched — the same
  // guard the grid reducers apply, checked here because a reducer must stay pure.
  useRealtimeEvent(
    EVENTS.PRODUCT_STOCK_CHANGED,
    useCallback(
      (payload) => {
        if (isCurrentStockEvent(payload)) dispatch(productStockChanged(payload));
      },
      [dispatch]
    )
  );

  // A saved item keeps the option the shopper had chosen, so the tile shows that SKU's
  // price and links straight back to it rather than to the product's default.
  const products = items.map((item) =>
    item.variant
      ? {
          ...item.product,
          finalPrice: item.variant.finalPrice,
          price: item.variant.price,
          discountPercent: item.variant.discountPercent,
          stock: item.variant.stock,
          images: item.variant.images?.length ? item.variant.images : item.product.images,
          savedVariantSku: item.variant.sku,
          savedVariantLabel: item.variant.label,
        }
      : item.product
  );

  return (
    <>
      <Seo title={t('wishlist.title')} path="/wishlist" noIndex />

      <div className="container-page py-5">
        <Breadcrumb items={[{ label: t('common:nav.wishlist') }]} className="mb-4" />

        <h1 className="mb-5 section-title">
          {t('wishlist.title')}
          {products.length > 0 && (
            <span className="ml-2 text-base font-normal text-ink-500">
              ({t('cart.itemCount', { count: products.length })})
            </span>
          )}
        </h1>

        {/* A failed load must not read as an empty wishlist. */}
        {error && !products.length ? (
          <ErrorState message={error} onRetry={() => dispatch(fetchWishlist())} />
        ) : (
          <ProductGrid
            products={products}
            loading={loading && !products.length}
            columns={PRODUCT_GRID_COLUMNS.full}
            emptyTitle={t('wishlist.emptyTitle')}
            emptyMessage={t('wishlist.emptyMessage')}
            emptyAction={{ label: t('wishlist.browse'), to: '/products' }}
          />
        )}
      </div>
    </>
  );
}
