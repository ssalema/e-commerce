import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid2';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import CardGridSkeleton from './CardGridSkeleton';

/**
 * Suspense fallback for an admin route chunk that is still downloading.
 *
 * The progress bar that used to stand here said only that something was happening,
 * over an otherwise empty page — then the whole layout dropped in at once. Holding
 * the shape of the page that is coming keeps the frame still, and because every
 * list page skeletons its own fetch through <DataTable>, the placeholder carries
 * straight through from chunk to data instead of flashing an empty page between.
 */

/** Breadcrumbs, title, subtitle and the header action every page block shares. */
function PageHeaderSkeleton({ crumbs = true, action = true }) {
  return (
    <Box sx={{ mb: 3 }}>
      {crumbs && <Skeleton variant="text" width={160} height={18} sx={{ mb: 1 }} />}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={2}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Skeleton variant="text" width="35%" height={42} sx={{ maxWidth: 320 }} />
          <Skeleton variant="text" width="55%" height={20} sx={{ maxWidth: 420 }} />
        </Box>
        {action && <Skeleton variant="rounded" width={148} height={37} sx={{ flexShrink: 0 }} />}
      </Stack>
    </Box>
  );
}

/**
 * The list pages: filter toolbar, header row and rows inside the one card, matching
 * <DataTable>'s own loading rows so the handover from chunk to fetch is invisible.
 */
function TableSkeleton({ rows = 8, columns = 6, toolbar = true }) {
  return (
    <Card>
      {toolbar && (
        <>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            alignItems={{ xs: 'stretch', md: 'center' }}
            spacing={1.5}
            sx={{ p: 2 }}
          >
            <Skeleton variant="rounded" height={40} sx={{ flex: 1, minWidth: 0 }} />
            <Skeleton variant="rounded" height={40} sx={{ width: { xs: '100%', md: 170 } }} />
            <Skeleton variant="rounded" height={40} sx={{ width: { xs: '100%', md: 170 } }} />
          </Stack>
          <Divider />
        </>
      )}

      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} sx={{ pb: 1.5 }}>
          {Array.from({ length: columns }).map((_, column) => (
            <Skeleton key={column} variant="text" height={22} sx={{ flex: 1 }} />
          ))}
        </Stack>
        <Divider />

        {Array.from({ length: rows }).map((_, row) => (
          <Stack key={row} direction="row" spacing={2} sx={{ py: 1.5 }}>
            {Array.from({ length: columns }).map((_, column) => (
              <Skeleton key={column} variant="text" height={26} sx={{ flex: 1 }} />
            ))}
          </Stack>
        ))}
      </Box>

      <Divider />
      <Stack direction="row" justifyContent="flex-end" sx={{ p: 2 }}>
        <Skeleton variant="rounded" width={280} height={32} />
      </Stack>
    </Card>
  );
}

function TablePageSkeleton(props) {
  return (
    <Box>
      <PageHeaderSkeleton />
      <TableSkeleton {...props} />
    </Box>
  );
}

function ChartCardSkeleton({ height, circular = false }) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Skeleton variant="text" width={180} height={26} />
          <Skeleton variant="rounded" width={120} height={32} />
        </Stack>

        {circular ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height }}>
            <Skeleton variant="circular" width={height * 0.7} height={height * 0.7} />
          </Stack>
        ) : (
          <Skeleton variant="rounded" height={height} />
        )}
      </CardContent>
    </Card>
  );
}

