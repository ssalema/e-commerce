import Chip from '@mui/material/Chip';

/**
 * The "NEW" marker the inbox uses in three places: on an unread row, next to a
 * tab label, and beside the sidebar's Inquiries link.
 *
 * It is the panel's own small Chip — same shape, weight and palette as the status
 * chips everywhere else — only tightened a little, because it sits inline next to
 * a name or a tab label rather than in a column of its own.
 *
 * Primary rather than error: red is what this panel uses for something being
 * wrong — a delete action, a rejected application — and an unread message is
 * neither. Brand blue is what already marked an unread row here, and what the
 * careers table already colours a `new` application.
 *
 * With a `count` it reads "3 NEW"; without one it is the bare marker a single
 * unread row carries. Zero renders nothing, so a caller can hand it a count
 * straight from the stats response without guarding first.
 */
export default function NewBadge({ count, sx }) {
  if (count !== undefined && !count) return null;

  return (
    <Chip
      size="small"
      color="primary"
      label={count === undefined ? 'NEW' : `${count} NEW`}
      sx={{
        height: 20,
        flexShrink: 0,
        '& .MuiChip-label': { px: 0.875, fontSize: 10.5, letterSpacing: 0.3 },
        ...sx,
      }}
    />
  );
}
