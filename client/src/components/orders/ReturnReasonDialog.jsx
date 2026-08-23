import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { orderApi } from '../../api/endpoints';
import ReasonPickerDialog from './ReasonPickerDialog';

/**
 * Second step of the return flow: *what is wrong with it*.
 *
 * The twin of CancelReasonDialog, over the return picklist instead of the
 * cancellation one — the two lists are separate collections precisely so this
 * dialog never offers "Wrong address selected" to somebody holding a damaged
 * parcel.
 *
 * The button is the brand colour rather than red: raising a return is a thing the
 * shopper wants to happen, not a thing they are being warned about.
 */
export default function ReturnReasonDialog({ open, onClose, onConfirm }) {
  const { t } = useTranslation(['account', 'common']);

  // Stable so the dialog's fetch effect fires on open, not on every render.
  const fetchReasons = useCallback(() => orderApi.returnReasons(), []);

  return (
    <ReasonPickerDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      fetchReasons={fetchReasons}
      name="return-reason"
      tone="brand"
      copy={{
        title: t('detail.returnReasonTitle'),
        submit: t('detail.returnReasonSubmit'),
        dismiss: t('detail.returnDismiss'),
        otherPlaceholder: t('detail.returnReasonOtherPlaceholder'),
        required: t('detail.returnReasonRequired'),
        customRequired: t('detail.reasonCustomRequired'),
        failed: t('detail.returnFailed'),
      }}
    />
  );
}
