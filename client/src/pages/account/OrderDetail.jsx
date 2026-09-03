import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { orderApi } from '../../api/endpoints';
import { getAccessToken } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useLiveRefetch, useRealtimeRoom } from '../../realtime/useRealtime';
import { ORDER_EVENTS, rooms } from '../../realtime/events';
import { formatDate, formatDateTime, formatPrice, optimisedImage } from '../../utils/format';
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  ORDER_CLOSED_STATUSES,
  ORDER_STATUS_STEPS,
  RETURN_OPEN_STATUSES,
  showInvoiceAction,
} from '../../utils/constants';
import useSettings from '../../settings/useSettings';
import { orderTotals } from '../../utils/pricing';
import PriceSummary from '../../components/cart/PriceSummary';
import Seo from '../../components/common/Seo';
import Icon from '../../components/common/Icon';
import StatusBadge from '../../components/common/StatusBadge';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import Modal from '../../components/common/Modal';
import CancelReasonDialog from '../../components/orders/CancelReasonDialog';
import ReturnReasonDialog from '../../components/orders/ReturnReasonDialog';
import ReturnTracker, { ReturnStatusBadge } from '../../components/orders/ReturnTracker';
import Timeline from '../../components/orders/Timeline';
import ErrorState from '../../components/common/ErrorState';
import { ListRowSkeleton } from '../../components/common/Skeleton';

/**
 * The rows the timeline draws for one order.
 *
 * A closed order is read from its own history rather than from where `cancelled`
 * sits in the ladder: it stopped somewhere along the path, and the question is
 * what actually happened, not how the terminal status sorts. So the steps it
 * really reached stay, complete and green, and the closing status is appended as
 * the last row — the steps it never got to are simply not drawn, because a grey
 * "Delivered" under a cancelled order invites exactly the question it can't
 * answer.
 *
 * A live order keeps the full ladder ahead of it, greyed, so a shopper can see
 * what is still to come.
 */
function timelineRows(order) {
  const history = order.statusHistory || [];
  const rankOf = (status) => ORDER_STATUS_STEPS.indexOf(status);
  const entryFor = (status) => history.find((row) => row.status === status);

  const closed = ORDER_CLOSED_STATUSES.includes(order.orderStatus);
  const reachedFromHistory = history.reduce((max, row) => Math.max(max, rankOf(row.status)), -1);
  // "Order Placed" is true of every order, whether or not a `pending` row was
  // ever written — a COD order is confirmed the moment it is created.
  const reached = closed
    ? Math.max(reachedFromHistory, 0)
    : Math.max(reachedFromHistory, rankOf(order.orderStatus), 0);

  const steps = ORDER_STATUS_STEPS.slice(0, closed ? reached + 1 : undefined).map((key, index) => {
    const entry = entryFor(key);

    return {
      key,
      label: `detail.steps.${key}`,
      done: index <= reached,
      // Nothing is still in progress once an order has stopped.
      active: !closed && index === reached,
      at: entry?.changedAt || (index === 0 ? order.createdAt : null),
      note: entry?.note,
    };
  });

  if (!closed) return steps;

  return [
    ...steps,
    {
      key: order.orderStatus,
      // The terminal statuses are already named in the shared status vocabulary;
      // `detail.steps` only covers the fulfilment path.
      label: `common:orderStatus.${order.orderStatus}`,
      done: true,
      closing: true,
      at: order.cancelledAt || entryFor(order.orderStatus)?.changedAt,
      reason: order.cancellationReason,
      by: order.cancelledBy,
    },
  ];
}

function StatusTimeline({ order, t }) {
  const rows = timelineRows(order).map((row) => ({
    ...row,
    label: t(row.label),
    ...(row.closing && {
      panel: {
        title:
          row.by === 'customer'
            ? t('detail.cancelledByYou')
            : row.by === 'admin'
              ? t('detail.cancelledByStore')
              : t('detail.cancelledTitle'),
        // An admin-authored reason, or the shopper's own words, shown as
        // written; only our fallback sentence is translated.
        text: t('detail.cancelledReason', {
          reason: row.reason || t('detail.cancelledDefault'),
        }),
      },
    }),
  }));

  return <Timeline rows={rows} />;
}

