import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import ListSubheader from '@mui/material/ListSubheader';
import InputAdornment from '@mui/material/InputAdornment';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import SearchIcon from '@mui/icons-material/Search';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import EditIcon from '@mui/icons-material/EditOutlined';

import { orderApi } from '../api/endpoints';
import useFetch from '../hooks/useFetch';
import useDebounce from '../hooks/useDebounce';
import { useLiveRefetch } from '../realtime/useRealtime';
import { ORDER_EVENTS } from '../realtime/events';
import { formatPrice, formatDate, formatPhone, titleCase } from '../utils/format';
import {
  ORDER_STATUSES,
  SEARCH_DEBOUNCE_MS,
  RETURN_STATUS_LABELS,
} from '../utils/constants';
import PageHeader from '../components/common/PageHeader';
import DataTable from '../components/common/DataTable';
import StatusChip from '../components/common/StatusChip';
import ResetFiltersButton from '../components/common/ResetFiltersButton';
import RangeSelect from '../components/dashboard/RangeSelect';
import useRangeQuery from '../components/dashboard/useRangeQuery';
import UpdateStatusDialog from '../components/orders/UpdateStatusDialog';
import ReturnStatusChip from '../components/orders/ReturnStatusChip';

/*
 * Where each return status is filtered from.
 *
 * A return status is still not an order status — the order underneath keeps its
 * own — but every one of them answers a question this toolbar already asks. Three
 * are about where the parcel is (waiting on us, being collected, refused), two
 * about where the money is; so each sits in the control that asks its question and
 * the toolbar keeps no return control of its own. Values are prefixed, which is
 * what lets the query builder tell the two vocabularies apart in one select.
 */
const RETURN_PREFIX = 'return:';
const RETURN_BY_ORDER_STATUS = ['requested', 'out_for_pickup', 'rejected'];
const RETURN_BY_PAYMENT = ['refund_started', 'refund_success'];

/** `requested` → `return:requested`, and back — `null` for a plain status. */
const returnValue = (status) => `${RETURN_PREFIX}${status}`;
const returnOf = (value) =>
  value.startsWith(RETURN_PREFIX) ? value.slice(RETURN_PREFIX.length) : null;

