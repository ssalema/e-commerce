import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { orderApi } from '../../api/endpoints';
import ReasonPickerDialog from './ReasonPickerDialog';

/**
 * Second step of the cancel flow: *why*.
 *
 * The dialog itself is ReasonPickerDialog, shared with the return flow — this
 * file is only the cancel-shaped half of it: the store's cancellation picklist,
 * the cancel copy, and the red button that says what is about to happen.
 */
export default function CancelReasonDialog({ open, onClose, onConfirm }) {
  const { t } = useTranslation(['account', 'common']);

  // Stable so the dialog's fetch effect fires on open, not on every render.
  const fetchReasons = useCallback(() => orderApi.cancellationReasons(), []);

  return (
    <ReasonPickerDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      fetchReasons={fetchReasons}
      name="cancellation-reason"
      tone="danger"
      copy={{
        title: t('detail.reasonTitle'),
        submit: t('detail.reasonSubmit'),
        dismiss: t('detail.cancelDismiss'),
        otherPlaceholder: t('detail.reasonOtherPlaceholder'),
        required: t('detail.reasonRequired'),
        customRequired: t('detail.reasonCustomRequired'),
        failed: t('detail.cancelFailed'),
      }}
    />
  );
}
