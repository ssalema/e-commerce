import { useEffect, useRef, createContext } from 'react';
import { getSocket, joinRoom, leaveRoom } from './socket';
import { EVENTS } from './events';

export const RealtimeContext = createContext({ connected: false, ready: false });

/**
 * Runs `handler` whenever one of `events` arrives.
 *
 * The handler is held in a ref, so a component may pass an inline arrow without
 * re-subscribing on every render — only a change to the event list rebinds.
 */
export function useRealtimeEvent(events, handler, { enabled = true } = {}) {
  const saved = useRef(handler);
  saved.current = handler;

  const list = Array.isArray(events) ? events : [events];
  const key = list.join('|');

  useEffect(() => {
    if (!enabled || !key) return undefined;

    const socket = getSocket();
    const names = key.split('|');
    const listener = (...args) => saved.current?.(...args);

    names.forEach((name) => socket.on(name, listener));
    return () => names.forEach((name) => socket.off(name, listener));
  }, [key, enabled]);
}

/**
 * Applies `product:stock-changed` to data already in hand, instead of re-requesting it.
 *
 * This is the counterpart to `useLiveRefetch` for the one catalogue event that arrives
 * often enough to matter: it is emitted per line item of every order placed, to every
 * connected visitor. A screen that refetched on it made each sale cost one read per
 * shopper currently browsing, which is the wrong direction for a shop to scale in.
 *
 * `reduce(previousState, payload)` must return the previous object unchanged when the
 * event touches nothing it holds — the reducers in utils/stockPatch.js all do — so a
 * grid of forty cards re-renders none of them for a product it is not showing.
 *
 * `setData` is a `useFetch` state setter and is therefore stable; the reducer is held
 * in a ref, so an inline arrow at the call site does not re-subscribe.
 */
export function useLiveStockPatch(setData, reduce, { enabled = true } = {}) {
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;

  useRealtimeEvent(
    EVENTS.PRODUCT_STOCK_CHANGED,
    (payload) => setData?.((prev) => reduceRef.current(prev, payload)),
    { enabled }
  );
}

/** Subscribes to a server room (e.g. `product:<id>`) for as long as the component lives. */
export function useRealtimeRoom(room, { enabled = true } = {}) {
  useEffect(() => {
    if (!enabled || !room) return undefined;
    joinRoom(room);
    return () => leaveRoom(room);
  }, [room, enabled]);
}

/**
 * Re-runs a `useFetch` refetch when any of `events` fires.
 *
 * Bursts are collapsed into a single refetch: placing an order can emit a stock
 * change per line item, and a list has no reason to reload once per item. `filter`
 * narrows the trigger further — e.g. a detail page that only cares about its own id.
 *
 * `jitter` spreads the refetch across a window rather than firing it at a fixed
 * delay. The debounce above only collapses a burst *within one browser*; a broadcast
 * goes to every open tab at once, and every one of them was waking on the same
 * 250ms timer and arriving at the API together. Under load that turns one admin edit
 * into a synchronised stampede, with the request peak growing in step with how many
 * people are on the site. Spreading the same requests over a few seconds costs a
 * viewer nothing — nobody perceives when a background refresh lands — and flattens
 * the peak into something the API can absorb.
 */
export function useLiveRefetch(
  refetch,
  events,
  { enabled = true, delay = 250, jitter = 3000, filter } = {}
) {
  const timer = useRef(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const filterRef = useRef(filter);
  filterRef.current = filter;

  useRealtimeEvent(
    events,
    (payload) => {
      if (filterRef.current && !filterRef.current(payload)) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => refetchRef.current?.(),
        delay + Math.random() * jitter
      );
    },
    { enabled }
  );

  useEffect(() => () => clearTimeout(timer.current), []);
}
