import Skeleton, {
  ListRowSkeleton,
  ProductDetailSkeleton,
  ProductGridPageSkeleton,
} from './Skeleton';
import TranslationSkeleton, {
  AccountPanelSkeleton,
} from '../language/TranslationSkeleton';
import { PRODUCT_GRID_COLUMNS } from '../../utils/constants';

/**
 * Suspense fallback for a route chunk that is still downloading.
 *
 * Matching the shimmer to the incoming page keeps the layout from collapsing
 * between header and footer, and on the routes that skeleton their own data
 * (product detail, the account panels) the placeholder simply carries straight
 * through from chunk to fetch instead of flashing a spinner in between.
 */
const POLICY_PATHS = new Set([
  '/about',
  '/shipping-policy',
  '/returns',
  '/refund-policy',
  '/faq',
  '/terms',
  '/privacy',
]);

function PolicySkeleton() {
  return (
    <div className="container-page py-8 lg:py-12">
      <Skeleton className="mb-5 h-4 w-40" />
      <Skeleton className="mb-3 h-9 w-72 max-w-full" />
      <Skeleton className="mb-8 h-4 w-full max-w-2xl" />

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start">
        <Skeleton className="hidden h-64 rounded-xl lg:block" />
        <div className="space-y-5">
          {[0, 1, 2].map((card) => (
            <div key={card} className="card space-y-3 p-5 sm:p-7">
              <Skeleton className="h-5 w-56 max-w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function RouteSkeleton({ pathname = '' }) {
  const path = pathname.replace(/\/+$/, '') || '/';

  // The listing keeps a column for its filter rail, so its placeholder has to as
  // well — otherwise the chunk-download skeleton shimmers five across and hands
  // over to a four-across page.
  if (path === '/products') {
    return <ProductGridPageSkeleton count={12} columns={PRODUCT_GRID_COLUMNS.withSidebar} />;
  }

  if (path === '/' || path === '/wishlist') {
    return <ProductGridPageSkeleton />;
  }

  if (path.startsWith('/product/')) return <ProductDetailSkeleton />;

  if (path === '/cart' || path === '/checkout' || path.startsWith('/order-success/')) {
    return (
      <div className="container-page py-6">
        <ListRowSkeleton rows={3} />
      </div>
    );
  }

  if (path === '/account' || path.startsWith('/account/')) {
    return (
      <div className="container-page py-6">
        <AccountPanelSkeleton />
      </div>
    );
  }

  // About and the policy pages: a heading over a contents rail and a stack of
  // section cards, so the shape is already right when the copy lands.
  if (POLICY_PATHS.has(path)) return <PolicySkeleton />;

  // Auth, contact, careers, 404 — short pages with no shared shape worth guessing.
  return <TranslationSkeleton lines={5} />;
}
