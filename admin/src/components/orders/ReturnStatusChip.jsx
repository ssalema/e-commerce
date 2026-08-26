import StatusChip from '../common/StatusChip';
import { RETURN_STATUS_LABELS } from '../../utils/constants';

/**
 * A return's state, badged as every other status in the panel is.
 *
 * It is StatusChip underneath — same shape, size, radius, weight and padding as
 * the Delivered and Refunded chips it stands beside — and adds only the two
 * things that are particular to a return: its proper label ("Refund Success",
 * not the titlecased key) and the null check, since most orders have no return
 * to badge.
 *
 * The wrapper exists so the orders list, the order page and the update dialog
 * cannot drift apart the way three separate `<Chip>` calls once did.
 */
export default function ReturnStatusChip({ status, ...rest }) {
  if (!status) return null;

  return (
    <StatusChip
      status={status}
      kind="return"
      label={RETURN_STATUS_LABELS[status] || status}
      {...rest}
    />
  );
}
