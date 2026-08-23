import { useTranslation } from 'react-i18next';

import Icon from '../common/Icon';
import Timeline from './Timeline';
import { formatPrice } from '../../utils/format';
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
 * The rows the return's timeline draws — the twin of `timelineRows` in
 * client/src/pages/account/OrderDetail.jsx, over the return's own ladder:
 *
 *   Return Requested → Out for Pickup → Refund Started → Refund Success
 *
 * A declined return is read the way a cancelled order is: it stopped somewhere
 * along the path, so the steps it really reached stay complete and green, the
 * refusal is appended as the closing row in its own words, and the steps it
 * never got to are not drawn at all — a grey "Refund Success" under a declined
 * return invites exactly the question it cannot answer.
 *
 * A live return keeps the full ladder ahead of it, greyed, so the shopper can
 * see what is still to come.
 */
function returnRows(request, t) {
  const history = request.history || [];
  const rejected = request.status === 'rejected';
  const rankOf = (status) => RETURN_STATUS_STEPS.indexOf(status);
  const entryFor = (status) => history.find((row) => row.status === status);

  const reachedFromHistory = history.reduce((max, row) => Math.max(max, rankOf(row.status)), -1);
  // "Return Requested" is true of every return, whether or not a `requested`
  // row was ever written — raising it is what created the request.
  const reached = rejected
    ? Math.max(reachedFromHistory, 0)
    : Math.max(reachedFromHistory, rankOf(request.status), 0);

  const stampFor = (key) =>
    ({
      requested: request.requestedAt,
      out_for_pickup: request.pickedUpAt || entryFor('out_for_pickup')?.changedAt,
      refund_started: request.refundStartedAt,
      refund_success: request.refundCompletedAt,
    })[key];

  const steps = RETURN_STATUS_STEPS.slice(0, rejected ? reached + 1 : undefined).map(
    (key, index) => ({
      key,
      label: t(`detail.returnSteps.${key}`),
      done: index <= reached,
      // Nothing is still in flight once the request has been refused, and the
      // last step is where the journey ends rather than something in progress.
      active: !rejected && index === reached && reached < RETURN_STATUS_STEPS.length - 1,
      at: stampFor(key) || (index === 0 ? request.requestedAt : entryFor(key)?.changedAt),
      // The row that raised the return is stamped with the reason as its note,
      // which the details underneath already state in full — so it is dropped
      // here rather than said twice a few lines apart.
      note: key === 'requested' ? null : entryFor(key)?.note,
    })
  );

  if (!rejected) return steps;

  return [
    ...steps,
    {
      key: 'rejected',
      label: t('detail.returnSteps.rejected'),
      done: true,
      closing: true,
      at: request.rejectedAt || entryFor('rejected')?.changedAt,
      panel: {
        title: t('detail.returnRejectedTitle'),
        // An admin-authored reason, shown as written; only our fallback
        // sentence is translated.
        text: request.rejectionReason || t('detail.returnRejectedDefault'),
      },
    },
  ];
}

/**
 * The return's own progress, drawn as the same vertical ladder the order's
 * timeline uses — same beads, same rail, same stamps, same red closing row.
 *
 * It is deliberately not *appended* to the order's timeline. The order's journey
 * ended at "Delivered" and the return is a second, separate journey over the
 * same parcel; drawing them as one ladder would put "Refund Success" underneath
 * "Delivered" and invite the question of which one the order is actually in.
 * The two live in one card behind a tab apiece instead, so the page offers a
 * single place to read "where has this got to" — and now a single way to read
 * it, rather than two trackers shaped differently enough to need learning twice.
 *
 * This renders the panel only — the card and the tab that selects it belong to
 * the page that owns both journeys.
 */
/**
 * The return's own state, as a pill.
 *
 * It lives out here because the card's header is where it belongs — on the tab
 * row, opposite the tabs, the way the panel puts its action there — and that
 * header is owned by the page, not by this panel. Inside the panel it sat on a
 * line of its own under the tabs, which read as an empty band.
 */
export function ReturnStatusBadge({ status }) {
  const { t } = useTranslation(['account']);

  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
        status === 'rejected'
          ? 'bg-red-50 text-red-700 ring-red-200'
          : status === 'refund_success'
            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
            : 'bg-amber-50 text-amber-700 ring-amber-200'
      }`}
    >
      {t(`detail.returnSteps.${status}`)}
    </span>
  );
}

export default function ReturnTracker({ order }) {
  const { t } = useTranslation(['account', 'common']);

  const request = order.returnRequest;
  if (!request?.status) return null;

  const rejected = request.status === 'rejected';
  const settled = request.status === 'refund_success';
  const refundAmount = request.refundAmount ?? order.pricing?.total;

  return (
    <div>
      <Timeline rows={returnRows(request, t)} />

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

      {/* A declined return has already said so, in the closing row of the
          ladder — repeating it underneath would be the same sentence twice. */}
      {settled ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-emerald-50 p-4">
          <Icon name="check" size={16} className="mt-0.5 shrink-0 text-success" />
          <p className="text-xs text-emerald-800">
            {t('detail.returnRefundedNote', { amount: formatPrice(refundAmount) })}
          </p>
        </div>
      ) : (
        !rejected && (
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
        )
      )}
    </div>
  );
}
