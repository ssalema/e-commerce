import { useCallback, useEffect, useState } from 'react';
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
import Skeleton from '@mui/material/Skeleton';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { keyframes } from '@mui/material/styles';

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
const actorLabel = (entry, order = {}) => {
  const side = entry.actor || (CLOSING_STATUSES.includes(entry.status) ? order.cancelledBy : null);
  const name = entry.changedBy?.name;

  if (side === 'customer') return name ? `customer (${name})` : 'customer';
  if (side === 'system') return 'the system';
  return name ? `${name} (admin)` : 'our team';
};

/** A step's note, credited to whoever left it: "by our team · picked up". */
const noteWithActor = (entry) =>
  entry?.note ? `by ${actorLabel(entry)} · ${entry.note}` : null;

/**
 * The storefront's `animate-pulse`, by hand — the breathing bead that marks the
 * step a journey is sitting on right now. Tailwind's own keyframes are not in
 * this app, and the panel should not be the screen where "where is it now" reads
 * as static when the customer's copy of the same ladder is breathing.
 */
const PULSE = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

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
      // Nothing is still in progress once an order has stopped.
      active: !closed && index === reached,
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
 * The one ladder both of an order's journeys are drawn as — a port of
 * client/src/components/orders/Timeline.jsx, deliberately identical.
 *
 * The fulfilment trail and the return over the same parcel used to be two
 * different pictures: a vertical trail for one, a four-across tracker for the
 * other. They answer the same question ("where has this got to"), so they now
 * get the same answer shape, and an agent on the phone and the customer
 * describing their screen are looking at one thing on both journeys.
 *
 * A row is:
 *   { key, label, done, active, closing, at, note, panel: { title, text } }
 */
