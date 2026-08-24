import Chip from '@mui/material/Chip';

import { RETURN_STATUS_LABELS, RETURN_STATUS_TINTS } from '../../utils/constants';

/**
 * A return's state, as a pill — the panel's copy of the storefront's return
 * badge, down to the tint.
 *
 * It is its own component rather than three `<Chip color={…}>` calls because the
 * orders list, the order page and the update dialog all show this same fact, and
 * the three had already drifted into looking like different things. One place to
 * draw it is what keeps them the same picture — and the same picture the customer
 * is looking at.
 *
 * Deliberately not StatusChip: that one names a colour from the MUI palette,
 * which is a different set of five from the storefront's return tints.
 */
export default function ReturnStatusChip({ status, sx, ...rest }) {
  if (!status) return null;

  const tint = RETURN_STATUS_TINTS[status];

  return (
    <Chip
      size="small"
      variant="filled"
      label={RETURN_STATUS_LABELS[status] || status}
      {...rest}
      sx={{
        fontWeight: 700,
        bgcolor: tint?.bg || 'action.hover',
        color: tint?.text || 'text.secondary',
        // The storefront draws its ring inside the pill; an inset border is the
        // nearest thing here, and it is what keeps a pale tint legible against
        // the equally pale row it sits on.
        border: 1,
        borderColor: tint?.ring || 'divider',
        ...sx,
      }}
    />
  );
}
