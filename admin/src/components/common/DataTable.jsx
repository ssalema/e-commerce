import { useState } from 'react';
import Card from '@mui/material/Card';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Skeleton from '@mui/material/Skeleton';
import Box from '@mui/material/Box';
import EmptyState from './EmptyState';
import ErrorState from './ErrorState';
import Pagination from './Pagination';

/**
 * Reusable server-paginated table.
 *
 * @param {Array<{key:string, label:string, width?:number|string, align?:string,
 *                render?:(row:any)=>React.ReactNode}>} columns
 * @param {'top'|'middle'} verticalAlign  When cells stack two lines of text, centring
 *   every cell against the tallest one reads as ragged; `top` puts the first line of
 *   every column on the same baseline instead.
 * @param {Error} [error]  A failed fetch. Without this a list that could not load
 *   falls through to the empty state and tells the reader their catalogue is empty
 *   when it is only unreachable — so the error takes precedence over both the rows
 *   and the empty state, and carries the retry.
 * @param {() => void} [onRetry]
 *
 * Selection (opt in with `selectable`) is deliberately page-scoped: the ticks stand
 * for rows the reader can see, so a bulk action can never reach further than the
 * page in front of them. The owner keeps `selectedIds` and clears it whenever the
 * rows underneath change.
 * @param {boolean} [selectable]
 * @param {string[]} [selectedIds]
 * @param {(ids: string[]) => void} [onSelectionChange]
 * @param {Array<{value:string, label:string, match?:(row:any)=>boolean, divider?:boolean}>}
 *   [selectPresets]  Options for the header checkbox's dropdown — "Unread", "Starred"
 *   and so on. An option without `match` selects the whole page.
 * @param {React.ReactNode} [bulkActions]  Buttons for the bar shown while rows are ticked.
 */