export default function OrderDetail() {
  const { t } = useTranslation(['account', 'common']);
  const { id } = useParams();
  /**
   * Both journeys are three dialogs deep and only one is ever open:
   *
   *   confirm       → reason       → done   (cancel)
   *   returnConfirm → returnReason → done   (return)
   *
   * with `blocked` / `returnBlocked` for an order past the point of either — the
   * button stays on the page in that case and explains itself rather than
   * disappearing, which reads as the feature being broken.
   */
  const [dialog, setDialog] = useState(null);
  /**
   * Which journey the tracking card is showing. It is only ever consulted when
   * the order has a return, and it starts on the return: that is the half still
   * moving, and it is what the shopper opened the page to check.
   */
  const [journey, setJourney] = useState('return');
  // The choice belongs to the order being read, not to the page: walking from
  // one order to the next reuses this component, and a tab left on the order's
  // history would otherwise hide the next order's live return.
  useEffect(() => setJourney('return'), [id]);
  const { commerce } = useSettings();

  const { data, loading, error, refetch } = useFetch(
    useCallback(() => orderApi.detail(id), [id]),
    [id]
  );

  // The timeline and tracking details are exactly what an admin changes, so this
  // page follows its own order rather than polling.
  useRealtimeRoom(rooms.order(id));
  useLiveRefetch(refetch, ORDER_EVENTS, {
    filter: (payload) => !payload?.order?._id || payload.order._id === id,
  });

  const order = data?.data?.order;

  /**
   * Runs once a reason has been chosen — the confirmation dialog on its own no
   * longer cancels anything. The error is rethrown so the reason dialog can show
   * it inline and stay open on the choice the shopper already made.
   */
  const cancel = async (payload) => {
    try {
      await orderApi.cancel(id, payload);
      // No toast here — the realtime order-status broadcast already announces the
      // cancellation, and firing both stacked two near-identical toasts.
      refetch();
    } catch (err) {
      toast.error(err.message || t('detail.cancelFailed'));
      throw err;
    }
  };

  /**
   * Raises the return once a reason has been chosen. The error is rethrown so the
   * reason dialog can show it inline and stay open on the choice already made —
   * which is what a window that closed while the tab sat open looks like.
   */
  const requestReturn = async (payload) => {
    try {
      await orderApi.requestReturn(id, payload);
      toast.success(t('detail.returnRequested'));
      refetch();
    } catch (err) {
      toast.error(err.message || t('detail.returnFailed'));
      throw err;
    }
  };

  const downloadInvoice = async () => {
    try {
      const response = await fetch(orderApi.invoiceUrl(id), {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
        credentials: 'include',
      });
      if (!response.ok) throw new Error(t('detail.invoiceUnavailable'));

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${order.invoiceNumber}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading) return <ListRowSkeleton rows={3} />;
  if (error || !order) {
    return <ErrorState title={t('detail.notFound')} message={error?.message} onRetry={refetch} />;
  }

  const canCancel = CUSTOMER_CANCELLABLE_STATUSES.includes(order.orderStatus);
  // Offered from confirmation up to delivery; past `packed` it explains why it
  // can't be used. A delivered order has arrived and a closed one has ended, so
  // neither has anything left to cancel — there the button goes away rather than
  // explaining itself. `pending` goes the same way for the opposite reason: the
  // order has not been placed yet, so there is nothing to cancel and nothing
  // support could do about it either.
  const showCancel =
    order.orderStatus !== 'pending' &&
    order.orderStatus !== 'delivered' &&
    !ORDER_CLOSED_STATUSES.includes(order.orderStatus);
  /*
   * The invoice, on the API's verdict rather than one recomputed here — the same
   * arrangement as the return policy below, and for the same reason.
   *
   * The rule it answers with depends on how the order is paid, because the two
   * methods settle at opposite ends of the journey: a prepaid order has its
   * invoice from the moment the payment lands, and a COD order — which is not
   * paid until the doorstep — has it from dispatch, since that is when the goods
   * were actually supplied.
   */
  const invoiceAvailable = Boolean(data?.data?.invoiceAvailable);
  const showInvoice = showInvoiceAction(order, invoiceAvailable);

  /*
   * Returns. The API answers with its own verdict on this order — computed by the
   * same function the return endpoint enforces with — so the button and the
   * endpoint can never disagree about a window that closed while the tab was
   * open. `returnWindowDays` is only for the copy that quotes the promise.
   */
  const returnPolicy = data?.data?.returnPolicy || {};
  const returnWindowDays = returnPolicy.windowDays ?? commerce.returnWindowDays;
  const returnStatus = order.returnRequest?.status;
  // Whether there is a second journey to switch to at all.
  const hasReturn = Boolean(returnStatus);
  const returnInProgress = RETURN_OPEN_STATUSES.includes(returnStatus);
  const canReturn = Boolean(returnPolicy.eligible);
  // Offered on a delivered order right up until it has been returned. Past the
  // window it explains why it cannot be used rather than vanishing; once a return
  // is running the tracker below has taken its place, so the button goes.
  const showReturn =
    order.orderStatus === 'delivered' &&
    !returnInProgress &&
    returnStatus !== 'refund_success' &&
    returnWindowDays > 0;

  return (
    <div className="space-y-5">
      {/* The order number is the useful tab label here, not a generic page name. */}
      <Seo title={order.orderNumber} noIndex />

      <Link
        to="/account/orders"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:underline"
      >
        <Icon name="chevronLeft" size={15} />
        {t('detail.backToOrders')}
      </Link>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="panel-title">{order.orderNumber}</h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {t('detail.placedOn', { date: formatDateTime(order.createdAt) })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* First of the three, because it is the newest thing to have happened
                to this order: the payment cleared and the parcel arrived days
                before the return was raised. The order's own badges stay — the
                return is a second journey over a parcel that was still paid for
                and still delivered. */}
            {hasReturn && <ReturnStatusBadge status={returnStatus} />}
            <StatusBadge status={order.paymentStatus} kind="payment" />
            <StatusBadge status={order.orderStatus} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 border-t border-ink-100 pt-4">
          {showInvoice && (
            <button
              type="button"
              onClick={() => (invoiceAvailable ? downloadInvoice() : setDialog('invoiceBlocked'))}
              className="btn-outline"
            >
              <Icon name="download" size={16} />
              {t('detail.downloadInvoice')}
            </button>
          )}
          {showReturn && (
            <button
              type="button"
              onClick={() => setDialog(canReturn ? 'returnConfirm' : 'returnBlocked')}
              className="btn-outline"
            >
              <Icon name="refresh" size={16} />
              {t('detail.returnOrder')}
            </button>
          )}
          {showCancel && (
            <button
              type="button"
              onClick={() => setDialog(canCancel ? 'confirm' : 'blocked')}
              className="btn-outline-danger"
            >
              {t('detail.cancelOrder')}
            </button>
          )}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {/* Both journeys over the same parcel live in this one card. A return
              is a second trip, not a continuation of the first, so it keeps its
              own tracker — but behind a tab rather than in a card of its own,
              so the page has a single place that answers "where has this got
              to". Without a return there is nothing to switch between and the
              card is simply the order's timeline, headed as before. */}
          <section className={hasReturn ? 'card overflow-hidden' : 'card p-5'}>
            {hasReturn ? (
              /* One header strip across the top of the card — tabs left, the
                 return's own state right — drawn exactly as the product page
                 draws its tabs: full-bleed on `bg-ink-50`, the active tab lifted
                 out of the strip in white under a brand underline. The card
                 turns `overflow-hidden` and the padding moves onto the panel so
                 the strip can reach the card's edges.

                 The tabs run in the order the parcel travelled: the order first,
                 the return it may have started second. */
              <div className="border-b border-ink-200 bg-ink-50">
                <div
                  role="tablist"
                  aria-label={t('detail.orderStatus')}
                  className="hide-scrollbar flex overflow-x-auto"
                >
                  {[
                    { key: 'order', label: t('detail.orderStatus') },
                    { key: 'return', label: t('detail.returnStatusHeading') },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      id={`journey-tab-${tab.key}`}
                      aria-controls="journey-panel"
                      aria-selected={journey === tab.key}
                      onClick={() => setJourney(tab.key)}
                      className={`whitespace-nowrap border-b-2 px-5 py-3.5 text-sm font-semibold transition ${
                        journey === tab.key
                          ? 'border-brand-600 bg-white text-brand-600'
                          : 'border-transparent text-ink-500 hover:text-ink-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <h2 className="mb-4 text-base font-bold text-ink-900">{t('detail.orderStatus')}</h2>
            )}

            <div
              id="journey-panel"
              className={hasReturn ? 'p-5' : undefined}
              role={hasReturn ? 'tabpanel' : undefined}
              aria-labelledby={hasReturn ? `journey-tab-${journey}` : undefined}
            >
              {hasReturn && journey === 'return' ? (
                <ReturnTracker order={order} />
              ) : (
                <>
                <StatusTimeline order={order} t={t} />

                {(order.trackingNumber || order.expectedDeliveryDate) && (
                  <div className="mt-4 grid gap-3 rounded-lg bg-ink-50 p-4 text-sm sm:grid-cols-2">
                    {order.trackingNumber && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                          {t('detail.trackingLabel')}
                        </p>
                        <p className="font-semibold text-ink-800">
                          {order.trackingNumber}
                          {order.courierPartner && ` · ${order.courierPartner}`}
                        </p>
                      </div>
                    )}
                    {order.expectedDeliveryDate && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                          {t('detail.expectedDelivery')}
                        </p>
                        <p className="font-semibold text-ink-800">
                          {formatDate(order.expectedDeliveryDate)}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                </>
              )}
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-base font-bold text-ink-900">
              {t('detail.itemsHeading', { count: order.items.length })}
            </h2>
            <div className="divide-y divide-ink-100">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-3 py-3">
                  {item.image && (
                    <Link to={item.slug ? `/product/${item.slug}` : '#'} className="shrink-0">
                      <img
                        src={optimisedImage(item.image, { width: 140, height: 140 })}
                        alt={item.name}
                        loading="lazy"
                        className="h-[70px] w-[70px] rounded-lg border border-ink-200 object-cover"
                      />
                    </Link>
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      to={item.slug ? `/product/${item.slug}` : '#'}
                      className="line-clamp-2 text-sm font-medium text-ink-800 hover:text-brand-600"
                    >
                      {item.name}
                    </Link>
                    {/* The SKU that shipped — what a return or a support query refers to. */}
                    {item.variantLabel && (
                      <p className="mt-0.5 text-xs font-medium text-ink-700">
                        {item.variantLabel}
                        {item.variantSku && (
                          <span className="ml-2 font-normal text-ink-400">{item.variantSku}</span>
                        )}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-ink-500">
                      {[item.brand, item.categoryName, item.subCategoryName].filter(Boolean).join(' · ')}
                    </p>
                    <p className="mt-1 text-xs text-ink-500">
                      {formatPrice(item.finalPrice)} × {item.quantity}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-bold text-ink-900">
                    {formatPrice(item.lineTotal)}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-5">
          <section className="card p-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-500">
              {t('detail.deliveryAddress')}
            </h2>
            <p className="text-sm font-semibold text-ink-900">{order.shippingAddress.fullName}</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-600">
              {order.shippingAddress.addressLine1}
              {order.shippingAddress.addressLine2 && `, ${order.shippingAddress.addressLine2}`}
              {order.shippingAddress.landmark && `, ${order.shippingAddress.landmark}`}
              <br />
              {order.shippingAddress.city}, {order.shippingAddress.state} —{' '}
              {order.shippingAddress.pincode}
              <br />
              {order.shippingAddress.country}
            </p>
            <p className="mt-2 text-sm text-ink-500">
              {t('detail.phone', { phone: order.shippingAddress.phone })}
            </p>
          </section>

          {/* The cart's own Price Details card, fed the order's stored pricing —
              same rows, same arithmetic, same wording as at checkout. */}
          <PriceSummary
            totals={orderTotals(order)}
            couponCode={order.pricing.couponCode}
            title={t('detail.priceDetails')}
          >
            <p className="text-xs text-ink-500">
              {t('detail.paidVia', {
                method:
                  order.paymentMethod === 'cod'
                    ? t('detail.cashOnDelivery')
                    : t('detail.onlineRazorpay'),
              })}{' '}
              · {t(`common:paymentStatus.${order.paymentStatus}`, order.paymentStatus)}
            </p>
            {/* The reference the refund was raised under, so a customer chasing
                it with their bank has the number without asking support — but
                only where nothing else on the page has already given it. A
                settled return states it among its own details, and printing it
                twice on one screen reads as two different numbers to check. A
                refund with no return behind it — a cancelled order — has this
                card as its only home. */}
            {order.refundReference && returnStatus !== 'refund_success' && (
              <p className="mt-1 text-xs text-ink-500">
                {t('detail.refundReference', { reference: order.refundReference })}
              </p>
            )}
          </PriceSummary>
        </div>
      </div>

      {/* Step one: are you sure. Confirming only opens the reason dialog — the
          order is not touched until a reason has been given. */}
      <ConfirmDialog
        open={dialog === 'confirm'}
        // ConfirmDialog closes itself after `onConfirm` resolves, which would undo
        // the step it just opened — so dismissing only applies while this dialog
        // is still the one on screen.
        onClose={() => setDialog((open) => (open === 'confirm' ? null : open))}
        onConfirm={() => setDialog('reason')}
        title={t('detail.cancelTitle')}
        message={t('detail.cancelMessage')}
        confirmLabel={t('detail.cancelConfirm')}
        cancelLabel={t('detail.cancelDismiss')}
      />

      <CancelReasonDialog
        open={dialog === 'reason'}
        onClose={() => setDialog(null)}
        onConfirm={cancel}
      />

      {/* The return's own first step: are you sure. Confirming only opens the
          reason dialog — nothing is raised until a reason has been given, exactly
          as cancelling behaves. */}
      <ConfirmDialog
        open={dialog === 'returnConfirm'}
        onClose={() => setDialog((open) => (open === 'returnConfirm' ? null : open))}
        onConfirm={() => setDialog('returnReason')}
        title={t('detail.returnTitle')}
        message={t('detail.returnMessage')}
        confirmLabel={t('detail.returnConfirm')}
        cancelLabel={t('detail.returnDismiss')}
        danger={false}
      />

      <ReturnReasonDialog
        open={dialog === 'returnReason'}
        onClose={() => setDialog(null)}
        onConfirm={requestReturn}
      />

      {/* Past the return window the same button opens this — it says when the
          window closed and where to go, rather than failing silently. */}
      <Modal
        open={dialog === 'returnBlocked'}
        onClose={() => setDialog(null)}
        title={t('detail.returnBlockedTitle')}
        size="sm"
      >
        <div className="flex items-start gap-3">
          <Icon name="info" size={18} className="mt-0.5 shrink-0 text-brand-600" />
          <p className="text-sm text-ink-600">
            {returnPolicy.deadline
              ? t('detail.returnBlockedClosed', {
                  days: returnWindowDays,
                  date: formatDate(returnPolicy.deadline),
                })
              : t('detail.returnBlockedGeneric')}
          </p>
        </div>
      </Modal>

      {/* Past the cut-off the same button opens this instead — it says what
          happened and where to go, rather than failing silently. */}
      <Modal
        open={dialog === 'blocked'}
        onClose={() => setDialog(null)}
        title={t('detail.cancelBlockedTitle')}
        size="sm"
        footer={
          <button type="button" onClick={() => setDialog(null)} className="btn-primary">
            {t('common:actions.close')}
          </button>
        }
      >
        <div className="flex items-start gap-3">
          <Icon name="info" size={18} className="mt-0.5 shrink-0 text-danger" />
          <p className="text-sm text-ink-600">
            {t('detail.cancelBlockedMessage', {
              status: t(`common:orderStatus.${order.orderStatus}`),
            })}
          </p>
        </div>
      </Modal>

      {/* What the COD invoice button opens while the order is still in the
          warehouse: the invoice is coming, and this says when. Brand blue rather
          than the danger red the cancellation refusal wears — nothing has gone
          wrong here, the shopper is simply early. */}
      <Modal
        open={dialog === 'invoiceBlocked'}
        onClose={() => setDialog(null)}
        title={t('detail.invoiceBlockedTitle')}
        size="sm"
      >
        <div className="flex items-start gap-3">
          <Icon name="info" size={18} className="mt-0.5 shrink-0 text-brand-600" />
          <p className="text-sm text-ink-600">{t('detail.invoiceBlockedMessage')}</p>
        </div>
      </Modal>
    </div>
  );
}
