import { useEffect, useState } from 'react';
import { useSnackbar } from 'notistack';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import CloseIcon from '@mui/icons-material/Close';

import { orderApi } from '../../api/endpoints';
import {
  RETURN_STATUS_FLOW,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_COLOR,
  RETURN_STATUS_EFFECT,
} from '../../utils/constants';
import { formatPrice } from '../../utils/format';

/**
 * Moving a return along its ladder.
 *
 * The twin of UpdateStatusDialog, over RETURN_STATUS_FLOW instead of STATUS_FLOW:
 * only the moves the API will accept from where the return actually is are
 * offered, so staff cannot try to refund a return nobody has collected yet.
 *
 * The consequences are spelled out rather than left implied. `refund_started` is
 * the step that restocks the SKUs, gives the coupon redemption back and closes
 * the order as Returned — the one move here that cannot be walked back, and the
 * one an admin should be reading a sentence about before they make it.
 */
export default function UpdateReturnStatusDialog({ order, onClose, onUpdated }) {
  const { enqueueSnackbar } = useSnackbar();

  const request = order?.returnRequest;
  const allowed = RETURN_STATUS_FLOW[request?.status] || [];

  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [pickupPartner, setPickupPartner] = useState('');
  const [pickupTrackingNumber, setPickupTrackingNumber] = useState('');
  const [refundReference, setRefundReference] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!order) return;
    setStatus(RETURN_STATUS_FLOW[order.returnRequest?.status]?.[0] || '');
    setNote('');
    setPickupPartner(order.returnRequest?.pickupPartner || '');
    setPickupTrackingNumber(order.returnRequest?.pickupTrackingNumber || '');
    setRefundReference(order.refundReference || '');
  }, [order]);

  if (!order || !request?.status) return null;

  const needsPickup = status === 'out_for_pickup';
  const isRefundSuccess = status === 'refund_success';
  const isRejection = status === 'rejected';

  const submit = async () => {
    setSaving(true);
    try {
      await orderApi.updateReturnStatus(order._id, {
        status,
        note: note.trim() || undefined,
        // Only sent on the steps they belong to; the server ignores the rest.
        pickupPartner: needsPickup ? pickupPartner.trim() || undefined : undefined,
        pickupTrackingNumber: needsPickup ? pickupTrackingNumber.trim() || undefined : undefined,
        refundReference: isRefundSuccess ? refundReference.trim() || undefined : undefined,
      });
      enqueueSnackbar(`Return marked as ${RETURN_STATUS_LABELS[status]}`, { variant: 'success' });
      onUpdated();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not update the return', { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, pr: 6 }}>
        Update return
        <Typography variant="body2" color="text.secondary">
          {order.orderNumber}
        </Typography>
        <IconButton
          onClick={onClose}
          size="small"
          disabled={saving}
          sx={{ position: 'absolute', right: 12, top: 12, color: 'text.secondary' }}
          aria-label="Close without saving"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" color="text.secondary">
              Current step:
            </Typography>
            <Chip
              size="small"
              label={RETURN_STATUS_LABELS[request.status]}
              color={RETURN_STATUS_COLOR[request.status] || 'default'}
              sx={{ fontWeight: 700 }}
            />
          </Stack>

          {/* The customer's own words, or the label they picked — what the person
              doing the quality check needs to know they are looking for. */}
          <Alert severity="info" icon={false}>
            <Typography variant="caption" fontWeight={700} display="block">
              Customer&rsquo;s reason
            </Typography>
            {request.reason}
          </Alert>

          {allowed.length === 0 ? (
            <Alert severity="info">
              This return is {RETURN_STATUS_LABELS[request.status].toLowerCase()} and can no longer
              be moved.
            </Alert>
          ) : (
            <>
              <TextField
                select
                fullWidth
                label="New step"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {allowed.map((value) => (
                  <MenuItem key={value} value={value}>
                    {RETURN_STATUS_LABELS[value]}
                  </MenuItem>
                ))}
              </TextField>

              {RETURN_STATUS_EFFECT[status] && (
                <Alert severity={status === 'refund_started' || isRejection ? 'warning' : 'info'}>
                  {RETURN_STATUS_EFFECT[status]}
                  {status === 'refund_started' &&
                    request.refundAmount > 0 &&
                    ` Refund queued: ${formatPrice(request.refundAmount, true)}.`}
                </Alert>
              )}

              {needsPickup && (
                <>
                  <TextField
                    fullWidth
                    label="Pickup partner"
                    value={pickupPartner}
                    onChange={(e) => setPickupPartner(e.target.value)}
                    helperText="Shown to the customer on their return tracker"
                    inputProps={{ maxLength: 60 }}
                  />
                  <TextField
                    fullWidth
                    label="Pickup tracking number"
                    value={pickupTrackingNumber}
                    onChange={(e) => setPickupTrackingNumber(e.target.value)}
                    inputProps={{ maxLength: 60 }}
                  />
                </>
              )}

              {isRefundSuccess && (
                <TextField
                  fullWidth
                  label="Refund reference"
                  value={refundReference}
                  onChange={(e) => setRefundReference(e.target.value)}
                  helperText="The gateway or bank reference a customer chasing the money can be quoted"
                  inputProps={{ maxLength: 80 }}
                />
              )}

              <TextField
                fullWidth
                multiline
                minRows={2}
                label={isRejection ? 'Reason for declining' : 'Note'}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                helperText={
                  isRejection
                    ? 'The customer sees this on their order page — say what failed the check'
                    : "Optional — stored in the return's own history"
                }
                inputProps={{ maxLength: 300 }}
              />
            </>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button
          variant="contained"
          color={isRejection ? 'error' : 'primary'}
          disabled={saving || !status || allowed.length === 0}
          onClick={submit}
          startIcon={saving ? <CircularProgress size={15} color="inherit" /> : null}
        >
          Update return
        </Button>
      </DialogActions>
    </Dialog>
  );
}
