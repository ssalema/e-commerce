import { useCallback, useState } from 'react';
import { useSnackbar } from 'notistack';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/DeleteOutline';

import { newsletterApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import useDebounce from '../../hooks/useDebounce';
import { SEARCH_DEBOUNCE_MS } from '../../utils/constants';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { NEWSLETTER_EVENTS } from '../../realtime/events';
import { formatDate } from '../../utils/format';
import DataTable from '../common/DataTable';
import StatusChip from '../common/StatusChip';
import ConfirmDialog from '../common/ConfirmDialog';
import ResetFiltersButton from '../common/ResetFiltersButton';
import RangeSelect from '../dashboard/RangeSelect';
import useRangeQuery from '../dashboard/useRangeQuery';

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const DEFAULT_FILTERS = { search: '', status: 'all', sort: 'newest' };

/** Newsletter sign-ups collected by the storefront footer. */
export default function NewsletterTab() {
  const { enqueueSnackbar } = useSnackbar();

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [deleting, setDeleting] = useState(null);

  const search = useDebounce(filters.search, SEARCH_DEBOUNCE_MS);

  // Month / Year / All time / Custom…, the same window vocabulary the other tabs use.
  const range = useRangeQuery('all');

  const query = useFetch(
    useCallback(
      () =>
        newsletterApi.list({
          page,
          limit,
          search,
          status: filters.status,
          sort: filters.sort,
          ...range.query,
        }),
      [page, limit, search, filters.status, filters.sort, range.queryKey]
    ),
    [page, limit, search, filters.status, filters.sort, range.queryKey]
  );

  useLiveRefetch(query.refetch, NEWSLETTER_EVENTS);

  const subscribers = query.data?.data?.subscribers || [];
  const meta = query.data?.meta;

  const refresh = () => query.refetch();

  const setFilter = (field) => (e) => {
    setFilters((f) => ({ ...f, [field]: e.target.value }));
    setPage(1);
  };

  const isFiltered =
    filters.search !== DEFAULT_FILTERS.search ||
    filters.status !== DEFAULT_FILTERS.status ||
    filters.sort !== DEFAULT_FILTERS.sort ||
    !range.isDefault;

  // Named rather than inlined on the button: the filtered-empty state offers the
  // same reset, so a miss caused by the filters carries its own way out.
  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    range.reset();
    setPage(1);
  };

  /** Narrowing the window can drop the page the reader is on, so start over. */
  const selectRange = (key, custom) => {
    range.select(key, custom);
    setPage(1);
  };

  /** The status chip doubles as the control — there is nowhere else to opt someone out. */
  const toggleStatus = async (row) => {
    const next = row.status === 'subscribed' ? 'unsubscribed' : 'subscribed';
    try {
      const res = await newsletterApi.setStatus(row._id, next);
      enqueueSnackbar(res.message || 'Status updated', { variant: 'success' });
      refresh();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not update the status', { variant: 'error' });
    }
  };

  const remove = async () => {
    try {
      await newsletterApi.remove(deleting._id);
      enqueueSnackbar('Subscriber removed', { variant: 'success' });
      refresh();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not remove the subscriber', { variant: 'error' });
    }
  };

  const columns = [
    {
      key: 'createdAt',
      label: 'Subscription Date',
      minWidth: 140,
      render: (row) => (
        <Typography variant="body2">{formatDate(row.subscribedAt || row.createdAt)}</Typography>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      minWidth: 260,
      render: (row) => (
        <Typography
          component="a"
          href={`mailto:${row.email}`}
          variant="body2"
          sx={{ color: 'primary.main', textDecoration: 'none' }}
        >
          {row.email}
        </Typography>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      align: 'center',
      width: 150,
      render: (row) => {
        const subscribed = row.status === 'subscribed';
        return (
          <Tooltip title={subscribed ? 'Mark as unsubscribed' : 'Mark as subscribed'}>
            {/* The same chip the Users table clicks to move a status — one control,
                one look, wherever a row's state is also the way to change it. */}
            <StatusChip
              status={row.status}
              kind="newsletter"
              onClick={() => toggleStatus(row)}
              sx={{ cursor: 'pointer' }}
            />
          </Tooltip>
        );
      },
    },
    {
      key: 'actions',
      label: 'Action',
      align: 'center',
      width: 100,
      render: (row) => (
        <Tooltip title="Remove from the list">
          <IconButton size="small" color="error" onClick={() => setDeleting(row)}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ),
    },
  ];

  const toolbar = (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      alignItems={{ xs: 'stretch', md: 'center' }}
      spacing={1.5}
      sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}
    >
      <TextField
        placeholder="Search by email…"
        value={filters.search}
        onChange={setFilter('search')}
        sx={{ flex: 1, minWidth: 220 }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      <RangeSelect
        label="Date"
        rangeKey={range.rangeKey}
        custom={range.custom}
        onChange={selectRange}
        width={170}
        dense={false}
      />

      <TextField
        select
        label="Status"
        value={filters.status}
        onChange={setFilter('status')}
        sx={{ minWidth: 150 }}
      >
        <MenuItem value="all">All statuses</MenuItem>
        <MenuItem value="subscribed">Subscribed</MenuItem>
        <MenuItem value="unsubscribed">Unsubscribed</MenuItem>
      </TextField>

      <TextField
        select
        label="Sort by"
        value={filters.sort}
        onChange={setFilter('sort')}
        sx={{ minWidth: 160 }}
      >
        {SORTS.map((sort) => (
          <MenuItem key={sort.value} value={sort.value}>
            {sort.label}
          </MenuItem>
        ))}
      </TextField>

      <ResetFiltersButton disabled={!isFiltered} onClick={resetFilters} />
    </Stack>
  );

  return (
    <>
      <DataTable
        columns={columns}
        rows={subscribers}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        errorTitle="Could not load the subscribers"
        page={page}
        limit={limit}
        total={meta?.total || 0}
        onPageChange={setPage}
        onLimitChange={(value) => {
          setLimit(value);
          setPage(1);
        }}
        toolbar={toolbar}
        emptyTitle={isFiltered ? 'No subscribers match these filters' : 'No subscribers yet'}
        emptyMessage={
          isFiltered
            ? 'Try a different search term, or widen the date or status filter.'
            : 'Sign-ups from the storefront footer land here.'
        }
        emptyAction={isFiltered ? { label: 'Reset filters', onClick: resetFilters } : undefined}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Remove this subscriber?"
        message={`${deleting?.email || 'This address'} will be deleted from the newsletter list. To stop emails without losing the record, mark them unsubscribed instead.`}
        confirmLabel="Remove"
      />
    </>
  );
}