function Timeline({ rows }) {
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
                ...(row.active && { animation: `${PULSE} 2s ease-in-out infinite` }),
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

              {row.panel ? (
                <Box sx={{ mt: 1, p: 1.5, borderRadius: 2, bgcolor: TL.closedTint }}>
                  <Typography
                    variant="caption"
                    display="block"
                    fontWeight={700}
                    sx={{ color: TL.closedLabel }}
                  >
                    {row.panel.title}
                  </Typography>
                  {row.panel.text && (
                    <Typography
                      variant="caption"
                      display="block"
                      sx={{ mt: 0.25, color: TL.closedMeta }}
                    >
                      {row.panel.text}
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
 * The order's trail, drawn as the same vertical timeline the storefront's order
 * page shows the shopper — same rows, same beads, same rail, same red panel — so
 * an agent on the phone and the customer describing their screen are looking at
 * one picture. The wording inside the red panel is the one deliberate
 * difference: the shop needs to read *who* cancelled, where the shopper reads
 * "by you".
 */
function StatusTimeline({ order }) {
  const rows = timelineRows(order).map((row) =>
    row.closing
      ? {
          ...row,
          panel: {
            title: `${titleCase(row.key)} by ${actorLabel(row.entry || {}, order)}`,
            text: order.cancellationReason || row.entry?.note
              ? `Reason: ${order.cancellationReason || row.entry?.note}`
              : null,
          },
        }
      : row
  );

  return <Timeline rows={rows} />;
}

/**
 * The rows the return's timeline draws — the twin of `timelineRows` above, over
 * the return's own ladder, and a port of `returnRows` in
 * client/src/components/orders/ReturnTracker.jsx.
 *
 * A declined return is read the way a cancelled order is: the steps it really
 * reached stay complete, the refusal is appended as the closing row in the words
 * staff wrote, and the steps it never got to are not drawn at all. A live return
 * keeps the full ladder ahead of it, greyed, so staff see the same "what's left"
 * the customer does.
 */
function returnRows(request) {
  const history = request.history || [];
  const rejected = request.status === 'rejected';
  const rankOf = (status) => RETURN_STATUS_STEPS.indexOf(status);
  const entryFor = (status) => history.find((row) => row.status === status);

  const reachedFromHistory = history.reduce((max, row) => Math.max(max, rankOf(row.status)), -1);
  // "Return Requested" is true of every return, whether or not a `requested` row
  // was ever written — raising it is what created the request.
  const reached = rejected
    ? Math.max(reachedFromHistory, 0)
    : Math.max(reachedFromHistory, rankOf(request.status), 0);

  const stampFor = (key) =>
    ({
      requested: request.requestedAt,
      out_for_pickup: request.pickedUpAt || entryFor('out_for_pickup')?.changedAt,
      refund_started: request.refundStartedAt,
      refund_success: request.refundCompletedAt,
    })[key];

  const steps = RETURN_STATUS_STEPS.slice(0, rejected ? reached + 1 : undefined).map(
    (key, index) => ({
      key,
      label: RETURN_STATUS_LABELS[key],
      done: index <= reached,
      // Nothing is still in flight once the request has been refused, and the
      // last step is where the journey ends rather than something in progress.
      active: !rejected && index === reached && reached < RETURN_STATUS_STEPS.length - 1,
      at: stampFor(key) || (index === 0 ? request.requestedAt : entryFor(key)?.changedAt),
      // The row that raised the return is stamped with the reason as its note,
      // which the details underneath already state in full — so it is dropped
      // here rather than said twice a few lines apart. Every other note is a
      // staff remark, and the panel names who left it — the same "who did this"
      // the order's own closing row carries, and the thing an agent picking up
      // the call asks first.
      note: key === 'requested' ? null : noteWithActor(entryFor(key)),
    })
  );

  if (!rejected) return steps;

  const entry = entryFor('rejected');

  return [
    ...steps,
    {
      key: 'rejected',
      label: RETURN_STATUS_LABELS.rejected,
      done: true,
      closing: true,
      at: request.rejectedAt || entry?.changedAt,
      panel: {
        title: `Declined by ${actorLabel(entry || {}, {})}`,
        text: request.rejectionReason ? `Reason: ${request.rejectionReason}` : null,
      },
    },
  ];
}

/**
 * The return's own progress, on the same ladder the order's history uses and —
 * like the storefront — behind a tab in the same card, so a support call about
 * "it says out for pickup" lands on the same words in the same place on both
 * screens.
 */
function ReturnTimeline({ request }) {
  return <Timeline rows={returnRows(request)} />;
}

/**
 * The page's own outline while the order is being read.
 *
 * The order number is what a support agent is looking at when this page opens, so
 * the header keeps its breadcrumb back to the list and greys in the title rather
 * than replacing the whole page with a progress bar — the layout that arrives is
 * already on screen, and nothing jumps when the data lands.
 */
function OrderDetailSkeleton() {
  return (
    <Box>
      <PageHeader
        title={<Skeleton variant="text" width={200} />}
        subtitle={<Skeleton variant="text" width={260} />}
        breadcrumbs={[{ label: 'Orders', to: '/orders' }, { label: 'Order' }]}
        action={<Skeleton variant="rounded" width={210} height={36} />}
      />

      <Stack direction="row" spacing={1.5} sx={{ mb: 3 }}>
        <Skeleton variant="rounded" width={96} height={24} />
        <Skeleton variant="rounded" width={96} height={24} />
        <Skeleton variant="text" width={130} />
      </Stack>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          <Card sx={{ mb: 2.5 }}>
            <CardContent>
              <Skeleton variant="text" width={90} height={20} />
            </CardContent>
            <Divider />
            {Array.from({ length: 3 }).map((_, index) => (
              <Stack
                key={index}
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ px: 2.5, py: 2, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}
              >
                <Skeleton variant="rounded" width={56} height={56} sx={{ flexShrink: 0 }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Skeleton variant="text" width="60%" />
                  <Skeleton variant="text" width="30%" height={16} />
                </Box>
                <Skeleton variant="text" width={70} />
              </Stack>
            ))}
          </Card>

          {/* The tracking card — a heading over the journey's steps. */}
          <Card>
            <CardContent>
              <Skeleton variant="text" width={120} height={20} sx={{ mb: 2 }} />
              <Stack spacing={1.5}>
                {Array.from({ length: 4 }).map((_, index) => (
                  <Stack key={index} direction="row" spacing={2} alignItems="center">
                    <Skeleton variant="circular" width={22} height={22} sx={{ flexShrink: 0 }} />
                    <Skeleton variant="text" width={`${55 - index * 8}%`} />
                  </Stack>
                ))}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 4 }}>
          <Stack spacing={2.5}>
            {[3, 5, 4].map((lines, cardIndex) => (
              <Card key={cardIndex}>
                <CardContent>
                  <Skeleton variant="text" width={110} height={18} sx={{ mb: 2 }} />
                  {Array.from({ length: lines }).map((_, line) => (
                    <Skeleton key={line} variant="text" width={`${85 - line * 10}%`} />
                  ))}
                </CardContent>
              </Card>
            ))}
          </Stack>
        </Grid>
      </Grid>
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
  /**
   * Which journey the tracking card is showing. Only consulted when the order
   * has a return, and it opens on the return: that is the half still moving,
   * and it is what an agent picking up the call needs first.
   */
  const [journey, setJourney] = useState('return');
  // The choice belongs to the order on screen, not to the page: this component
  // is reused from one order to the next, and a tab left on the history would
  // otherwise hide the next order's live return.
  useEffect(() => setJourney('return'), [id]);

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

  if (loading) return <OrderDetailSkeleton />;
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
  const returnMoves = RETURN_STATUS_FLOW[returnRequest?.status] || [];
  const canMoveReturn = returnMoves.length > 0;
  // What the button is actually for, named before it is pressed — "Move to Out
  // for Pickup or Return Declined" is a far better prompt than "Update return".
  const nextReturnStepHint = `Move to ${returnMoves.map((step) => RETURN_STATUS_LABELS[step]).join(' or ')}`;
  const closedReturnHint = returnRequest
    ? `This return is ${RETURN_STATUS_LABELS[returnRequest.status].toLowerCase()} and can no longer be moved`
    : '';

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

          {/* Both journeys over the same parcel live in this one card, a tab
              apiece — the same single place the shopper reads them in. A return
              is a second trip rather than a continuation, so it keeps its own
              tracker; with no return there is nothing to switch between and the
              card is just the order's status timeline under a plain heading. */}
          <Card>
            {/* The header sits outside the content's padding so its rule runs the
                full width of the card — the storefront's tab strip reaches its
                card's edges the same way. The tabs carry their own padding and
                height, so the row adds none on their side: any left padding here
                would push the first tab's underline in off the card's edge. */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              spacing={1.5}
              sx={{
                pl: returnRequest ? 0 : 2,
                pr: 2,
                pt: returnRequest ? 0 : 1.5,
                pb: returnRequest ? 0 : 1.5,
                borderBottom: 1,
                borderColor: 'divider',
              }}
            >
              {returnRequest ? (
                <Tabs
                  value={journey}
                  onChange={(_, value) => setJourney(value)}
                  sx={{ minHeight: 44, '& .MuiTab-root': { minHeight: 44, fontWeight: 700 } }}
                >
                  <Tab value="order" label="Order Status" />
                  <Tab value="return" label="Return Status" />
                </Tabs>
              ) : (
                <Typography variant="subtitle2" color="text.secondary" textTransform="uppercase" letterSpacing={0.4}>
                  Order Status
                </Typography>
              )}
              {/* The return's one action, offered only while its own tab is
                  open — and drawn as the card's primary button rather than the
                  plain text link it was, because moving a return along is the
                  only thing there is to *do* on this tab and it was reading as
                  a caption. On a return that has ended it stays put, disabled,
                  and says why: a button that vanishes reads as a broken
                  feature, which is exactly how the storefront handles the same
                  moment. */}
              {returnRequest && journey === 'return' && (
                <Tooltip title={canMoveReturn ? nextReturnStepHint : closedReturnHint}>
                  {/* A disabled button fires no events, so the tooltip needs a
                      live element of its own to hang off. */}
                  <Box component="span" sx={{ flexShrink: 0 }}>
                    <Button
                      variant="contained"
                      size="small"
                      disableElevation
                      disabled={!canMoveReturn}
                      startIcon={<ReturnIcon sx={{ fontSize: 16 }} />}
                      onClick={() => setUpdatingReturn(true)}
                      sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                    >
                      Update return
                    </Button>
                  </Box>
                </Tooltip>
              )}
            </Stack>

            <CardContent>
              {returnRequest && journey === 'return' ? (
                <>
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

                {/* A declined return has already said so — who declined it and
                    why — in the closing row of the ladder above, the same place
                    a cancelled order says it. Repeating it under the details
                    would be the same sentence twice. */}
                </>
              ) : (
                <StatusTimeline order={order} />
              )}
            </CardContent>
          </Card>
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
