import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Footer from './Footer';
import MobileBottomNav from './MobileBottomNav';
import usesHeaderShopIcons from './mobileNavScope';
import ScrollManager from './ScrollManager';
import RouteSkeleton from '../common/RouteSkeleton';
import ErrorBoundary from '../common/ErrorBoundary';

/** Shell shared by every storefront route. Route chunks stream into <Outlet />. */
export default function Layout() {
  const { pathname } = useLocation();
  // Either way, something is pinned to the bottom on mobile: the four-tab nav, or —
  // on the product page, which trades the tabs for header icons — the buy bar.
  const hasBottomNav = !usesHeaderShopIcons(pathname);

  return (
    /* The bottom padding is the room the fixed mobile bar occupies, so the end of
       the footer is never left underneath it. */
    <div
      className={`flex min-h-screen flex-col lg:pb-0 ${
        hasBottomNav
          ? 'pb-[calc(4rem+env(safe-area-inset-bottom))]'
          : 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]'
      }`}
    >
      {/* Sits outside <Suspense> so it reacts the instant the URL changes,
          rather than waiting on the incoming route chunk. */}
      <ScrollManager />

      <Header />

      <main className="flex-1">
        {/* Keyed by path so navigating away from a crashed page clears the error
            instead of leaving the boundary stuck on every subsequent route. */}
        <ErrorBoundary key={pathname}>
          <Suspense fallback={<RouteSkeleton pathname={pathname} />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>

      <Footer />

      <MobileBottomNav />
    </div>
  );
}
