import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid2';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Avatar from '@mui/material/Avatar';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';

import EditIcon from '@mui/icons-material/EditOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBackIosNew';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import PaymentIcon from '@mui/icons-material/PaymentsOutlined';
import ReturnIcon from '@mui/icons-material/AssignmentReturnOutlined';

import { orderApi } from '../api/endpoints';
import useFetch from '../hooks/useFetch';
import { useLiveRefetch, useRealtimeRoom } from '../realtime/useRealtime';
import { ORDER_EVENTS, rooms } from '../realtime/events';
import { formatPrice, formatDateTime, formatPhone, thumb, titleCase } from '../utils/format';
import {
  ORDER_STATUS_STEPS,
  ORDER_STEP_LABELS,
  RETURN_STATUS_STEPS,
  RETURN_STATUS_LABELS,
  RETURN_STATUS_COLOR,
  RETURN_STATUS_FLOW,
  canMarkRefunded,
  STOREFRONT_URL,
} from '../utils/constants';
import PageHeader from '../components/common/PageHeader';
import StatusChip from '../components/common/StatusChip';
import ErrorState from '../components/common/ErrorState';
import UpdateStatusDialog from '../components/orders/UpdateStatusDialog';
import UpdatePaymentDialog from '../components/orders/UpdatePaymentDialog';
import UpdateReturnStatusDialog from '../components/orders/UpdateReturnStatusDialog';

/** The two moves that end an order — the ones the history highlights. */
const CLOSING_STATUSES = ['cancelled', 'returned'];

/**
 * Item snapshots keep the slug they were bought under; deleted or renamed products
 * may have none, in which case the row stays plain text rather than a dead link.
 */
const storeLinkProps = (slug) =>
  slug
    ? { component: 'a', href: `${STOREFRONT_URL}/product/${slug}`, target: '_blank', rel: 'noreferrer' }
    : {};

/**
 * Who made the move, in the words a support agent reading the trail needs:
 * whether it was the shopper or the shop, and — when the account is resolvable —
 * which person. `actor` is recorded on the entry; `cancelledBy` on the order is
 * the fallback for rows written before that field existed.
 */
const actorLabel = (entry, order) => {
  const side = entry.actor || (CLOSING_STATUSES.includes(entry.status) ? order.cancelledBy : null);
  const name = entry.changedBy?.name;

  if (side === 'customer') return name ? `customer (${name})` : 'customer';
  if (side === 'system') return 'the system';
  return name ? `${name} (admin)` : 'our team';
};

/**
 * The storefront's palette, by hex.
 *
 * The panel's MUI theme and the storefront's Tailwind tokens are separate
 * systems that happen to agree on the greens and reds; naming the values here
 * rather than reaching for `success.main` is what keeps the two timelines the
 * same picture when one of the two themes is next adjusted.
 */
const TL = {
  done: '#16a34a', // success
  closed: '#dc2626', // danger
  rail: '#e2e8f0', // ink-200
  todoDot: '#94a3b8', // ink-400
  label: '#0f172a', // ink-900
  labelTodo: '#94a3b8', // ink-400
  meta: '#64748b', // ink-500
  closedTint: '#fef2f2', // red-50
  closedMeta: '#b91c1c', // red-700
  closedLabel: '#991b1b', // red-800
};

/**
 * The rows the timeline draws — a port of `timelineRows` in
 * client/src/pages/account/OrderDetail.jsx, deliberately identical.
 *
 * A closed order is read from its own history rather than from where `cancelled`
 * sits in the ladder: it stopped somewhere along the path, so the steps it really
 * reached stay complete, the closing status is appended as the last row, and the
 * steps it never got to are not drawn at all. A live order keeps the full ladder
 * ahead of it, greyed, so staff see the same "what's left" the shopper does.
 */
