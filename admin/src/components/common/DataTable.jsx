import Card from '@mui/material/Card';
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
}) {
  const showError = !loading && Boolean(error);
  const showEmpty = !loading && !error && rows.length === 0;
  // Stale rows from the previous successful fetch would sit under the error panel
  // claiming to be the current list, so a failed load shows nothing but the error.
  const visibleRows = showError ? [] : rows;

  return (
    <Card>
      {toolbar}

      <TableContainer sx={{ maxWidth: '100%', overflowX: 'auto' }}>
        <Table stickyHeader size="medium">
          <TableHead>
            <TableRow>
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
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  sx={onRowClick ? { cursor: 'pointer' } : undefined}
                >
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
