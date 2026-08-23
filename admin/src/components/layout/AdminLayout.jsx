import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import LinearProgress from '@mui/material/LinearProgress';
import Sidebar, { DRAWER_WIDTH } from './Sidebar';
import Topbar from './Topbar';
import ScrollManager from './ScrollManager';
import ErrorBoundary from '../common/ErrorBoundary';
import { InquiryCountsProvider } from '../../hooks/useInquiryCounts';

export default function AdminLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  return (
    /* The unread inquiry / application counts are fetched once, above both the
       sidebar badge and the Inquiries tabs, so the two can never disagree. */
    <InquiryCountsProvider>
      {/* Every route opens from the top; Back / Forward return to the exact
          offset the admin left the page at. */}
      <ScrollManager />

      <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />

        <Box
          component="main"
          sx={{
            flexGrow: 1,
            width: { lg: `calc(100% - ${DRAWER_WIDTH}px)` },
            p: { xs: 2, sm: 3 },
          }}
        >
          {/* Spacer matching the fixed AppBar height. */}
          <Toolbar />

          {/* Keyed by path so navigating away from a crashed page clears the error
              and the sidebar/topbar stay usable while a page is broken. */}
          <ErrorBoundary key={pathname}>
            <Suspense fallback={<LinearProgress sx={{ mt: 2, borderRadius: 1 }} />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </Box>
      </Box>
    </InquiryCountsProvider>
  );
}