function timelineRows(order) {
  const history = order.statusHistory || [];
  const rankOf = (status) => ORDER_STATUS_STEPS.indexOf(status);
  const entryFor = (status) => history.find((row) => row.status === status);

  const closed = CLOSING_STATUSES.includes(order.orderStatus);
  const reachedFromHistory = history.reduce((max, row) => Math.max(max, rankOf(row.status)), -1);
  // "Order Placed" is true of every order, whether or not a `pending` row was
  // ever written — a COD order is confirmed the moment it is created.
  const reached = closed
    ? Math.max(reachedFromHistory, 0)
    : Math.max(reachedFromHistory, rankOf(order.orderStatus), 0);

  const steps = ORDER_STATUS_STEPS.slice(0, closed ? reached + 1 : undefined).map((key, index) => {
    const entry = entryFor(key);

    return {
      key,
      label: ORDER_STEP_LABELS[key],
      done: index <= reached,
      at: entry?.changedAt || (index === 0 ? order.createdAt : null),
      note: entry?.note,
    };
  });

  if (!closed) return steps;

  return [
    ...steps,
    {
      key: order.orderStatus,
      label: ORDER_STEP_LABELS[order.orderStatus],
      done: true,
      closing: true,
      at: order.cancelledAt || entryFor(order.orderStatus)?.changedAt,
      entry: entryFor(order.orderStatus),
    },
  ];
}

/**
 * The order's trail, drawn as the same vertical timeline the storefront's order
 * page shows the shopper — same rows, same beads, same rail, same red panel — so
 * an agent on the phone and the customer describing their screen are looking at
 * one picture. The wording inside the red panel is the one deliberate
 * difference: the shop needs to read *who* cancelled, where the shopper reads
 * "by you".
 */
