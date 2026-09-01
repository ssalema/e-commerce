import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import RouteSkeleton from './RouteSkeleton';

/**
 * The placeholders for the two moments before <AdminLayout> exists: the session
 * probe on a hard refresh, and the login chunk downloading. Both used to be a
 * centred spinner on an empty page, which throws the whole console in at once the
 * instant it clears; drawing the frame that is coming means only the content
 * inside it changes.
 */

const DRAWER_WIDTH = 252;
const NAV_GROUPS = [1, 5, 4, 1]; // Overview, Catalogue, Commerce, System.

/** The navy rail, drawn in translucent white so it reads against its own panel. */
function SidebarSkeleton() {
  const onNavy = { bgcolor: 'rgba(255,255,255,.13)' };

  return (
    <Box
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        bgcolor: 'secondary.main',
        display: { xs: 'none', lg: 'block' },
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ px: 2.5, py: 2.5 }}>
        <Skeleton variant="rounded" width={38} height={38} sx={{ ...onNavy, flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Skeleton variant="text" width="70%" height={20} sx={onNavy} />
          <Skeleton variant="text" width="45%" height={14} sx={onNavy} />
        </Box>
      </Stack>

      <Divider sx={{ borderColor: 'rgba(255,255,255,.08)' }} />

      <Box sx={{ px: 2, py: 2 }}>
        {NAV_GROUPS.map((items, group) => (
          <Box key={group} sx={{ mb: 2.5 }}>
            <Skeleton variant="text" width={78} height={16} sx={{ ...onNavy, mb: 1 }} />
            <Stack spacing={0.75}>
              {Array.from({ length: items }).map((_, item) => (
                <Skeleton key={item} variant="rounded" height={38} sx={onNavy} />
              ))}
            </Stack>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** The fixed top bar: menu affordance, search, then the icon cluster and avatar. */
function TopbarSkeleton() {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{
        height: 64,
        px: 2,
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Skeleton
        variant="rounded"
        width={34}
        height={34}
        sx={{ display: { lg: 'none' }, flexShrink: 0 }}
      />
      <Skeleton variant="rounded" height={38} sx={{ flex: 1, maxWidth: 360 }} />
      <Box sx={{ flex: 1 }} />
      <Skeleton variant="circular" width={34} height={34} sx={{ flexShrink: 0 }} />
      <Skeleton variant="circular" width={34} height={34} sx={{ flexShrink: 0 }} />
      <Skeleton variant="circular" width={34} height={34} sx={{ flexShrink: 0 }} />
    </Stack>
  );
}

/**
 * The whole console in outline. `pathname` is read from the browser rather than a
 * router hook because this stands in above the router as well as inside it.
 */
export function AppShellSkeleton({ pathname = window.location.pathname }) {
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <SidebarSkeleton />

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <TopbarSkeleton />
        <Box sx={{ p: { xs: 2, sm: 3 } }}>
          <RouteSkeleton pathname={pathname} />
        </Box>
      </Box>
    </Box>
  );
}

/** The login card: brand mark, heading, two fields and the submit button. */
export function AuthCardSkeleton() {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        p: 2,
        bgcolor: 'background.default',
      }}
    >
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack alignItems="center" spacing={1} sx={{ mb: 3 }}>
            <Skeleton variant="rounded" width={52} height={52} />
            <Skeleton variant="text" width={180} height={32} />
            <Skeleton variant="text" width={240} height={20} />
          </Stack>

          <Stack spacing={2}>
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={56} />
            <Skeleton variant="rounded" height={42} />
          </Stack>

          <Skeleton variant="text" width="60%" height={16} sx={{ mt: 3, mx: 'auto' }} />
        </CardContent>
      </Card>
    </Box>
  );
}

/**
 * The router's own fallback: `/login` is the one route outside the console shell,
 * so it gets the card and everything else gets the shell.
 */
export default function BootSkeleton() {
  const pathname = window.location.pathname;

  if (pathname.startsWith('/login')) return <AuthCardSkeleton />;

  return <AppShellSkeleton pathname={pathname} />;
}
