import { useTranslation } from 'react-i18next';
import {
  ORDER_STATUS_STYLES,
  PAYMENT_STATUS_STYLES,
  RETURN_STATUS_STYLES,
} from '../../utils/constants';
import { titleCase } from '../../utils/format';

/**
 * Every status the shopper is shown, in one pill.
 *
 * `return` is the third kind rather than a badge of its own: a return is a
 * second journey over the same parcel, but it is still a state of that order,
 * and a pill built from loose utilities beside it would drift from the shape the
 * rest of the app badges things in — which is exactly what happened before.
 */
const PALETTES = {
  order: ORDER_STATUS_STYLES,
  payment: PAYMENT_STATUS_STYLES,
  return: RETURN_STATUS_STYLES,
};

/** Where each kind's label lives; the return's own ladder is named in `account`. */
const LABEL_KEY = {
  order: 'orderStatus',
  payment: 'paymentStatus',
  return: 'account:detail.returnSteps',
};

export default function StatusBadge({ status, kind = 'order', className = '' }) {
  const { t } = useTranslation();
  const style = PALETTES[kind]?.[status] || 'bg-ink-100 text-ink-700 ring-ink-200';

  // A status the API adds later still renders readably rather than as a raw key.
  const label = t(`${LABEL_KEY[kind] || LABEL_KEY.order}.${status}`, {
    defaultValue: titleCase(status),
  });

  return <span className={`badge ${style} ${className}`}>{label}</span>;
}
