import Chip from '@mui/material/Chip';
import {
  ORDER_STATUS_COLOR,
  PAYMENT_STATUS_COLOR,
  PRODUCT_STATUS_COLOR,
} from '../../utils/constants';
import { titleCase } from '../../utils/format';

const PALETTES = {
  order: ORDER_STATUS_COLOR,
  payment: PAYMENT_STATUS_COLOR,
  product: PRODUCT_STATUS_COLOR,
  /**
     * Four states, two of them the customer's own doing. 'deactivated' is warning
     * rather than error because nothing has gone wrong — someone left — and
     * 'reactivation-pending' shares the amber of everything else in the panel that
     * is waiting on a person.
     */
  user: {
    active: 'success',
    blocked: 'error',
    deactivated: 'warning',
    'reactivation-pending': 'warning',
  },
  role: { admin: 'primary', user: 'default' },
  /** Newsletter: on the list or off it — nothing has gone wrong either way. */
  newsletter: { subscribed: 'success', unsubscribed: 'default' },
  /**
   * The careers setup lists: a role is open or closed, an experience option is
   * offered or hidden. Off is 'default' rather than 'error' in both cases —
   * withdrawing something from a form is housekeeping, not a fault.
   */
  position: { open: 'success', closed: 'default' },
  experience: { offered: 'success', hidden: 'default' },
  /**
   * A reactivation request: waiting on a person, then the decision either way.
   * Amber for pending, matching everything else in the panel that is queued
   * behind someone.
   */
  reactivation: { pending: 'warning', approved: 'success', rejected: 'error' },
  /** The careers pipeline, in the order an application moves through it. */
  career: {
    new: 'info',
    shortlisted: 'primary',
    interviewed: 'secondary',
    rejected: 'error',
    hired: 'success',
  },
};

export default function StatusChip({ status, kind = 'order', size = 'small', ...rest }) {
  const color = PALETTES[kind]?.[status] || 'default';
  // Hyphenated statuses would otherwise print as "Reactivation-pending".
  const label = titleCase(String(status || '').replace(/-/g, ' '));
  return <Chip label={label} color={color} size={size} variant="filled" {...rest} />;
}
