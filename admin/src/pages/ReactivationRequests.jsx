import { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid2';
import Stack from '@mui/material/Stack';
import Avatar from '@mui/material/Avatar';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';

import SearchIcon from '@mui/icons-material/Search';
import PendingIcon from '@mui/icons-material/PendingActionsOutlined';
import ApprovedIcon from '@mui/icons-material/HowToRegOutlined';
import RejectedIcon from '@mui/icons-material/PersonOffOutlined';
import ReviewIcon from '@mui/icons-material/FactCheckOutlined';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';

import { userApi } from '../api/endpoints';
import useFetch from '../hooks/useFetch';
import useDebounce from '../hooks/useDebounce';
import { SEARCH_DEBOUNCE_MS } from '../utils/constants';
import { useLiveRefetch } from '../realtime/useRealtime';
import { EVENTS } from '../realtime/events';
import { formatDateTime, formatNumber, formatPhone } from '../utils/format';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import DataTable from '../components/common/DataTable';
import StatusChip from '../components/common/StatusChip';
import ResetFiltersButton from '../components/common/ResetFiltersButton';
import ReactivationRequestDialog from '../components/users/ReactivationRequestDialog';


/**
 * The queue where a closed account comes back — or does not.
 *
 * Every row here has already proven three things: it opened a single-use link
 * sent to the registered address, it answered a one-time code sent to that same
 * address, and it re-typed the name and mobile number the account actually holds.
 * None of that is a decision, which is why this screen exists: what is left is
 * whether we want the customer back, and only a person can answer it.
 *
 * The list opens on every request, newest first, so the screen answers "what has
 * happened here" without a filter hiding most of it. The pending rows still have
 * the only clock on them — the customer has been told 2-3 working days — which is
 * what the Awaiting Review tile above is for, and the Status filter narrows to
 * them in one click.
 */
export default function ReactivationRequests() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [openId, setOpenId] = useState(null);

  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);

  const query = useFetch(
    useCallback(
      () =>
        userApi.reactivationRequests({
          page,
          limit,
          status,
          search: debouncedSearch || undefined,
        }),
      [page, limit, status, debouncedSearch]
    ),
    [page, limit, status, debouncedSearch]
  );

  // A request submitted while this screen is open should appear on it.
  useLiveRefetch(query.refetch, EVENTS.REACTIVATION_REQUEST_CHANGED);

  const requests = query.data?.data?.requests || [];
  const stats = query.data?.data?.stats || {};
  const meta = query.data?.meta;

  const isFiltered = Boolean(search) || status !== 'all';

  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setPage(1);
  };

  const columns = [
    {
      key: 'name',
      label: 'User Name',
      minWidth: 220,
      render: (row) => (
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar
            src={row.user?.avatar?.url}
            slotProps={{ img: { referrerPolicy: 'no-referrer' } }}
            sx={{ width: 38, height: 38, bgcolor: 'primary.main', fontSize: 15 }}
          >
            {row.name?.charAt(0).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600} noWrap>
              {row.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {row.email}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    {
      key: 'phone',
      label: 'Mobile Number',
      minWidth: 130,
      render: (row) => (
        <Typography variant="body2" color={row.phone ? 'text.primary' : 'text.disabled'}>
          {row.phone ? formatPhone(row.phone) : 'Not provided'}
        </Typography>
      ),
    },
    {
      key: 'deactivatedAt',
      label: 'Deactivated',
      minWidth: 180,
      render: (row) => (
        <Box>
          <Typography variant="body2">{formatDateTime(row.deactivatedAt)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.deactivationReason || 'No reason recorded'}
          </Typography>
        </Box>
      ),
    },
    {
      key: 'requestedAt',
      label: 'Requested',
      minWidth: 150,
      render: (row) => <Typography variant="body2">{formatDateTime(row.requestedAt)}</Typography>,
    },
    {
      key: 'verification',
      label: 'Verified',
      align: 'center',
      minWidth: 130,
      render: (row) => (
        <Chip
          label={row.verification?.emailOtpVerifiedAt ? 'Email OTP + details' : 'Incomplete'}
          size="small"
          color={row.verification?.emailOtpVerifiedAt ? 'success' : 'default'}
          variant="outlined"
        />
      ),
    },
    {
      key: 'status',
      label: 'Request',
      align: 'center',
      minWidth: 110,
      render: (row) => <StatusChip status={row.status} kind="reactivation" />,
    },
    {
      key: 'actions',
      label: 'Action',
      align: 'center',
      width: 120,
      render: (row) => {
        const pending = row.status === 'pending';
        return (
          <Stack direction="row" spacing={0.25} justifyContent="center">
            <Tooltip title={pending ? 'Review request form' : 'View request form'}>
              <IconButton size="small" color="primary" onClick={() => setOpenId(row._id)}>
                {pending ? <ReviewIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        );
      },
    },
  ];

  return (
    <Box>
      <PageHeader
        title="Account Reactivation Requests"
        subtitle="Customers who deactivate their account and have verified their identity to come back"
        breadcrumbs={[{ label: 'Users', to: '/users' }, { label: 'Reactivation Requests' }]}
      />

      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            title="Awaiting Review"
            value={formatNumber(stats.pending)}
            icon={<PendingIcon />}
            color="warning"
            caption="Promised within 2-3 working days"
            loading={query.loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            title="Approved"
            value={formatNumber(stats.approved)}
            icon={<ApprovedIcon />}
            color="success"
            caption="Accounts returned to active"
            loading={query.loading}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <StatCard
            title="Rejected"
            value={formatNumber(stats.rejected)}
            icon={<RejectedIcon />}
            color="error"
            caption="Still deactivated"
            loading={query.loading}
          />
        </Grid>
      </Grid>

      <DataTable
        columns={columns}
        rows={requests}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        errorTitle="Could not load the reactivation requests"
        page={page}
        limit={limit}
        total={meta?.total || 0}
        onPageChange={setPage}
        onLimitChange={(value) => {
          setLimit(value);
          setPage(1);
        }}
        onRowClick={(row) => setOpenId(row._id)}
        verticalAlign="top"
        emptyTitle={isFiltered ? 'No requests match these filters' : 'No reactivation requests'}
        emptyMessage={
          isFiltered
            ? 'Try a different search term, or widen the status filter.'
            : 'Requests appear here once a customer verifies their identity from the link we email them.'
        }
        emptyAction={isFiltered ? { label: 'Reset filters', onClick: resetFilters } : undefined}
        toolbar={
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            spacing={1.5}
            sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            <TextField
              placeholder="Search by name, email or phone…"
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
              label="Status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              sx={{ minWidth: 160 }}
            >
              {/* The default leads, as on every other filter in the panel. */}
              <MenuItem value="all">All requests</MenuItem>
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="approved">Approved</MenuItem>
              <MenuItem value="rejected">Rejected</MenuItem>
            </TextField>

            <ResetFiltersButton disabled={!isFiltered} onClick={resetFilters} />
          </Stack>
        }
      />

      {openId && (
        <ReactivationRequestDialog
          requestId={openId}
          onClose={() => setOpenId(null)}
          onDecided={() => {
            setOpenId(null);
            query.refetch();
          }}
        />
      )}
    </Box>
  );
}
