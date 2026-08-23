import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Divider from '@mui/material/Divider';
import Grid from '@mui/material/Grid2';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';

/**
 * Placeholder cards for the pages that lay their records out as a grid rather than
 * a table — banners, brands, categories.
 *
 * DataTable already greys in its own rows while a fetch is in flight; these pages
 * had only a progress bar over an empty page, which says something is happening but
 * nothing about what is arriving, and lets the whole grid drop in at once. Holding
 * the shape of the cards that are coming keeps the page still.
 *
 * Two shapes, chosen by `mediaRatio`: a banner-style card led by a wide image, or a
 * brand/category-style card led by a thumbnail with a list below the divider. The
 * measurements are passed in by the caller so the placeholder and the real card stay
 * the same height — a mismatch here just moves the jump rather than removing it.
 */
export default function CardGridSkeleton({
  count = 4,
  size = { xs: 12, md: 6 },
  mediaRatio,
  minHeight,
  thumbSize = 44,
  listRows = 3,
}) {
  return (
    <Grid container spacing={2.5}>
      {Array.from({ length: count }).map((_, index) => (
        <Grid key={index} size={size}>
          <Card sx={{ height: '100%', minHeight, display: 'flex', flexDirection: 'column' }}>
            {mediaRatio && (
              <Skeleton variant="rectangular" sx={{ width: '100%', aspectRatio: mediaRatio }} />
            )}

            <CardContent sx={{ flexShrink: 0 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                {!mediaRatio && (
                  <Skeleton
                    variant="rounded"
                    width={thumbSize}
                    height={thumbSize}
                    sx={{ flexShrink: 0 }}
                  />
                )}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Skeleton variant="text" width="55%" height={26} />
                  <Skeleton variant="text" width="35%" height={18} />
                </Box>
                <Skeleton variant="circular" width={28} height={28} sx={{ flexShrink: 0 }} />
                <Skeleton variant="circular" width={28} height={28} sx={{ flexShrink: 0 }} />
              </Stack>

              {mediaRatio && <Skeleton variant="text" width="45%" height={16} sx={{ mt: 1 }} />}
            </CardContent>

            {/* The list half of a brand or category card: heading, rows, and the
                button pinned under them. */}
            {!mediaRatio && (
              <>
                <Divider />
                <CardContent sx={{ flex: 1 }}>
                  <Skeleton variant="text" width="30%" height={20} />
                  <Stack spacing={0.5} sx={{ mt: 1 }}>
                    {Array.from({ length: listRows }).map((_, row) => (
                      <Skeleton key={row} variant="rounded" height={34} />
                    ))}
                  </Stack>
                  <Skeleton variant="rounded" height={39} sx={{ mt: 1.5 }} />
                </CardContent>
              </>
            )}
          </Card>
        </Grid>
      ))}
    </Grid>
  );
}
