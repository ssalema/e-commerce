import Icon from '../common/Icon';
import { formatDateTime } from '../../utils/format';

/**
 * The one ladder both of an order's journeys are drawn as.
 *
 * The order's fulfilment and the return over the same parcel used to be drawn as
 * two different pictures — a vertical trail for one, a four-across tracker for
 * the other — which meant a shopper had to re-learn how to read progress the
 * moment they raised a return. They are the same question ("where has this got
 * to") and they now get the same answer shape: a bead per step, a rail that
 * carries the colour of the step it runs *into*, the stamp underneath, and a
 * red closing row where the journey stopped instead of finishing.
 *
 * A row is:
 *   { key, label, done, active, closing, at, note, panel: { title, text } }
 *
 * `label` is already translated by the caller — the two journeys name their
 * steps from different corners of the dictionary, and resolving that here would
 * only move the branch.
 */
export default function Timeline({ rows }) {
  return (
    <ol className="relative">
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        const closing = Boolean(row.closing);
        const next = rows[index + 1];

        return (
          <li key={row.key} className="relative flex gap-4 pb-6 last:pb-0">
            {!last && (
              <span
                aria-hidden="true"
                className={`absolute left-[13px] top-7 h-full w-0.5 ${
                  // The segment takes the colour of the step it runs *into*, so the
                  // line arriving at a cancellation is red.
                  next.closing ? 'bg-danger' : next.done ? 'bg-success' : 'bg-ink-200'
                }`}
              />
            )}

            <span
              className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full ring-4 ring-white ${
                closing
                  ? 'bg-danger text-white'
                  : row.done
                    ? 'bg-success text-white'
                    : 'bg-ink-200 text-ink-400'
              } ${row.active ? 'animate-pulse' : ''}`}
            >
              {closing ? (
                <Icon name="close" size={13} />
              ) : row.done ? (
                <Icon name="check" size={13} />
              ) : (
                <span className="h-2 w-2 rounded-full bg-current" />
              )}
            </span>

            <div className="min-w-0 flex-1 pt-0.5">
              <p
                className={`text-sm font-semibold ${
                  closing ? 'text-red-800' : row.done ? 'text-ink-900' : 'text-ink-400'
                }`}
              >
                {row.label}
              </p>
              {row.at && (
                <p className={`text-xs ${closing ? 'text-red-700' : 'text-ink-500'}`}>
                  {formatDateTime(row.at)}
                </p>
              )}

              {row.panel ? (
                <div className="mt-2 rounded-lg bg-red-50 p-3 text-xs">
                  <p className="font-semibold text-red-800">{row.panel.title}</p>
                  <p className="mt-0.5 text-red-700">{row.panel.text}</p>
                </div>
              ) : (
                row.note && <p className="mt-0.5 text-xs text-ink-500">{row.note}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