export default function Orders() {
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [paymentStatus, setPaymentStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [updating, setUpdating] = useState(null);

  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);

  // Month / Year / All time / Custom…, the same window vocabulary the dashboard and
  // the Inbox tabs use, instead of the bare pair of date inputs this page once had.
  const range = useRangeQuery('all');

  /*
   * Two controls, one return question between them. A return status chosen in the
   * order-status or payment control is a `returnStatus` to the API, and that
   * control itself then asks nothing of the order status or payment it sits on —
   * "Refund Started" is the whole filter, not "refund started orders that are
   * also paid".
   *
   * Delivered is the one plain status that has to say something about returns:
   * once a return is raised the order belongs to the return queue, so Delivered
   * asks for the orders with no return on them and the parcel stops being listed
   * in two places at once.
   */
  const statusReturn = returnOf(status);
  const paymentReturn = returnOf(paymentStatus);
  const returnQuery =
    statusReturn || paymentReturn || (status === 'delivered' ? 'none' : 'all');
  const statusQuery = statusReturn ? 'all' : status;
  const paymentQuery = paymentReturn ? 'all' : paymentStatus;

  const query = useFetch(
    useCallback(
      () =>
        orderApi.list({
          page,
          limit,
          status: statusQuery,
          paymentStatus: paymentQuery,
          returnStatus: returnQuery,
          search: debouncedSearch || undefined,
          ...range.query,
        }),
      [page, limit, statusQuery, paymentQuery, returnQuery, debouncedSearch, range.queryKey]
    ),
    [page, limit, statusQuery, paymentQuery, returnQuery, debouncedSearch, range.queryKey]
  );

  // New orders appear at the top of page 1 without anyone reaching for refresh.
  useLiveRefetch(query.refetch, ORDER_EVENTS);

  const orders = query.data?.data?.orders || [];
  const meta = query.data?.meta;

  const columns = [
    {
      key: 'orderNumber',
      label: 'Order',
      minWidth: 140,
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={700}>
            {row.orderNumber}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDate(row.createdAt)}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'user',
      label: 'User Name',
      minWidth: 160,
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={600} noWrap>
            {row.user?.name || row.shippingAddress?.fullName || 'Guest'}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {row.user?.email || formatPhone(row.shippingAddress?.phone)}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'product',
      label: 'Product Name',
      minWidth: 220,
      render: (row) => (
        <Box sx={{ maxWidth: 260 }}>
          <Typography variant="body2" noWrap title={row.items[0]?.name}>
            {row.items[0]?.name || '—'}
          </Typography>
          {row.items.length > 1 && (
            <Typography variant="caption" color="text.secondary">
              +{row.items.length - 1} more item(s)
            </Typography>
          )}
        </Box>
      ),
    },
    {
      key: 'category',
      label: 'Category',
      minWidth: 130,
      render: (row) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {row.items[0]?.categoryName || '—'}
        </Typography>
      ),
    },
    {
      key: 'subCategory',
      label: 'Sub-category',
      minWidth: 130,
      render: (row) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {row.items[0]?.subCategoryName || '—'}
        </Typography>
      ),
    },
    {
      key: 'quantity',
      label: 'Qty',
      align: 'center',
      render: (row) => (
        <Typography variant="body2" fontWeight={600}>
          {row.items.reduce((sum, item) => sum + item.quantity, 0)}
        </Typography>
      ),
    },
    {
      key: 'paymentStatus',
      label: 'Payment',
      align: 'center',
      render: (row) => (
        <Stack spacing={0.5} alignItems="center">
          <StatusChip status={row.paymentStatus} kind="payment" />
          <Typography variant="caption" color="text.secondary">
            {row.paymentMethod === 'cod' ? 'COD' : 'Online (Razorpay)'}
          </Typography>
        </Stack>
      ),
    },
    {
      key: 'orderStatus',
      label: 'Order Status',
      align: 'center',
      render: (row) => (
        <Stack spacing={0.5} alignItems="center">
          <StatusChip status={row.orderStatus} />
          {/* Stacked under the order's own status rather than replacing it: the
              order stays Delivered while a return runs over it, and both facts
              matter to whoever is working the queue. */}
          {/* Full size, like the status above it: shrinking it made the return
              read as an annotation on the order status rather than a status in
              its own right. */}
          <ReturnStatusChip status={row.returnRequest?.status} />
        </Stack>
      ),
    },
    {
      key: 'total',
      label: 'Final Price',
      align: 'right',
      render: (row) => (
        <Typography variant="body2" fontWeight={700}>
          {formatPrice(row.pricing.total)}
        </Typography>
      ),
    },
    {
      key: 'actions',
      label: 'Action',
      align: 'center',
      width: 110,
      render: (row) => (
        // The row itself navigates to the order, so this cell has to swallow its own
        // clicks — otherwise "Update status" would open the dialog and leave the page
        // out from under it at the same time.
        <Stack
          direction="row"
          spacing={0.25}
          justifyContent="center"
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip title="View order details">
            <IconButton size="small" color="primary" onClick={() => navigate(`/orders/${row._id}`)}>
              <VisibilityIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Update status">
            <span>
              <IconButton
                size="small"
                disabled={['cancelled', 'returned'].includes(row.orderStatus)}
                onClick={() => setUpdating(row)}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ),
    },
  ];

  /** Narrowing the window can drop the page the reader is on, so start over. */
  const selectRange = (key, custom) => {
    range.select(key, custom);
    setPage(1);
  };

  /*
   * Picking a return status in one control clears one picked in the other: the API
   * takes a single `returnStatus`, so both naming different ones would leave one
   * of them showing a filter that is not being applied.
   */
  const selectStatus = (value) => {
    setStatus(value);
    if (returnOf(value)) setPaymentStatus((current) => (returnOf(current) ? 'all' : current));
    setPage(1);
  };

  const selectPayment = (value) => {
    setPaymentStatus(value);
    if (returnOf(value)) setStatus((current) => (returnOf(current) ? 'all' : current));
    setPage(1);
  };

  const isFiltered =
    Boolean(search) || status !== 'all' || paymentStatus !== 'all' || !range.isDefault;

  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setPaymentStatus('all');
    range.reset();
    setPage(1);
  };

  return (
    <Box>
      <PageHeader
        title="Orders"
        subtitle={`${meta?.total ?? 0} order(s) placed`}
        breadcrumbs={[{ label: 'Orders' }]}
      />

      <DataTable
        columns={columns}
        rows={orders}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        errorTitle="Could not load the orders"
        // The row opens the order, the way a reactivation row opens its request —
        // the eye icon stays for the people who aim at it, but the whole row is the
        // target. The status control lives in its own dialog, so nothing in a cell
        // competes with the click.
        onRowClick={(row) => navigate(`/orders/${row._id}`)}
        page={page}
        limit={limit}
        total={meta?.total || 0}
        onPageChange={setPage}
        onLimitChange={(value) => {
          setLimit(value);
          setPage(1);
        }}
        emptyTitle={isFiltered ? 'No orders match these filters' : 'No orders yet'}
        emptyMessage={
          isFiltered
            ? 'Try a different search term, or widen the date, status or payment filter.'
            : 'Orders will appear here as soon as customers start buying.'
        }
        emptyAction={isFiltered ? { label: 'Reset filters', onClick: resetFilters } : undefined}
        toolbar={
          <Stack
            direction={{ xs: 'column', lg: 'row' }}
            alignItems={{ xs: 'stretch', lg: 'center' }}
            spacing={1.5}
            sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            <TextField
              placeholder="Search order no., product or customer…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              sx={{ flex: 1, minWidth: 220 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />

            <TextField
              select
              label="Order status"
              value={status}
              onChange={(e) => selectStatus(e.target.value)}
              sx={{ minWidth: 165 }}
            >
              <MenuItem value="all">All statuses</MenuItem>
              {ORDER_STATUSES.map((value) => (
                <MenuItem key={value} value={value}>
                  {titleCase(value)}
                </MenuItem>
              ))}
              {/* Where the parcel is once it is coming back — the same question
                  this control already answers, so it is answered here. Grouped
                  below a rule because these are the return's states, not the
                  order's: the order underneath is still Delivered. */}
              <Divider />
              <ListSubheader sx={{ lineHeight: 2.2, fontSize: 12, fontWeight: 700 }}>
                Return
              </ListSubheader>
              {RETURN_BY_ORDER_STATUS.map((value) => (
                <MenuItem key={value} value={returnValue(value)}>
                  {RETURN_STATUS_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              label="Payment"
              value={paymentStatus}
              onChange={(e) => selectPayment(e.target.value)}
              sx={{ minWidth: 165 }}
            >
              <MenuItem value="all">All payments</MenuItem>
              {/* "Refund pending" is the queue staff work through after a
                  cancellation, so it has to be filterable. */}
              {['pending', 'paid', 'failed', 'refund_pending', 'refunded'].map((value) => (
                <MenuItem key={value} value={value}>
                  {titleCase(value)}
                </MenuItem>
              ))}
              {/* A return's two money steps. Whoever is chasing a refund is asking
                  a payment question, so they ask it in the payment control. */}
              <Divider />
              <ListSubheader sx={{ lineHeight: 2.2, fontSize: 12, fontWeight: 700 }}>
                Return
              </ListSubheader>
              {RETURN_BY_PAYMENT.map((value) => (
                <MenuItem key={value} value={returnValue(value)}>
                  {RETURN_STATUS_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>

            <RangeSelect
              label="Date"
              rangeKey={range.rangeKey}
              custom={range.custom}
              onChange={selectRange}
              width={170}
              dense={false}
            />

            <ResetFiltersButton disabled={!isFiltered} onClick={resetFilters} />
          </Stack>
        }
      />

      <UpdateStatusDialog
        order={updating}
        onClose={() => setUpdating(null)}
        onUpdated={() => {
          setUpdating(null);
          query.refetch();
        }}
      />
    </Box>
  );
}
