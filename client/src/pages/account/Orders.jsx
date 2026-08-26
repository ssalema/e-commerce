import { Fragment, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { orderApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { ORDER_EVENTS } from '../../realtime/events';
import { formatDate, formatPrice, optimisedImage } from '../../utils/format';
import Seo from '../../components/common/Seo';
import Icon from '../../components/common/Icon';
import StatusBadge from '../../components/common/StatusBadge';
import Pagination from '../../components/common/Pagination';
import EmptyState from '../../components/common/EmptyState';
import ErrorState from '../../components/common/ErrorState';
import { ListRowSkeleton } from '../../components/common/Skeleton';

/*
 * Values are the API's; the labels come from the shared `orderStatus` map —
 * except the two that name no order status: "all", and "returns", which asks a
 * different question of the API. A returning order stays Delivered underneath,
 * so it could never be an eighth order status without vanishing from
 * "Delivered"; it is a filter over the return raised on top of the order.
 */
const FILTERS = ['all', 'pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returns'];

/**
 * The step each status is waiting for — the server's own STATUS_FLOW with the
 * cancellation branch left out, because that is a thing that may happen to an
 * order, not a thing it is on its way to.
 *
 * `delivered` and `returned` are absent deliberately: nothing further is coming,
 * and the card says nothing rather than promising an update that will never
 * arrive.
 */
const NEXT_STATUS = {
  pending: 'confirmed',
  confirmed: 'packed',
  packed: 'shipped',
  shipped: 'out_for_delivery',
  out_for_delivery: 'delivered',
};

/**
 * The same idea for the return's own journey: the step a running return waits
 * for, so a returning order can promise its next update instead of restating the
 * state its chip already shows.
 *
 * `refund_success` and `rejected` are absent — both are endings, and the card
 * names them outright rather than promising an update that will never arrive.
 */
const NEXT_RETURN_STATUS = {
  requested: 'out_for_pickup',
  out_for_pickup: 'refund_started',
  refund_started: 'refund_success',
};

export default function Orders() {
  const { t } = useTranslation(['account', 'common']);
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);

  // "returns" is asked as ?returnStatus=any — every order carrying a return,
  // whatever the order status underneath it says. "Delivered" is asked as its
  // mirror image: ?returnStatus=none, so an order that has started a return
  // leaves the delivered list for the returns one rather than sitting in both.
  const { data, loading, error, refetch } = useFetch(
    useCallback(
      () =>
        orderApi.list(
          status === 'returns'
            ? { returnStatus: 'any', page, limit: 8 }
            : status === 'delivered'
              ? { status, returnStatus: 'none', page, limit: 8 }
              : { status, page, limit: 8 }
        ),
      [status, page]
    ),
    [status, page]
  );

  // Status moves, payments clearing and new orders all reshape this list.
  useLiveRefetch(refetch, ORDER_EVENTS);

  const orders = data?.data?.orders || [];
  const meta = data?.meta;

  // One name per filter, for the chip and for the empty state that quotes it.
  const filterLabel = (value) =>
    value === 'all'
      ? t('orders.filterAll')
      : value === 'returns'
        ? t('orders.filterReturns')
        : t(`common:orderStatus.${value}`);

  return (
    <div>
      <Seo title={t('common:nav.myOrders')} noIndex />

      <h1 className="mb-4 panel-title">{t('common:nav.myOrders')}</h1>

      <div className="hide-scrollbar mb-5 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((value) => (
          <Fragment key={value}>
            {/* The one filter that asks a different question gets a hairline in
                front of it — the admin says the same thing by giving Return a
                control of its own, next to the order-status one rather than
                inside it. */}
            {value === 'returns' && (
              <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 self-center bg-ink-200" />
            )}
            <button
              type="button"
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
              aria-pressed={status === value}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                status === value
                  ? 'bg-brand-600 text-white'
                  : 'border border-ink-300 bg-white text-ink-600 hover:border-brand-500 hover:text-brand-600'
              }`}
            >
              {filterLabel(value)}
            </button>
          </Fragment>
        ))}
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={refetch} />
      ) : loading ? (
        <ListRowSkeleton rows={4} />
      ) : !orders.length ? (
        <EmptyState
          icon="package"
          title={
            status === 'all'
              ? t('orders.emptyTitle')
              : status === 'returns'
                ? t('orders.emptyReturns')
                : t('orders.emptyFiltered', { status: filterLabel(status) })
          }
          message={t(status === 'all' ? 'orders.emptyMessage' : 'orders.emptyFilteredMessage')}
          actionLabel={t(status === 'all' ? 'orders.startShopping' : 'orders.showAll')}
          actionTo={status === 'all' ? '/products' : undefined}
          onAction={status === 'all' ? undefined : () => setStatus('all')}
        />
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <article key={order._id} className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 bg-ink-50 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
                  <div>
                    <p className="font-medium uppercase tracking-wide text-ink-400">
                      {t('orders.order')}
                    </p>
                    <p className="font-bold text-ink-900">{order.orderNumber}</p>
                  </div>
                  <div>
                    <p className="font-medium uppercase tracking-wide text-ink-400">
                      {t('orders.placedOn')}
                    </p>
                    <p className="font-semibold text-ink-700">{formatDate(order.createdAt)}</p>
                  </div>
                  <div>
                    <p className="font-medium uppercase tracking-wide text-ink-400">
                      {t('orders.total')}
                    </p>
                    <p className="font-bold text-ink-900">{formatPrice(order.pricing.total)}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Its own badge rather than a fourth order status: the order is
                      still `delivered` while a return runs, and overwriting that
                      would lose the fact that the parcel did arrive. Drawn by the
                      same component as the two beside it, so it reads as one more
                      status of this order and not as a label of another kind. */}
                  {order.returnRequest?.status && (
                    <StatusBadge status={order.returnRequest.status} kind="return" />
                  )}
                  <StatusBadge status={order.paymentStatus} kind="payment" />
                  <StatusBadge status={order.orderStatus} />
                </div>
              </div>

              <div className="p-4">
                <div className="mb-3 flex flex-wrap gap-3">
                  {order.items.slice(0, 4).map((item, index) => (
                    <div key={index} className="flex items-center gap-2.5">
                      {item.image && (
                        <img
                          src={optimisedImage(item.image, { width: 100, height: 100 })}
                          alt={item.name}
                          loading="lazy"
                          className="h-14 w-14 rounded-lg border border-ink-200 object-cover"
                        />
                      )}
                      <div className="max-w-[180px]">
                        <p className="line-clamp-2 text-xs font-medium text-ink-700">{item.name}</p>
                        <p className="text-[11px] text-ink-400">
                          {t('orders.qty', { count: item.quantity })}
                        </p>
                      </div>
                    </div>
                  ))}
                  {order.items.length > 4 && (
                    <span className="self-center text-xs font-medium text-ink-500">
                      {t('orders.moreItems', { count: order.items.length - 4 })}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-3">
                  {order.returnRequest?.status ? (
                    /* A return in progress is the only thing still happening to
                       this order, so it takes the line that would otherwise
                       report a delivery that is already several days old — and it
                       says it the way an order still in flight does, by naming the
                       step yet to come rather than repeating the state the chip
                       above already shows. A finished return has nothing left to
                       promise, so there the line names the ending instead. */
                    NEXT_RETURN_STATUS[order.returnRequest.status] ? (
                      <p className="text-xs text-ink-500">
                        {t('orders.willNotify', {
                          status: t(
                            `detail.returnSteps.${NEXT_RETURN_STATUS[order.returnRequest.status]}`
                          ).toLowerCase(),
                        })}
                      </p>
                    ) : (
                      <p
                        className={`text-xs font-medium ${
                          order.returnRequest.status === 'rejected' ? 'text-danger' : 'text-success'
                        }`}
                      >
                        {t(`detail.returnSteps.${order.returnRequest.status}`)}
                      </p>
                    )
                  ) : order.orderStatus === 'delivered' && order.deliveredAt ? (
                    <p className="text-xs font-medium text-success">
                      {t('orders.deliveredOn', { date: formatDate(order.deliveredAt) })}
                    </p>
                  ) : order.orderStatus === 'cancelled' ? (
                    <p className="text-xs font-medium text-danger">
                      {order.cancelledAt
                        ? t('orders.cancelledOn', { date: formatDate(order.cancelledAt) })
                        : t('common:orderStatus.cancelled')}
                    </p>
                  ) : order.trackingNumber || NEXT_STATUS[order.orderStatus] ? (
                    <p className="text-xs text-ink-500">
                      {order.trackingNumber
                        ? t('orders.tracking', { number: order.trackingNumber })
                        : t('orders.willNotify', {
                            // Lower-cased so the sentence reads as one in English;
                            // a no-op in every Indic script the app ships.
                            status: t(
                              `common:orderStatus.${NEXT_STATUS[order.orderStatus]}`
                            ).toLowerCase(),
                          })}
                    </p>
                  ) : null}

                  <Link
                    to={`/account/orders/${order._id}`}
                    className="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:underline"
                  >
                    {t('orders.viewDetails')}
                    <Icon name="chevronRight" size={15} />
                  </Link>
                </div>
              </div>
            </article>
          ))}

          {meta?.totalPages > 1 && (
            <Pagination page={page} totalPages={meta.totalPages} onChange={setPage} className="pt-2" />
          )}
        </div>
      )}
    </div>
  );
}
