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
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';

import { inquiryApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import useDebounce from '../../hooks/useDebounce';
import { SEARCH_DEBOUNCE_MS } from '../../utils/constants';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { INQUIRY_EVENTS } from '../../realtime/events';
import { formatDateTime } from '../../utils/format';
import DataTable from '../common/DataTable';
import NewBadge from '../common/NewBadge';
import ConfirmDialog from '../common/ConfirmDialog';
import ResetFiltersButton from '../common/ResetFiltersButton';
import RangeSelect from '../dashboard/RangeSelect';
import useRangeQuery from '../dashboard/useRangeQuery';
import InquiryDetailDialog from './InquiryDetailDialog';
import ReplyDialog from './ReplyDialog';

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const DEFAULT_FILTERS = { search: '', status: 'all', sort: 'newest' };

/**
 * The contact-form inbox: search / date / sort, plus view and delete. Replying is
 * reached by opening a message — the reader sees what they are answering first.
 */
export default function ContactMessagesTab({ onCountsChanged }) {
  const { enqueueSnackbar } = useSnackbar();

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [viewing, setViewing] = useState(null);
  const [replying, setReplying] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // Typing in the search box shouldn't fire a request per keystroke.
  const search = useDebounce(filters.search, SEARCH_DEBOUNCE_MS);

  // Month / Year / All time / Custom…, the same window vocabulary the dashboard uses.
  const range = useRangeQuery('all');

  const query = useFetch(
    useCallback(
      () =>
        inquiryApi.list({
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

  useLiveRefetch(query.refetch, INQUIRY_EVENTS);

  const inquiries = query.data?.data?.inquiries || [];
  const meta = query.data?.meta;

  const refresh = () => {
    query.refetch();
    onCountsChanged?.();
  };

  const setFilter = (field) => (e) => {
    setFilters((f) => ({ ...f, [field]: e.target.value }));
    setPage(1);
  };

  /** Narrowing the window can drop the page the reader is on, so start over. */
  const selectRange = (key, custom) => {
    range.select(key, custom);
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

  /** Opening the detail dialog marks the message read server-side. */
  const open = async (row) => {
    setViewing(row);
    if (row.isRead) return;
    try {
      const res = await inquiryApi.detail(row._id);
      setViewing(res.data.inquiry);
      refresh();
    } catch {
      /* the dialog already has everything it needs from the row */
    }
  };

  const remove = async () => {
    try {
      await inquiryApi.remove(deleting._id);
      enqueueSnackbar('Message deleted', { variant: 'success' });
      refresh();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not delete the message', { variant: 'error' });
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Name',
      minWidth: 160,
      render: (row) => (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="body2" fontWeight={row.isRead ? 500 : 800}>
            {row.name}
          </Typography>
          {/* Unread rows carry the badge here rather than in a whole extra column.
              It stays until this message is opened — nothing else clears it. */}
          {!row.isRead && <NewBadge />}
        </Stack>
      ),
    },
    {
      key: 'email',
      label: 'Email',
      minWidth: 200,
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
      key: 'createdAt',
      label: 'Date & Time',
      minWidth: 180,
      render: (row) => <Typography variant="body2">{formatDateTime(row.createdAt)}</Typography>,
    },
    {
      key: 'actions',
      label: 'Action',
      align: 'center',
      width: 110,
      render: (row) => (
        <Stack direction="row" spacing={0.25} justifyContent="center">
          <Tooltip title="View message">
            <IconButton size="small" color="primary" onClick={() => open(row)}>
              <VisibilityIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete">
            <IconButton size="small" color="error" onClick={() => setDeleting(row)}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
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
        placeholder="Search by name, email or message…"
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

      {/* The inbox's own question — what still needs answering — and one the list
          endpoint already understood before anything here offered to ask it. */}
      <TextField
        select
        label="Status"
        value={filters.status}
        onChange={setFilter('status')}
        sx={{ minWidth: 150 }}
      >
        <MenuItem value="all">All messages</MenuItem>
        <MenuItem value="unread">Unread</MenuItem>
        <MenuItem value="read">Read</MenuItem>
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
        rows={inquiries}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        errorTitle="Could not load the messages"
        page={page}
        limit={limit}
        total={meta?.total || 0}
        onPageChange={setPage}
        onLimitChange={(value) => {
          setLimit(value);
          setPage(1);
        }}
        toolbar={toolbar}
        emptyTitle={isFiltered ? 'No messages match these filters' : 'No messages yet'}
        emptyMessage={
          isFiltered
            ? 'Try a different search term or widen the date range.'
            : 'Enquiries submitted through the storefront contact form land here.'
        }
        emptyAction={isFiltered ? { label: 'Reset filters', onClick: resetFilters } : undefined}
      />

      <InquiryDetailDialog
        inquiry={viewing}
        onClose={() => setViewing(null)}
        onReply={(inquiry) => {
          setViewing(null);
          setReplying(inquiry);
        }}
      />

      {replying && (
        <ReplyDialog
          inquiry={replying}
          onClose={() => setReplying(null)}
          onSent={() => {
            setReplying(null);
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Delete this message?"
        message={`The inquiry from ${deleting?.name || 'this visitor'} will be removed permanently.`}
        confirmLabel="Delete"
      />
    </>
  );
}