function StatusTimeline({ order }) {
  const rows = timelineRows(order);

  return (
    <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, position: 'relative' }}>
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        const closing = Boolean(row.closing);
        const next = rows[index + 1];

        return (
          <Box
            component="li"
            key={row.key}
            sx={{ position: 'relative', display: 'flex', gap: 2, pb: last ? 0 : 3 }}
          >
            {!last && (
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  left: 13,
                  top: 28,
                  bottom: 0,
                  width: 2,
                  // The segment takes the colour of the step it runs *into*, so the
                  // line arriving at a cancellation is red.
                  bgcolor: next.closing ? TL.closed : next.done ? TL.done : TL.rail,
                }}
              />
            )}

            <Box
              sx={{
                position: 'relative',
                zIndex: 1,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                width: 28,
                height: 28,
                borderRadius: '50%',
                color: '#fff',
                bgcolor: closing ? TL.closed : row.done ? TL.done : TL.rail,
                // Rings the bead in the card's own background so the rail appears
                // to run behind it rather than into it.
                boxShadow: (theme) => `0 0 0 4px ${theme.palette.background.paper}`,
              }}
            >
              {closing ? (
                <CloseIcon sx={{ fontSize: 15 }} />
              ) : row.done ? (
                <CheckIcon sx={{ fontSize: 15 }} />
              ) : (
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TL.todoDot }} />
              )}
            </Box>

            <Box sx={{ flex: 1, minWidth: 0, pt: 0.25 }}>
              <Typography
                variant="body2"
                fontWeight={600}
                sx={{ color: closing ? TL.closedLabel : row.done ? TL.label : TL.labelTodo }}
              >
                {row.label}
              </Typography>

              {row.at && (
                <Typography
                  variant="caption"
                  display="block"
                  sx={{ color: closing ? TL.closedMeta : TL.meta }}
                >
                  {formatDateTime(row.at)}
                </Typography>
              )}

              {closing ? (
                <Box sx={{ mt: 1, p: 1.5, borderRadius: 2, bgcolor: TL.closedTint }}>
                  <Typography variant="caption" display="block" fontWeight={700} sx={{ color: TL.closedLabel }}>
                    {titleCase(row.key)} by {actorLabel(row.entry || {}, order)}
                  </Typography>
                  {(order.cancellationReason || row.entry?.note) && (
                    <Typography variant="caption" display="block" sx={{ mt: 0.25, color: TL.closedMeta }}>
                      Reason: {order.cancellationReason || row.entry?.note}
                    </Typography>
                  )}
                </Box>
              ) : (
                row.note && (
                  <Typography variant="caption" display="block" sx={{ mt: 0.25, color: TL.meta }}>
                    {row.note}
                  </Typography>
                )
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The return's own progress, as the panel's version of the horizontal tracker the
 * customer is watching. Same four steps, same names — a support call about "it
 * says out for pickup" has to land on the same words on both screens.
 *
 * A declined return keeps whatever it had reached: the pickup really did happen
 * if it happened, and erasing it would make the refusal unreadable.
 */
function ReturnTimeline({ request }) {
  const history = request.history || [];
  const rejected = request.status === 'rejected';
  const reachedFrom = history.reduce(
    (max, row) => Math.max(max, RETURN_STATUS_STEPS.indexOf(row.status)),
    -1
  );
  const reached = Math.max(reachedFrom, RETURN_STATUS_STEPS.indexOf(request.status), 0);

  const stampFor = (key) =>
    ({
      requested: request.requestedAt,
      out_for_pickup: history.find((row) => row.status === 'out_for_pickup')?.changedAt,
      refund_started: request.refundStartedAt,
      refund_success: request.refundCompletedAt,
    })[key];

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', columnGap: 0.5 }}>
      {RETURN_STATUS_STEPS.map((key, index) => {
        const done = index <= reached;
        const at = stampFor(key);
        const last = index === RETURN_STATUS_STEPS.length - 1;

        return (
          <Box key={key} sx={{ position: 'relative', minWidth: 0 }}>
            {/* The rail runs out of this dot toward the next, and takes the colour
                of the step it arrives at — so the green stops where progress does. */}
            {!last && (
              <Box
                sx={{
                  position: 'absolute',
                  left: '50%',
                  top: 13,
                  height: 2,
                  width: '100%',
                  bgcolor: index + 1 <= reached ? TL.done : TL.rail,
                }}
              />
            )}
            <Box
              sx={{
                position: 'relative',
                zIndex: 1,
                width: 28,
                height: 28,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                color: done ? '#fff' : TL.todoDot,
                bgcolor: done ? TL.done : TL.rail,
              }}
            >
              {done ? (
                <CheckIcon sx={{ fontSize: 15 }} />
              ) : (
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'currentColor' }} />
              )}
            </Box>
            <Typography
              variant="caption"
              display="block"
              fontWeight={700}
              sx={{ mt: 1, pr: 1, lineHeight: 1.25, color: done ? TL.label : TL.labelTodo }}
            >
              {RETURN_STATUS_LABELS[key]}
            </Typography>
            {at && done && (
              <Typography variant="caption" display="block" sx={{ pr: 1, color: TL.meta }}>
                {formatDateTime(at)}
              </Typography>
            )}
            {last && rejected && (
              <Typography variant="caption" display="block" sx={{ pr: 1, color: TL.closedMeta }}>
                Declined
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function InfoCard({ title, children, action }) {
  return (
    <Card>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" textTransform="uppercase" letterSpacing={0.4}>
            {title}
          </Typography>
          {action}
        </Stack>
        {children}
      </CardContent>
    </Card>
  );
}

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [updating, setUpdating] = useState(false);
  const [updatingPayment, setUpdatingPayment] = useState(false);
  const [updatingReturn, setUpdatingReturn] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    useCallback(() => orderApi.detail(id), [id]),
    [id]
  );

  // Two admins can have the same order open, and the buyer may cancel it from the
  // storefront — either way this view follows along.
  useRealtimeRoom(rooms.order(id));
  useLiveRefetch(refetch, ORDER_EVENTS, {
    filter: (payload) => !payload?.order?._id || payload.order._id === id,
  });

  const order = data?.data?.order;

  if (loading) return <LinearProgress sx={{ mb: 2 }} />;
  if (error || !order) {
    return (
      <Card>
        <ErrorState title="Order not found" message={error?.message} onRetry={refetch} />
      </Card>
    );
  }

  const address = order.shippingAddress;
  const pricing = order.pricing;

  // Subtotal is billed from the discounted selling price, so the coupon is the
  // only deduction: subtotal − coupon + shipping = total. The product discount
  // was banked before the order existed; it is reported under the total as a
  // saving, never as a row, or this column stops matching what was charged.
  const priceRows = [
    ['Subtotal', formatPrice(pricing.subtotal, true)],
    pricing.couponDiscount > 0 && [
      `Coupon (${pricing.couponCode})`,
      `− ${formatPrice(pricing.couponDiscount, true)}`,
    ],
    ['Shipping', pricing.shipping ? formatPrice(pricing.shipping, true) : 'FREE'],
  ].filter(Boolean);

  const savings = (pricing.discount || 0) + (pricing.couponDiscount || 0);

  // The only payment action there is. A COD order never has one: cancelled it
  // collected nothing, delivered it is marked paid on its own.
  const awaitingRefund = canMarkRefunded(order);

  // The return, if this order has one. `canMoveReturn` is the panel's mirror of
  // RETURN_FLOW, so the button is only offered where the API would accept a move.
  const returnRequest = order.returnRequest?.status ? order.returnRequest : null;
  const canMoveReturn = Boolean(RETURN_STATUS_FLOW[returnRequest?.status]?.length);

  return (
    <Box>
      <PageHeader
        title={order.orderNumber}
        subtitle={`Placed ${formatDateTime(order.createdAt)}`}
        breadcrumbs={[{ label: 'Orders', to: '/orders' }, { label: order.orderNumber }]}
        action={
          <Stack direction="row" spacing={1.5}>
            <Button color="inherit" startIcon={<ArrowBackIcon sx={{ fontSize: 13 }} />} onClick={() => navigate('/orders')}>
              Back
            </Button>
            <Button
              variant="contained"
              startIcon={<EditIcon />}
              disabled={['cancelled', 'returned'].includes(order.orderStatus)}
              onClick={() => setUpdating(true)}
            >
              Update status
            </Button>
          </Stack>
        }
      />

      <Stack direction="row" spacing={1.5} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
        <StatusChip status={order.orderStatus} />
        <StatusChip status={order.paymentStatus} kind="payment" />
        {/* Its own chip rather than a fourth order status: the order stays
            Delivered while a return runs, and overwriting that would lose the
            fact that the parcel did arrive. */}
        {returnRequest && (
          <Chip
            size="small"
            label={RETURN_STATUS_LABELS[returnRequest.status]}
            color={RETURN_STATUS_COLOR[returnRequest.status] || 'default'}
            sx={{ fontWeight: 700, alignSelf: 'center' }}
          />
        )}
        <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>
          {order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Online (Razorpay)'}
        </Typography>
      </Stack>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card sx={{ mb: 2.5 }}>
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary" textTransform="uppercase" letterSpacing={0.4}>
                Items ({order.items.length})
              </Typography>
            </CardContent>
            <Divider />

            {order.items.map((item, index) => (
              <Stack
                key={index}
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}
              >
                <Avatar
                  variant="rounded"
                  src={thumb(item.image, 96)}
                  sx={{ width: 56, height: 56, ...(item.slug && { cursor: 'pointer' }) }}
                  {...storeLinkProps(item.slug)}
                />

                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {/* Deep-link into the storefront so support can see exactly what the buyer saw. */}
                  <Tooltip title={item.slug ? 'View on storefront' : ''}>
                    <Typography
                      variant="body2"
                      fontWeight={600}
                      {...storeLinkProps(item.slug)}
                      sx={
                        item.slug
                          ? {
                              display: 'block',
                              color: 'text.primary',
                              textDecoration: 'none',
                              '&:hover': { color: 'primary.main' },
                            }
                          : undefined
                      }
                    >
                      {item.name}
                    </Typography>
                  </Tooltip>
                  {/* The SKU that must actually be picked, packed and — if returned — restocked. */}
                  {item.variantLabel && (
                    <Typography variant="caption" display="block" fontWeight={700} color="text.primary">
                      {item.variantLabel}
                      {item.variantSku && (
                        <Box component="span" sx={{ ml: 1, fontWeight: 400, fontFamily: 'monospace', color: 'text.secondary' }}>
                          {item.variantSku}
                        </Box>
                      )}
                      {item.weight?.value && (
                        <Box component="span" sx={{ ml: 1, fontWeight: 400, color: 'text.secondary' }}>
                          · {item.weight.value}
                          {item.weight.unit || 'g'}
                        </Box>
                      )}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {[item.brand, item.categoryName, item.subCategoryName].filter(Boolean).join(' · ')}
                  </Typography>
                  <Typography variant="caption" display="block" color="text.secondary">
                    {formatPrice(item.finalPrice, true)} × {item.quantity}
                    {item.discountPercent > 0 && ` · ${Math.round(item.discountPercent)}% off`}
                  </Typography>
                </Box>

                <Typography variant="body2" fontWeight={700}>
                  {formatPrice(item.lineTotal, true)}
                </Typography>
              </Stack>
            ))}
          </Card>

          {/* The return is a second journey over the same parcel, so it gets its
              own card above the order's history — and it goes first, because while
              a return is running it is the only part still moving. */}
          {returnRequest && (
            <Box sx={{ mb: 2.5 }}>
            <InfoCard
              title="Return request"
              action={
                canMoveReturn && (
                  <Button size="small" startIcon={<ReturnIcon />} onClick={() => setUpdatingReturn(true)}>
                    Update return
                  </Button>
                )
              }
            >
              <ReturnTimeline request={returnRequest} />

              <Divider sx={{ my: 2.5 }} />

              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" spacing={2}>
                  <Typography variant="body2" color="text.secondary">
                    Reason
                  </Typography>
                  <Typography variant="body2" fontWeight={600} textAlign="right">
                    {returnRequest.reason}
                  </Typography>
                </Stack>
                {returnRequest.refundAmount > 0 && (
                  <Stack direction="row" justifyContent="space-between" spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Refund amount
                    </Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {formatPrice(returnRequest.refundAmount, true)}
                    </Typography>
                  </Stack>
                )}
                {returnRequest.pickupTrackingNumber && (
                  <Stack direction="row" justifyContent="space-between" spacing={2}>
                    <Typography variant="body2" color="text.secondary">
                      Pickup
                    </Typography>
                    <Typography variant="body2" fontWeight={600} textAlign="right">
                      {returnRequest.pickupTrackingNumber}
                      {returnRequest.pickupPartner && ` · ${returnRequest.pickupPartner}`}
                    </Typography>
                  </Stack>
                )}
              </Stack>

              {returnRequest.status === 'rejected' && (
                <Box sx={{ mt: 2, p: 1.5, borderRadius: 2, bgcolor: TL.closedTint }}>
                  <Typography variant="caption" fontWeight={700} display="block" sx={{ color: TL.closedLabel }}>
                    Return declined
                  </Typography>
                  <Typography variant="caption" display="block" sx={{ mt: 0.25, color: TL.closedMeta }}>
                    {returnRequest.rejectionReason}
                  </Typography>
                </Box>
              )}
            </InfoCard>
            </Box>
          )}

          <InfoCard title="Status history">
            <StatusTimeline order={order} />
          </InfoCard>
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }}>
          <Stack spacing={2.5}>
            <InfoCard title="Customer">
              <Typography variant="body2" fontWeight={700}>
                {order.user?.name || address.fullName}
              </Typography>
              {order.user?.email && (
                <Typography variant="body2" color="text.secondary">
                  {order.user.email}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary">
                {formatPhone(order.user?.phone || address.phone)}
              </Typography>
            </InfoCard>

            <InfoCard title="Shipping address">
              <Typography variant="body2" fontWeight={700}>
                {address.fullName}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {address.addressLine1}
                {address.addressLine2 && `, ${address.addressLine2}`}
                {address.landmark && `, ${address.landmark}`}
                <br />
                {address.city}, {address.state} — {address.pincode}
                <br />
                {address.country}
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Phone: {formatPhone(address.phone)}
              </Typography>
            </InfoCard>

            {(order.trackingNumber || order.expectedDeliveryDate) && (
              <InfoCard title="Shipment">
                {order.trackingNumber && (
                  <Typography variant="body2">
                    Tracking: <strong>{order.trackingNumber}</strong>
                  </Typography>
                )}
                {order.courierPartner && (
                  <Typography variant="body2" color="text.secondary">
                    Courier: {order.courierPartner}
                  </Typography>
                )}
                {order.expectedDeliveryDate && (
                  <Typography variant="body2" color="text.secondary">
                    Expected: {formatDateTime(order.expectedDeliveryDate)}
                  </Typography>
                )}
              </InfoCard>
            )}

            <InfoCard
              title="Payment summary"
              action={
                // Lives here rather than beside "Update status" because it has to
                // work on a closed order — a cancelled prepaid order is the only
                // thing it is ever for. Absent otherwise, so nobody is invited to
                // settle money that moves on its own.
                awaitingRefund && (
                  <Button
                    size="small"
                    startIcon={<PaymentIcon />}
                    onClick={() => setUpdatingPayment(true)}
                  >
                    Mark refunded
                  </Button>
                )
              }
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
                <StatusChip status={order.paymentStatus} kind="payment" />
                {order.paymentStatus === 'refund_pending' && (
                  <Typography variant="caption" color="warning.main" fontWeight={600}>
                    Refund not raised yet
                  </Typography>
                )}
                {order.refundedAt && (
                  <Typography variant="caption" color="text.secondary">
                    {formatDateTime(order.refundedAt)}
                  </Typography>
                )}
              </Stack>

              {order.paymentMethod === 'cod' &&
                order.paymentStatus === 'pending' &&
                ['cancelled', 'returned'].includes(order.orderStatus) && (
                  <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
                    Cash on delivery — nothing was collected, so there is nothing to refund.
                  </Typography>
                )}

              {order.refundReference && (
                <Typography variant="caption" color="text.secondary" sx={{ mb: 1.5, display: 'block' }}>
                  Refund ref: {order.refundReference}
                </Typography>
              )}

              <Stack spacing={1}>
                {priceRows.map(([label, value]) => (
                  <Stack key={label} direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      {label}
                    </Typography>
                    <Typography variant="body2" fontWeight={500}>
                      {value}
                    </Typography>
                  </Stack>
                ))}
              </Stack>

              <Divider sx={{ my: 1.5, borderStyle: 'dashed' }} />

              <Stack direction="row" justifyContent="space-between">
                <Typography variant="subtitle2" fontWeight={800}>
                  Total
                </Typography>
                <Typography variant="subtitle2" fontWeight={800}>
                  {formatPrice(pricing.total, true)}
                </Typography>
              </Stack>

              {savings > 0 && (
                <Typography
                  variant="caption"
                  fontWeight={600}
                  sx={{ mt: 1.5, display: 'block', color: 'success.main' }}
                >
                  Saved {formatPrice(savings, true)}
                </Typography>
              )}

              {order.payment && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
                  {titleCase(order.payment.status)}
                  {order.payment.method && ` · ${order.payment.method.toUpperCase()}`}
                  {order.payment.razorpayPaymentId && ` · ${order.payment.razorpayPaymentId}`}
                </Typography>
              )}
            </InfoCard>
          </Stack>
        </Grid>
      </Grid>

      {updating && (
        <UpdateStatusDialog
          order={order}
          onClose={() => setUpdating(false)}
          onUpdated={() => {
            setUpdating(false);
            refetch();
          }}
        />
      )}

      {updatingReturn && (
        <UpdateReturnStatusDialog
          order={order}
          onClose={() => setUpdatingReturn(false)}
          onUpdated={() => {
            setUpdatingReturn(false);
            refetch();
          }}
        />
      )}

      {updatingPayment && (
        <UpdatePaymentDialog
          order={order}
          onClose={() => setUpdatingPayment(false)}
          onUpdated={() => {
            setUpdatingPayment(false);
            refetch();
          }}
        />
      )}
    </Box>
  );
}