/** Four stat cards over the revenue trend, the two breakdown pies and the top list. */
function DashboardSkeleton() {
  return (
    <Box>
      <PageHeaderSkeleton crumbs={false} />

      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        {Array.from({ length: 4 }).map((_, index) => (
          <Grid key={index} size={{ xs: 12, sm: 6, lg: 3 }}>
            <Card>
              <CardContent>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Skeleton variant="rounded" width={44} height={44} sx={{ flexShrink: 0 }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Skeleton variant="text" width="60%" height={18} />
                    <Skeleton variant="text" width="45%" height={34} />
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={12}>
          <ChartCardSkeleton height={280} />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCardSkeleton height={240} circular />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <ChartCardSkeleton height={240} circular />
        </Grid>
        <Grid size={12}>
          <Card>
            <CardContent>
              <Skeleton variant="text" width={180} height={26} sx={{ mb: 2 }} />
              <Stack spacing={1.25}>
                {Array.from({ length: 5 }).map((_, row) => (
                  <Skeleton key={row} variant="rounded" height={44} />
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}

/** The product wizard: a stepper across the top, then the fields of the active step. */
function FormPageSkeleton() {
  return (
    <Box>
      <PageHeaderSkeleton action={false} />

      <Card>
        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack direction="row" justifyContent="space-between" spacing={2}>
            {Array.from({ length: 4 }).map((_, step) => (
              <Stack key={step} alignItems="center" spacing={1} sx={{ flex: 1 }}>
                <Skeleton variant="circular" width={26} height={26} />
                <Skeleton variant="text" width="70%" height={18} />
              </Stack>
            ))}
          </Stack>
        </CardContent>
        <Divider />

        <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
          <Grid container spacing={2.5}>
            {[12, 6, 6, 12, 6, 6].map((span, field) => (
              <Grid key={field} size={{ xs: 12, md: span }}>
                <Skeleton variant="text" width="30%" height={18} sx={{ mb: 0.5 }} />
                <Skeleton variant="rounded" height={field === 3 ? 110 : 40} />
              </Grid>
            ))}
          </Grid>
        </CardContent>
        <Divider />

        <Stack direction="row" justifyContent="space-between" sx={{ p: { xs: 2, sm: 3 } }}>
          <Skeleton variant="rounded" width={104} height={37} />
          <Skeleton variant="rounded" width={104} height={37} />
        </Stack>
      </Card>
    </Box>
  );
}

/** One order: line items and timeline on the left, the summary cards beside them. */
function DetailPageSkeleton() {
  return (
    <Box>
      <PageHeaderSkeleton />

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card sx={{ mb: 2.5 }}>
            <CardContent>
              <Skeleton variant="text" width={160} height={26} sx={{ mb: 2 }} />
              <Stack spacing={2}>
                {Array.from({ length: 3 }).map((_, row) => (
                  <Stack key={row} direction="row" spacing={2} alignItems="center">
                    <Skeleton variant="rounded" width={56} height={56} sx={{ flexShrink: 0 }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Skeleton variant="text" width="60%" height={22} />
                      <Skeleton variant="text" width="35%" height={18} />
                    </Box>
                    <Skeleton variant="text" width={72} height={22} sx={{ flexShrink: 0 }} />
                  </Stack>
                ))}
              </Stack>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Skeleton variant="text" width={140} height={26} sx={{ mb: 2 }} />
              <Stack spacing={1.5}>
                {Array.from({ length: 4 }).map((_, row) => (
                  <Skeleton key={row} variant="rounded" height={40} />
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }}>
          <Stack spacing={2.5}>
            {Array.from({ length: 3 }).map((_, card) => (
              <Card key={card}>
                <CardContent>
                  <Skeleton variant="text" width="45%" height={24} sx={{ mb: 1.5 }} />
                  <Skeleton variant="text" width="100%" height={18} />
                  <Skeleton variant="text" width="80%" height={18} />
                  <Skeleton variant="text" width="60%" height={18} />
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Grid>
      </Grid>
    </Box>
  );
}

/** Settings: a wall of equal section cards, each a title over a short field stack. */
function SettingsPageSkeleton() {
  return (
    <Box>
      <PageHeaderSkeleton crumbs={false} />

      <Grid container spacing={2.5}>
        {Array.from({ length: 6 }).map((_, card) => (
          <Grid key={card} size={{ xs: 12, md: 6 }}>
            <Card sx={{ height: '100%' }}>
              <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  sx={{ mb: 2 }}
                >
                  <Skeleton variant="text" width="40%" height={24} />
                  <Skeleton variant="rounded" width={64} height={28} />
                </Stack>

                <Stack spacing={2}>
                  {Array.from({ length: 3 }).map((_, field) => (
                    <Skeleton key={field} variant="rounded" height={40} />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

/** Inquiries: the tab rail sits above the table and outlives a tab change. */
function TabbedTablePageSkeleton() {
  return (
    <Box>
      <PageHeaderSkeleton crumbs={false} action={false} />

      <Card sx={{ mb: 2.5 }}>
        <Stack direction="row" spacing={3} sx={{ px: 2, py: 2 }}>
          {Array.from({ length: 3 }).map((_, tab) => (
            <Skeleton key={tab} variant="text" width={140} height={24} />
          ))}
        </Stack>
      </Card>

      <TableSkeleton rows={6} columns={5} />
    </Box>
  );
}

export default function RouteSkeleton({ pathname = '' }) {
  const path = pathname.replace(/\/+$/, '') || '/';

  if (path === '/') return <DashboardSkeleton />;

  if (path === '/products/new' || /^\/products\/[^/]+\/edit$/.test(path)) {
    return <FormPageSkeleton />;
  }

  if (/^\/orders\/[^/]+$/.test(path)) return <DetailPageSkeleton />;

  if (path === '/settings') return <SettingsPageSkeleton />;

  if (path === '/inquiries') return <TabbedTablePageSkeleton />;

  // Banners lead with a wide image; brands and categories with a thumbnail over a
  // list — the same two shapes <CardGridSkeleton> already draws for their fetches.
  if (path === '/banners') {
    return (
      <Box>
        <PageHeaderSkeleton />
        <CardGridSkeleton count={4} size={{ xs: 12, md: 6 }} mediaRatio="16/6" />
      </Box>
    );
  }

  // The two list-card pages differ only in thumbnail size and card height; the
  // heights are each page's own CARD_HEIGHT (chrome + a five-row list window), so
  // the chunk placeholder and the fetch placeholder are the same size.
  if (path === '/brands') {
    return (
      <Box>
        <PageHeaderSkeleton />
        <CardGridSkeleton
          count={6}
          size={{ xs: 12, md: 6, xl: 4 }}
          minHeight={446}
          thumbSize={52}
          listRows={5}
        />
      </Box>
    );
  }

  if (path === '/categories') {
    return (
      <Box>
        <PageHeaderSkeleton />
        <CardGridSkeleton
          count={6}
          size={{ xs: 12, md: 6, xl: 4 }}
          minHeight={422}
          thumbSize={44}
          listRows={5}
        />
      </Box>
    );
  }

  // Products, orders, users, coupons, reasons, reactivation requests — and anything
  // added later, since a list page is the admin's default shape.
  return <TablePageSkeleton />;
}

export { PageHeaderSkeleton, TableSkeleton };
