import { useCallback, useMemo, useState } from 'react';
import { useSnackbar } from 'notistack';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SearchIcon from '@mui/icons-material/Search';
import VisibilityIcon from '@mui/icons-material/VisibilityOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import EventIcon from '@mui/icons-material/EventAvailableOutlined';

import { careerApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import useDebounce from '../../hooks/useDebounce';
import { SEARCH_DEBOUNCE_MS } from '../../utils/constants';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { CAREER_EVENTS } from '../../realtime/events';
import { formatDate } from '../../utils/format';
import DataTable from '../common/DataTable';
import NewBadge from '../common/NewBadge';
import StatusChip from '../common/StatusChip';
import ConfirmDialog from '../common/ConfirmDialog';
import ResetFiltersButton from '../common/ResetFiltersButton';
import RangeSelect from '../dashboard/RangeSelect';
import useRangeQuery from '../dashboard/useRangeQuery';
import ApplicantProfileDialog from './ApplicantProfileDialog';
import CareerSetupDialog from './CareerSetupDialog';
import InterviewScheduleDialog from './InterviewScheduleDialog';
import useResume from './useResume';

const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'shortlisted', label: 'Shortlisted' },
  { value: 'interviewed', label: 'Interviewed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'hired', label: 'Hired' },
];

const STATUS_LABEL = Object.fromEntries(STATUSES.map((status) => [status.value, status.label]));

/**
 * Review only moves forward, and `rejected` / `hired` close the record — the same
 * rule the server enforces on the status route, so the dropdown never offers a
 * move the save would refuse.
 */
const STAGES = ['new', 'shortlisted', 'interviewed'];
const FINAL_STATUSES = ['rejected', 'hired'];

const canChangeStatus = (from, to) => {
  if (from === to) return true;
  if (FINAL_STATUSES.includes(from)) return false;
  if (FINAL_STATUSES.includes(to)) return true;
  return STAGES.indexOf(to) > STAGES.indexOf(from);
};

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const DEFAULT_FILTERS = {
  search: '',
  status: 'all',
  position: 'all',
  experience: 'all',
  sort: 'newest',
};

/**
 * Applications received through the storefront careers form.
 *
 * The positions / HR-contact editor is opened from the page header rather than from
 * this toolbar — every other screen in the panel keeps its page-level action there —
 * so the flag lives with the header and is handed down.
 */
