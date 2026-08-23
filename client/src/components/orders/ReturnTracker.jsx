import { useTranslation } from 'react-i18next';

import Icon from '../common/Icon';
import { formatDateTime, formatPrice } from '../../utils/format';
import { RETURN_STATUS_STEPS } from '../../utils/constants';

/**
 * The three lines of small print in the reference design's "Please Note" card.
 *
 * They are here rather than in the caller because all three are statements about
 * how *this* store handles a pickup, and they belong beside the tracker that
 * raises the expectation. The icons carry the same meaning as the copy: what to
 * do (keep it ready), what we will do (check it), and when the money moves.
 */
const NOTES = [
  { key: 'ready', icon: 'tag' },
  { key: 'quality', icon: 'zoom' },
  { key: 'refund', icon: 'calendar' },
];

/**
 * The return's own progress, drawn as the horizontal four-step tracker the
 * shopper is shown from the moment they raise it:
 *
 *   Return Requested → Out for Pickup → Refund Started → Refund Success
 *
 * It is deliberately *not* the order's vertical timeline. The order's journey
 * ended at "Delivered" and the return is a second, separate journey over the same
 * parcel — drawing them as one ladder would put "Refund Success" underneath
 * "Delivered" and invite the question of which one the order is actually in.
 *
 * A rejected return has no fourth step to reach, so the steps stop where they
 * stopped and the refusal is stated underneath in its own words.
 */
export default function ReturnTracker({ order }) {
  const { t } = useTranslation(['account', 'common']);

  const request = order.returnRequest;
  if (!request?.status) return null;

  const history = request.history || [];
  const rejected = request.status === 'rejected';

  // Where the tracker has got to. A rejected return keeps whatever it had
  // reached: the pickup really did happen if it happened, and erasing it would
  // make the refusal unreadable.
  const reachedFrom = history.reduce(
    (max, row) => Math.max(max, RETURN_STATUS_STEPS.indexOf(row.status)),
    -1
  );
  const reached = Math.max(reachedFrom, RETURN_STATUS_STEPS.indexOf(request.status), 0);

  const stampFor = (key) =>
    ({
      requested: request.requestedAt,
      out_for_pickup: history.find((row) => row.status === 'out_for_pickup')?.changedAt,
      refund_started: request.refundStartedAt,
      refund_success: request.refundCompletedAt,
    })[key];

  const done = (index) => index <= reached;
  // Nothing is still in flight once the request has been refused.
  const active = (index) => !rejected && index === reached && reached < RETURN_STATUS_STEPS.length - 1;

  const settled = request.status === 'refund_success';
  const refundAmount = request.refundAmount ?? order.pricing?.total;

  return (
    <section className="card p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-ink-900">{t('detail.returnStatusHeading')}</h2>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
            rejected
              ? 'bg-red-50 text-red-700 ring-red-200'
              : settled
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-amber-50 text-amber-700 ring-amber-200'
          }`}
        >
          {t(`detail.returnSteps.${request.status}`)}
        </span>
      </div>

      {/* ---------- the four steps ---------- */}
      <ol className="grid grid-cols-4 gap-x-1">
        {RETURN_STATUS_STEPS.map((key, index) => {
          const complete = done(index);
          const at = stampFor(key);
          const last = index === RETURN_STATUS_STEPS.length - 1;

          return (
            <li key={key} className="relative min-w-0">
              {/* The rail runs *out* of this dot toward the next one, and takes
                  the colour of the step it arrives at — so the green stops
                  exactly where the progress does. */}
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute left-1/2 top-[13px] h-0.5 w-full ${
                    done(index + 1) ? 'bg-success' : 'bg-ink-200'
                  }`}
                />
              )}

              <span
                className={`relative z-10 grid h-7 w-7 place-items-center rounded-full ${
                  complete ? 'bg-success text-white' : 'bg-ink-200 text-ink-400'
                } ${active(index) ? 'animate-pulse' : ''}`}
              >
                {complete ? (
                  <Icon name="check" size={13} />
                ) : (
                  <span className="h-2 w-2 rounded-full bg-current" />
                )}
              </span>

              <p
                className={`mt-2 pr-2 text-xs font-semibold leading-tight ${
                  complete ? 'text-ink-900' : 'text-ink-400'
                }`}
              >
                {t(`detail.returnSteps.${key}`)}
              </p>
              {at && complete && (
                <p className="mt-0.5 pr-2 text-[11px] leading-tight text-ink-500">
                  {formatDateTime(at)}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {/* ---------- why, and for how much ---------- */}
      <dl className="mt-5 grid gap-3 rounded-lg bg-ink-50 p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
            {t('detail.returnReasonLabel')}
          </dt>
          {/* The shopper's own words, or an admin-authored label — shown as written. */}
          <dd className="font-semibold text-ink-800">{request.reason}</dd>
        </div>
        {refundAmount > 0 && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
              {t('detail.returnRefundAmount')}
            </dt>
            <dd className="font-semibold text-ink-800">{formatPrice(refundAmount)}</dd>
          </div>
        )}
        {request.pickupTrackingNumber && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
              {t('detail.returnPickupTracking')}
            </dt>
            <dd className="font-semibold text-ink-800">
              {request.pickupTrackingNumber}
              {request.pickupPartner && ` · ${request.pickupPartner}`}
            </dd>
          </div>
        )}
        {settled && order.refundReference && (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
              {t('detail.returnRefundReference')}
            </dt>
            <dd className="font-semibold text-ink-800">{order.refundReference}</dd>
          </div>
        )}
      </dl>

      {rejected ? (
        <div className="mt-4 rounded-lg bg-red-50 p-4">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-red-800">
            <Icon name="alert" size={15} />
            {t('detail.returnRejectedTitle')}
          </p>
          <p className="mt-1 text-xs text-red-700">
            {request.rejectionReason || t('detail.returnRejectedDefault')}
          </p>
        </div>
      ) : settled ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-emerald-50 p-4">
          <Icon name="check" size={16} className="mt-0.5 shrink-0 text-success" />
          <p className="text-xs text-emerald-800">
            {t('detail.returnRefundedNote', { amount: formatPrice(refundAmount) })}
          </p>
        </div>
      ) : (
        /* ---------- the pickup small print, while one is still coming ---------- */
        <div className="mt-4 rounded-xl bg-brand-50/60 p-4">
          <p className="mb-3 text-sm font-bold text-ink-900">{t('detail.returnNoteTitle')}</p>
          <ul className="space-y-3">
            {NOTES.map((note) => (
              <li key={note.key} className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0 text-ink-500">
                  <Icon name={note.icon} size={18} />
                </span>
                <span className="text-sm leading-snug text-ink-600">
                  {t(`detail.returnNotes.${note.key}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
