import { useEffect, useMemo, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import toast from 'react-hot-toast';

import { getAccessToken, setAccessToken } from '../api/client';
import { fetchCart, cartReceived, resetCart } from '../store/cartSlice';
import { fetchWishlist, fetchWishlistIds, wishlistReceived } from '../store/wishlistSlice';
import { refreshCategories } from '../store/catalogSlice';
import { setUser, sessionExpired } from '../store/authSlice';
import { patchFetchCache } from '../hooks/useFetch';
import { applyStockToAnyResponse } from '../utils/stockPatch';

import { EVENTS } from './events';
import { connectSocket, disconnectSocket, getSocket, getSocketId } from './socket';
import { RealtimeContext, useRealtimeEvent } from './useRealtime';

/** Human wording for the order states worth interrupting a shopper about. */
const ORDER_STATUS_COPY = {
  confirmed: 'has been confirmed',
  packed: 'has been packed',
  shipped: 'is on its way',
  out_for_delivery: 'is out for delivery',
  delivered: 'has been delivered',
  cancelled: 'was cancelled',
  returned: 'was returned',
};

/**
 * A deactivation is announced twice — once by the tab that asked for it, once by the
 * broadcast that follows — so the copy and the toast id live where both can reach
 * them. Sharing the id makes the second arrival replace the first rather than stack
 * another message on top of it.
 */
export const ACCOUNT_DEACTIVATED_TOAST_ID = 'account-deactivated';
const ACCOUNT_DEACTIVATED_COPY =
  'Your account has been deactivated. You were signed off from all devices.';

/**
 * Opens the socket and applies everything that belongs to the store rather than to a
 * single page: the shopper's cart, wishlist, profile, order notifications and the
 * category nav.
 *
 * Page-level data (product grids, order lists) subscribes for itself with
 * `useLiveRefetch`, so this component holds no page state.
 */
export default function RealtimeProvider({ children }) {
  const dispatch = useDispatch();
  const { isAuthenticated, initialising, user, sessionId } = useSelector((s) => s.auth);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);

  // Reconnect under the new identity whenever the session changes — the token is
  // read at handshake time, so login and logout both need a fresh one.
  useEffect(() => {
    if (initialising) return undefined;
    connectSocket(isAuthenticated ? getAccessToken() : null);
    return undefined;
  }, [isAuthenticated, initialising, user?._id]);

  // Tear the socket down only when the whole app unmounts.
  useEffect(() => () => disconnectSocket(), []);

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
      setReady(false);
    };
    const onReady = () => setReady(true);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(EVENTS.READY, onReady);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(EVENTS.READY, onReady);
    };
  }, []);

  // A socket that has been away longer than the server's recovery window may have
  // missed writes, so personal state is re-read on every reconnect.
  useEffect(() => {
    if (!connected || !isAuthenticated) return;
    dispatch(fetchCart());
    dispatch(fetchWishlistIds());
  }, [connected, isAuthenticated, dispatch]);

  /** Ignores the echo of a change this very tab made. */
  const isOwnEcho = useCallback(
    (payload) => Boolean(payload?.originSocketId) && payload.originSocketId === getSocketId(),
    []
  );

  useRealtimeEvent(
    EVENTS.CART_UPDATED,
    (payload) => {
      if (isOwnEcho(payload)) return;
      // A null cart means "it changed, read it yourself".
      if (payload?.cart) dispatch(cartReceived(payload.cart));
      else dispatch(fetchCart());
    },
    { enabled: isAuthenticated }
  );

  useRealtimeEvent(
    EVENTS.WISHLIST_UPDATED,
    (payload) => {
      if (isOwnEcho(payload)) return;
      if (payload?.wishlist) dispatch(wishlistReceived(payload.wishlist));
      else {
        dispatch(fetchWishlistIds());
        dispatch(fetchWishlist());
      }
    },
    { enabled: isAuthenticated }
  );

  useRealtimeEvent(
    EVENTS.PROFILE_UPDATED,
    (payload) => payload?.user && dispatch(setUser(payload.user)),
    { enabled: isAuthenticated }
  );

  // An admin blocking the account shouldn't leave this tab usable until its next 401.
  useRealtimeEvent(
    EVENTS.ACCOUNT_STATUS_CHANGED,
    (payload) => {
      if (payload?.status !== 'blocked') return;
      dispatch(sessionExpired());
      dispatch(resetCart());
      const reason = payload?.blockedReason?.trim();
      toast.error(
        reason
          ? `Your account has been suspended due to ${reason}`
          : 'Your account has been suspended.'
      );
    },
    { enabled: isAuthenticated }
  );

  /**
   * Somebody signed this account out of one or more devices. The broadcast reaches
   * every device on the account — only the ones it names act on it.
   *
   * `sessionIds` lists the sessions revoked; `exceptSessionId` inverts that for
   * "everywhere but there"; neither means the whole account. Without a session id of
   * our own (a token minted before sessions existed) the safe reading is "not us" —
   * the next request will 401 anyway and the axios layer handles that.
   */
  useRealtimeEvent(
    EVENTS.SESSION_REVOKED,
    (payload) => {
      if (!sessionId) return;
      // The tab that asked for this already handled it, and said so in kinder words.
      if (isOwnEcho(payload)) return;
      const { sessionIds, exceptSessionId } = payload || {};

      const targeted = sessionIds
        ? sessionIds.includes(sessionId)
        : !exceptSessionId || exceptSessionId !== sessionId;
      if (!targeted) return;

      // Drop the token as well as the store state — leaving it behind would have the
      // axios layer try to refresh a session the server has already ended.
      setAccessToken(null);
      dispatch(sessionExpired());
      dispatch(resetCart());
      if (payload?.reason === 'account-deactivated') {
        toast.success(ACCOUNT_DEACTIVATED_COPY, { id: ACCOUNT_DEACTIVATED_TOAST_ID });
        return;
      }
      toast.error(
        payload?.reason === 'account-blocked'
          ? 'Your account has been suspended.'
          : 'You were signed out from this device.'
      );
    },
    { enabled: isAuthenticated }
  );

  useRealtimeEvent(
    EVENTS.ORDER_STATUS_CHANGED,
    (payload) => {
      const order = payload?.order;
      const copy = ORDER_STATUS_COPY[order?.orderStatus];
      if (copy) toast.success(`Order ${order.orderNumber} ${copy}`);
    },
    { enabled: isAuthenticated }
  );

  // The header nav is shared by every page, so it is refreshed here rather than
  // in each one.
  useRealtimeEvent([EVENTS.CATEGORY_CHANGED, EVENTS.SUBCATEGORY_CHANGED], () =>
    dispatch(refreshCategories())
  );

  /*
   * Stock corrections applied to every cached response, not just the screens that
   * happen to be mounted.
   *
   * Each page patches its own data while it is on screen, but the cache outlives the
   * page: a shopper on a product detail page has a home feed and a grid held from a
   * moment ago, and the sales that happen while they are reading reach neither.
   * Going back then paints those entries as they were and — being inside the
   * staleness window — issues no request at all, so a sold-out card stays for the
   * price of a navigation.
   *
   * This is the only subscriber that is always mounted, which makes it the one place
   * the sweep can live. The reducer returns untouched objects for entries the event
   * says nothing about, so a sale patches the few responses that show that product
   * and leaves the rest alone.
   */
  useRealtimeEvent(EVENTS.PRODUCT_STOCK_CHANGED, (payload) =>
    patchFetchCache((data) => applyStockToAnyResponse(data, payload))
  );

  const value = useMemo(() => ({ connected, ready }), [connected, ready]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