export default function DataTable({
  columns,
  rows = [],
  loading = false,
  error = null,
  onRetry,
  page = 1,
  limit = 10,
  total = 0,
  onPageChange,
  onLimitChange,
  emptyTitle = 'No records found',
  emptyMessage,
  emptyAction,
  errorTitle = 'Could not load this list',
  getRowId = (row) => row._id,
  onRowClick,
  toolbar,
  verticalAlign = 'middle',
  selectable = false,
  selectedIds = [],
  onSelectionChange,
  selectPresets,
  bulkActions,
}) {
  const showError = !loading && Boolean(error);
  const showEmpty = !loading && !error && rows.length === 0;
  // Stale rows from the previous successful fetch would sit under the error panel
  // claiming to be the current list, so a failed load shows nothing but the error.
  const visibleRows = showError ? [] : rows;

  const [presetAnchor, setPresetAnchor] = useState(null);

  const selected = new Set(selectedIds);
  const pageIds = visibleRows.map(getRowId);
  // Ids ticked on an earlier page are not this page's business — the count in the
  // bar and the header checkbox both speak only about what is on screen.
  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  const allSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;

  const toggleRow = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectionChange?.([...next]);
  };

  const applyPreset = (preset) => {
    setPresetAnchor(null);
    onSelectionChange?.(
      preset.match ? visibleRows.filter(preset.match).map(getRowId) : [...pageIds]
    );
  };

  return (
    <Card>
      {toolbar}

      {selectable && selectedOnPage.length > 0 && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          justifyContent="space-between"
          spacing={1.5}
          sx={{
            px: 2,
            py: 1.25,
            borderBottom: 1,
            borderColor: 'divider',
            // The panel's quiet surface, the same one the dialogs quote a message on:
            // enough to lift the bar off the white toolbar above it without becoming
            // a second coloured band competing with the buttons it carries.
            bgcolor: 'action.hover',
          }}
        >
          <Typography variant="body2" fontWeight={600}>
            {selectedOnPage.length} selected
          </Typography>
          {/* `useFlexGap` so a narrow viewport that wraps the buttons keeps the gap
              between the two rows, which margin-based spacing would drop. */}
          <Stack direction="row" spacing={1} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
            {bulkActions}
          </Stack>
        </Stack>
      )}

      <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
        <Table stickyHeader size="medium">
          <TableHead>
            <TableRow>
              {selectable && (
                <TableCell padding="checkbox" sx={{ whiteSpace: 'nowrap' }}>
                  <Stack direction="row" alignItems="center" sx={{ ml: 0.5 }}>
                    <Checkbox
                      size="small"
                      sx={{ p: 0.5 }}
                      disabled={pageIds.length === 0}
                      checked={allSelected}
                      indeterminate={selectedOnPage.length > 0 && !allSelected}
                      onChange={() => onSelectionChange?.(allSelected ? [] : [...pageIds])}
                      inputProps={{ 'aria-label': 'Select all rows on this page' }}
                    />
                    {selectPresets?.length > 0 && (
                      <IconButton
                        size="small"
                        aria-label="Select rows by status"
                        disabled={pageIds.length === 0}
                        onClick={(e) => setPresetAnchor(e.currentTarget)}
                        sx={{ p: 0, color: 'text.secondary' }}
                      >
                        <ArrowDropDownIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Stack>
                </TableCell>
              )}

              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  align={column.align || 'left'}
                  sx={{
                    width: column.width,
                    minWidth: column.minWidth,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {column.label}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>

          <TableBody>
            {loading &&
              Array.from({ length: Math.min(limit, 8) }).map((_, rowIndex) => (
                <TableRow key={`skeleton-${rowIndex}`}>
                  {selectable && (
                    <TableCell padding="checkbox">
                      <Skeleton variant="text" height={26} />
                    </TableCell>
                  )}
                  {columns.map((column) => (
                    <TableCell key={column.key}>
                      <Skeleton variant="text" height={26} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}

            {!loading &&
              visibleRows.map((row) => (
                <TableRow
                  key={getRowId(row)}
                  hover
                  selected={selectable && selected.has(getRowId(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  sx={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {selectable && (
                    // Ticking a row must not also open it where the whole row is a link.
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="small"
                        sx={{ p: 0.5, ml: 0.5 }}
                        checked={selected.has(getRowId(row))}
                        onChange={() => toggleRow(getRowId(row))}
                        inputProps={{ 'aria-label': 'Select this row' }}
                      />
                    </TableCell>
                  )}
                  {columns.map((column) => (
                    <TableCell
                      key={column.key}
                      align={column.align || 'left'}
                      sx={{
                        width: column.width,
                        minWidth: column.minWidth,
                        verticalAlign,
                      }}
                    >
                      {column.render ? column.render(row) : (row[column.key] ?? '—')}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>

      {selectable && selectPresets?.length > 0 && (
        <Menu
          anchorEl={presetAnchor}
          open={Boolean(presetAnchor)}
          onClose={() => setPresetAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          slotProps={{ paper: { sx: { width: 160, mt: 1 } } }}
        >
          {selectPresets.map((preset) => [
            <MenuItem key={preset.value} onClick={() => applyPreset(preset)}>
              {preset.label}
            </MenuItem>,
            // "All" sits apart from the narrowing options below it.
            preset.divider ? <Divider key={`${preset.value}-divider`} /> : null,
          ])}
        </Menu>
      )}

      {showError && (
        <ErrorState title={errorTitle} message={error.message} onRetry={onRetry} />
      )}

      {showEmpty && (
        <EmptyState
          title={emptyTitle}
          message={emptyMessage}
          actionLabel={emptyAction?.label}
          onAction={emptyAction?.onClick}
        />
      )}

      {!showEmpty && !showError && onPageChange && (
        <Box sx={{ borderTop: 1, borderColor: 'divider' }}>
          <Pagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={onPageChange}
            onLimitChange={onLimitChange}
          />
        </Box>
      )}
    </Card>
  );
}
