import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';

import CloseIcon from '@mui/icons-material/Close';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ReceiptIcon from '@mui/icons-material/ReceiptLongOutlined';

import { orderApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { ORDER_EVENTS } from '../../realtime/events';
import { formatDate, formatPrice, thumb } from '../../utils/format';
import StatusChip from '../common/StatusChip';
import EmptyState from '../common/EmptyState';
import ErrorState from '../common/ErrorState';

/** How many product thumbnails a card shows before it summarises the rest. */
const VISIBLE_ITEMS = 4;

/**
 * One label above one value — the header strip's unit, repeated three times.
 *
 * The label wears the same uppercase caption the panel uses for every section
 * heading, so this strip reads as part of the admin rather than as a transplant
 * from the storefront card it mirrors.
 */
function Field({ label, value }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        textTransform="uppercase"
        letterSpacing={0.4}
        fontWeight={600}
        display="block"
      >
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={700}>
        {value}
      </Typography>
    </Box>
  );
}

/**
 * A single account's orders, in the same card the customer sees under My Orders.
 *
 * The Users table already says how many orders someone placed and what they spent;
 * this is the answer to the next question — which orders those were — without
 * making an admin carry a name over to the Orders screen and search for it.
 *
 * Deliberately read-only: status moves stay on the order's own screen, which the
 * "View details" button leads to, so there is one place where an order changes.
 */
export default function UserOrdersDialog({ user, onClose }) {
  const navigate = useNavigate();
  const open = Boolean(user);

  const query = useFetch(
    useCallback(
      () => orderApi.list({ user: user?._id, limit: 100, status: 'all', paymentStatus: 'all' }),
      [user?._id]
    ),
    [user?._id],
    { enabled: open }
  );

  // A status move or a payment clearing while the dialog is open should show here too.
  useLiveRefetch(query.refetch, ORDER_EVENTS);

  const orders = query.data?.data?.orders || [];
  const total = query.data?.meta?.total || 0;

  /* Leaving for the order's own screen closes what was only a way of getting there. */
  const openOrder = (id) => {
    onClose();
    navigate(`/orders/${id}`);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle sx={{ fontWeight: 700, pr: 6 }}>
        {user?.name}
        <Typography variant="body2" color="text.secondary">
          {query.loading ? user?.orderCount : total} order(s) · {formatPrice(user?.totalSpent)} ·{' '}
          {user?.email}
        </Typography>
        {/* Dismissal lives in the corner, as in every other dialog here, so this
            one needs no footer of its own. */}
        <IconButton
          onClick={onClose}
          size="small"
          aria-label="Close"
          sx={{ position: 'absolute', right: 12, top: 12, color: 'text.secondary' }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ bgcolor: 'background.default' }}>
        {query.loading ? (
          <Stack spacing={2.5}>
            {[0, 1].map((i) => (
              <Skeleton key={i} variant="rounded" height={180} sx={{ borderRadius: 3 }} />
            ))}
          </Stack>
        ) : query.error ? (
          <ErrorState
            title="Could not load these orders"
            message={query.error.message}
            onRetry={query.refetch}
          />
        ) : !orders.length ? (
          <EmptyState
            icon={<ReceiptIcon sx={{ fontSize: 34 }} />}
            title="No orders yet"
            message={`${user?.name} has not placed an order on this account.`}
          />
        ) : (
          <Stack spacing={2.5}>
            {orders.map((order) => (
              <Card key={order._id}>
                <Stack
                  direction="row"
                  flexWrap="wrap"
                  alignItems="center"
                  justifyContent="space-between"
                  rowGap={1}
                  columnGap={2}
                  sx={{ px: 2.5, py: 1.5, bgcolor: 'background.default' }}
                >
                  <Stack direction="row" flexWrap="wrap" rowGap={1} columnGap={4}>
                    <Field label="Order" value={order.orderNumber} />
                    <Field label="Placed on" value={formatDate(order.createdAt)} />
                    <Field label="Total" value={formatPrice(order.pricing?.total)} />
                  </Stack>

                  {/* Same pair, same order as the Orders table's two status columns. */}
                  <Stack direction="row" spacing={1}>
                    <StatusChip status={order.paymentStatus} kind="payment" />
                    <StatusChip status={order.orderStatus} />
                  </Stack>
                </Stack>
                <Divider />

                <Box sx={{ px: 2.5, py: 2 }}>
                  <Stack direction="row" flexWrap="wrap" rowGap={2} columnGap={3}>
                    {order.items.slice(0, VISIBLE_ITEMS).map((item, index) => (
                      <Stack
                        key={index}
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        sx={{ maxWidth: 240 }}
                      >
                        <Avatar
                          variant="rounded"
                          src={thumb(item.image, 96)}
                          alt={item.name}
                          sx={{ width: 56, height: 56 }}
                        />
                        <Box sx={{ minWidth: 0 }}>
                          <Typography
                            variant="body2"
                            fontWeight={600}
                            title={item.name}
                            sx={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {item.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Qty: {item.quantity}
                          </Typography>
                        </Box>
                      </Stack>
                    ))}

                    {order.items.length > VISIBLE_ITEMS && (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        fontWeight={600}
                        alignSelf="center"
                      >
                        +{order.items.length - VISIBLE_ITEMS} more
                      </Typography>
                    )}
                  </Stack>
                </Box>
                <Divider />

                <Stack direction="row" justifyContent="flex-end" sx={{ px: 1.5, py: 1 }}>
                  <Button
                    size="small"
                    endIcon={<ChevronRightIcon />}
                    onClick={() => openOrder(order._id)}
                  >
                    View details
                  </Button>
                </Stack>
              </Card>
            ))}

            {/* One page of history is all this dialog fetches; on the rare account
                that outgrew it, say so rather than quietly showing a subset. */}
            {total > orders.length && (
              <Typography variant="caption" color="text.secondary" textAlign="center">
                Showing the {orders.length} most recent of {total} orders — the Orders screen lists
                them all.
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