export default function CareerApplicationsTab({ onCountsChanged, setupOpen, onSetupOpenChange }) {
  const { enqueueSnackbar } = useSnackbar();

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);

  const [viewing, setViewing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [scheduling, setScheduling] = useState(null);
  const resume = useResume();

  // Positions and experience labels come from the same config the storefront reads,
  // so the filter dropdowns can never drift from the form that produced the rows.
  const configQuery = useFetch(useCallback(() => careerApi.config(), []), []);
  // The admin list, not the public config: a level that has been switched off still
  // has to label and filter the applications that were sent while it was on offer.
  const levelsQuery = useFetch(useCallback(() => careerApi.experienceLevels(), []), []);
  const positionsQuery = useFetch(useCallback(() => careerApi.positions(), []), []);

  // Typing shouldn't fire a request per keystroke; the dropdowns can go straight through.
  const search = useDebounce(filters.search, SEARCH_DEBOUNCE_MS);

  // Month / Year / All time / Custom…, the same window vocabulary the other tabs use.
  const range = useRangeQuery('all');

  const query = useFetch(
    useCallback(
      () =>
        careerApi.applications({
          page,
          limit,
          search,
          status: filters.status,
          position: filters.position,
          experience: filters.experience,
          sort: filters.sort,
          ...range.query,
        }),
      [
        page,
        limit,
        search,
        filters.status,
        filters.position,
        filters.experience,
        filters.sort,
        range.queryKey,
      ]
    ),
    [
      page,
      limit,
      search,
      filters.status,
      filters.position,
      filters.experience,
      filters.sort,
      range.queryKey,
    ]
  );

  useLiveRefetch(() => {
    query.refetch();
    positionsQuery.refetch();
    levelsQuery.refetch();
    configQuery.refetch();
  }, CAREER_EVENTS);

  const applications = query.data?.data?.applications || [];
  const meta = query.data?.meta;
  const positions = positionsQuery.data?.data?.positions || [];
  const experienceLevels = levelsQuery.data?.data?.experienceLevels || [];
  const hr = configQuery.data?.data?.hr || {};

  const experienceLabel = useMemo(
    () => Object.fromEntries(experienceLevels.map((level) => [level.value, level.label])),
    [experienceLevels]
  );

  const refresh = () => {
    query.refetch();
    onCountsChanged?.();
  };

  const setFilter = (field) => (e) => {
    setFilters((f) => ({ ...f, [field]: e.target.value }));
    setPage(1);
  };

  const open = async (row) => {
    setViewing(row);
    if (row.isRead) return;
    try {
      const res = await careerApi.application(row._id);
      setViewing(res.data.application);
      refresh();
    } catch {
      /* the row already carries everything the dialog renders */
    }
  };

  /**
   * "Interviewed" is the status that calls a candidate in, so it cannot be set
   * from the dropdown alone — it opens the scheduling dialog, and the status is
   * saved with the appointment when that is submitted. Picking it and closing
   * the dialog leaves the row untouched.
   */
  const changeStatus = (row, status) => {
    if (status === 'interviewed') return setScheduling(row);
    // The dropdown has nothing to do with a rejected save beyond the toast, so
    // the throw stops here.
    saveStatus(row, { status }).catch(() => {});
  };

  /** Rethrows, so a caller that owns a dialog can keep it open on failure. */
  const saveStatus = async (row, payload) => {
    try {
      const res = await careerApi.setApplicationStatus(row._id, payload);
      const label = STATUS_LABEL[payload.status] || payload.status;
      // Every status but "New" emails the applicant, so the toast says so —
      // an admin picking from a dropdown has no other cue that a decision has
      // just left the building.
      enqueueSnackbar(
        payload.interview
          ? // The server says it better here: the admin has just sent an
            // appointment, not moved a row to a new label.
            res?.message || 'Interview scheduled — the invitation has been emailed'
          : res?.data?.notified
          ? `Marked as ${label} — applicant notified by email`
          : `Marked as ${label}`,
        { variant: 'success' }
      );
      refresh();
      return res;
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not update the status', { variant: 'error' });
      throw err;
    }
  };

  /** The scheduling dialog's submit: the appointment and the status, in one save. */
  const scheduleInterview = async (interview) => {
    await saveStatus(scheduling, { status: 'interviewed', interview });
    setScheduling(null);
  };

  const remove = async () => {
    try {
      await careerApi.removeApplication(deleting._id);
      enqueueSnackbar('Application deleted', { variant: 'success' });
      refresh();
    } catch (err) {
      enqueueSnackbar(err.message || 'Could not delete the application', { variant: 'error' });
    }
  };

  /** Narrowing the window can drop the page the reader is on, so start over. */
  const selectRange = (key, custom) => {
    range.select(key, custom);
    setPage(1);
  };

  const isFiltered =
    filters.search !== DEFAULT_FILTERS.search ||
    filters.status !== 'all' ||
    filters.position !== 'all' ||
    filters.experience !== 'all' ||
    filters.sort !== DEFAULT_FILTERS.sort ||
    !range.isDefault;

  const columns = [
    {
      key: 'createdAt',
      label: 'Application Date',
      minWidth: 130,
      render: (row) => <Typography variant="body2">{formatDate(row.createdAt)}</Typography>,
    },
    {
      key: 'name',
      label: 'Applicant Name',
      minWidth: 150,
      render: (row) => (
        <Stack direction="row" alignItems="center" spacing={1}>
          {/* Same weights the Contact Us inbox uses, so an unread row reads the
              same way on either tab. */}
          <Typography variant="body2" fontWeight={row.isRead ? 500 : 800}>
            {row.name}
          </Typography>
          {/* Cleared by opening the profile or by moving the application's status
              along — either one means it has been looked at. */}
          {!row.isRead && <NewBadge />}
        </Stack>
      ),
    },
    {
      key: 'position',
      label: 'Position',
      minWidth: 140,
      render: (row) => <Typography variant="body2">{row.position}</Typography>,
    },
    {
      key: 'experience',
      label: 'Experience',
      minWidth: 130,
      render: (row) => (
        <Typography variant="body2" color="primary.main">
          {experienceLabel[row.experience] || row.experience}
        </Typography>
      ),
    },
    {
      key: 'location',
      label: 'Location',
      minWidth: 110,
      render: (row) => <Typography variant="body2">{row.location || '—'}</Typography>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 150,
      render: (row) => {
        const closed = FINAL_STATUSES.includes(row.status);

        // A closed record has nothing left to choose, so it stops being a control:
        // it reads as the panel's status chip, coloured like every other status in
        // the admin, with the tooltip saying why it can no longer move.
        if (closed) {
          return (
            <Tooltip
              title={`Marked ${STATUS_LABEL[row.status] || row.status} — this decision has been emailed and can no longer be changed`}
            >
              <span>
                <StatusChip status={row.status} kind="career" />
              </span>
            </Tooltip>
          );
        }

        // Still open: every stage stays listed so the pipeline reads the same on
        // every row, with the moves this record can no longer make greyed out.
        return (
          <Select
            value={row.status}
            onChange={(e) => changeStatus(row, e.target.value)}
            sx={{ minWidth: 130, fontSize: 13 }}
          >
            {STATUSES.map((status) => (
              <MenuItem
                key={status.value}
                value={status.value}
                disabled={!canChangeStatus(row.status, status.value)}
                sx={{ fontSize: 13 }}
              >
                {status.label}
              </MenuItem>
            ))}
          </Select>
        );
      },
    },
    {
      key: 'actions',
      label: 'Action',
      align: 'center',
      // Room for the third button an interviewed row carries.
      width: 130,
      render: (row) => (
        <Stack direction="row" spacing={0.25} justifyContent="center">
          <Tooltip title="View applicant profile">
            <IconButton size="small" color="primary" onClick={() => open(row)}>
              <VisibilityIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          {/* Re-picking "Interviewed" on a row already at it fires no change
              event, so rescheduling needs its own way in. */}
          {row.status === 'interviewed' && (
            <Tooltip title="Reschedule interview">
              <IconButton size="small" color="secondary" onClick={() => setScheduling(row)}>
                <EventIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Delete application">
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
      useFlexGap
      flexWrap="wrap"
      sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}
    >
      <TextField
        placeholder="Search by name, email or phone…"
        value={filters.search}
        onChange={setFilter('search')}
        sx={{ flex: 1, minWidth: 260 }}
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
        {STATUSES.map((status) => (
          <MenuItem key={status.value} value={status.value}>
            {status.label}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        label="Position"
        value={filters.position}
        onChange={setFilter('position')}
        sx={{ minWidth: 190 }}
      >
        <MenuItem value="all">All positions</MenuItem>
        {positions.map((position) => (
          <MenuItem key={position._id} value={position.title}>
            {position.title}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        label="Experience"
        value={filters.experience}
        onChange={setFilter('experience')}
        sx={{ minWidth: 170 }}
      >
        <MenuItem value="all">All experience</MenuItem>
        {experienceLevels.map((level) => (
          <MenuItem key={level.value} value={level.value}>
            {level.label}
          </MenuItem>
        ))}
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

      <ResetFiltersButton
        disabled={!isFiltered}
        onClick={() => {
          setFilters(DEFAULT_FILTERS);
          range.reset();
          setPage(1);
        }}
      />
    </Stack>
  );

  return (
    <>
      <DataTable
        columns={columns}
        rows={applications}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        errorTitle="Could not load the applications"
        page={page}
        limit={limit}
        total={meta?.total || 0}
        onPageChange={setPage}
        onLimitChange={(value) => {
          setLimit(value);
          setPage(1);
        }}
        toolbar={toolbar}
        emptyTitle={isFiltered ? 'No applications match these filters' : 'No applications yet'}
        emptyMessage={
          isFiltered
            ? 'Try widening the date, status, position or experience filter.'
            : 'Applications submitted through the storefront careers form land here.'
        }
        emptyAction={
          isFiltered ? undefined : { label: 'Manage positions', onClick: () => onSetupOpenChange(true) }
        }
      />

      <ApplicantProfileDialog
        application={viewing}
        experienceLabel={viewing ? experienceLabel[viewing.experience] || viewing.experience : ''}
        resume={resume}
        onClose={() => setViewing(null)}
      />

      {scheduling && (
        <InterviewScheduleDialog
          application={scheduling}
          onClose={() => setScheduling(null)}
          onSubmit={scheduleInterview}
        />
      )}

      {setupOpen && (
        <CareerSetupDialog
          positions={positions}
          experienceLevels={experienceLevels}
          hr={hr}
          onClose={() => onSetupOpenChange(false)}
          onChanged={() => {
            positionsQuery.refetch();
            levelsQuery.refetch();
            configQuery.refetch();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Delete this application?"
        message={`${deleting?.name || 'This applicant'}'s application and resume will be removed permanently.`}
        confirmLabel="Delete"
      />
    </>
  );
}
