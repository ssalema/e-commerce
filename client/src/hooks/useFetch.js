import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Small data-fetching hook with loading/error state and a refetch handle.
 * Guards against setting state after unmount and against out-of-order responses.
 *
 * The active language is an implicit dependency of every request: the server
 * returns catalogue copy in whatever language the client asked for, so switching
 * language makes the data on screen stale. Handling it here means no caller has to
 * remember to add it, and no page can quietly miss it.
 *
 * Pass a `cacheKey` to opt this call into the shared cache described below. Without
 * one the hook behaves exactly as it always has: every mount is a fresh request.
 *
 * @param {() => Promise<any>} fetcher
 * @param {Array} deps      re-runs when these change
 * @param {{ enabled?: boolean, initialData?: any, cacheKey?: string|Array, staleMs?: number }} [options]
 */

/* ------------------------------------------------------------------ *
 * Shared response cache
 * ------------------------------------------------------------------ *
 *
 * Every screen held its data for exactly as long as it was mounted. Going from the
 * home page into a product and pressing back re-requested the whole home feed, the
 * banners and the categories, and the shopper watched the skeletons again — for data
 * the browser had been handed seconds earlier. Back-navigation is the single most
 * common movement on a storefront, and it was the slowest.
 *
 * Two things are kept here, and they solve two different problems:
 *
 *   the entry     lets a remount paint immediately from the last known answer and
 *                 revalidate behind the paint, so returning to a page is instant and
 *                 still ends up current.
 *   the in-flight promise
 *                 collapses concurrent callers of the same key into one request.
 *                 That matters most during boot, when several components ask for the
 *                 same taxonomy at once, and again when a socket event wakes more
 *                 than one subscriber.
 *
 * This is a cache of *responses in this tab*, not a replacement for the HTTP one: the
 * server's `Cache-Control` still decides whether a revalidation costs a round trip or
 * a 304. It is deliberately small, in-memory and per-tab. Nothing here survives a
 * reload, and nothing here is a source of truth — a stale entry is always followed by
 * a real request.
 */

/** Entry ceiling. Plain FIFO eviction: this bounds memory, it is not a hit strategy. */
const MAX_ENTRIES = 60;

/** @type {Map<string, {data: any, at: number}>} */
const cache = new Map();
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

function readCache(key) {
  return key ? cache.get(key) : undefined;
}

function writeCache(key, data) {
  if (!key) return;
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
    // Nothing is left to replay onto, so the journal goes with the entry.
    edits.delete(oldest);
  }
  cache.set(key, { data, at: Date.now() });
}

/**
 * Drops cached responses. Called on sign-out, where continuing to serve the previous
 * shopper's personalised feed to the next person at this browser would be wrong.
 *
 * With no argument it empties everything; with a string it drops every key that starts
 * with it, so a caller can clear one family of requests by prefix.
 */
export function clearFetchCache(prefix) {
  if (!prefix) {
    cache.clear();
    inFlight.clear();
    edits.clear();
    return;
  }
  [...cache.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => cache.delete(k));
  [...edits.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => edits.delete(k));
}

/* ------------------------------------------------------------------ *
 * Local edits
 * ------------------------------------------------------------------ *
 *
 * A response can be older than the screen it is about to replace. The stock patches
 * are the case that matters: a request goes out, a sale happens while it is in
 * flight, the broadcast patches the card to sold out — and then the response, which
 * was read *before* the sale, lands and puts the old count back, on screen and in
 * the cache. The shopper is then shown a buy box for something that has gone, and
 * nothing further is coming to correct it.
 *
 * So every local edit is journalled per key, and a response replays whatever was
 * applied while it was in flight. The reducers are pure and idempotent (the payload
 * carries absolute stock, not a delta), which is what makes replaying them onto
 * fresher data safe: the answer is the server's row with the sale still applied.
 */

/** @type {Map<string, {version: number, log: Array<{version: number, update: (prev: any) => any}>}>} */
const edits = new Map();

/** Journal depth per key. Only edits landing during one request are ever replayed. */
const MAX_EDITS = 25;

const editVersion = (key) => (key ? edits.get(key)?.version || 0 : 0);

function recordEdit(key, update) {
  if (!key) return;
  const entry = edits.get(key) || { version: 0, log: [] };
  entry.version += 1;
  entry.log.push({ version: entry.version, update });
  if (entry.log.length > MAX_EDITS) entry.log.shift();
  edits.set(key, entry);
}

/** Re-applies the edits journalled for `key` since `since`. */
function replayEdits(key, value, since) {
  const entry = key && edits.get(key);
  if (!entry || entry.version === since) return value;
  return entry.log
    .filter((e) => e.version > since)
    .reduce((acc, e) => e.update(acc), value);
}

/**
 * Applies a reducer to every cached response, whether or not anything is mounted on
 * it.
 *
 * A page that is not on screen has no subscriber, so the broadcasts that arrive while
 * a shopper is off looking at a product reach nothing — and the entry they would have
 * corrected is what back-navigation paints, without revalidating, for as long as it
 * counts as fresh. This is the one path that reaches those entries.
 *
 * `reduce(data)` must return the same object when it changes nothing, so untouched
 * entries keep their identity and no cached screen is needlessly rebuilt.
 */
export function patchFetchCache(reduce) {
  cache.forEach((entry, key) => {
    const next = reduce(entry.data);
    if (next === entry.data) return;
    cache.set(key, { data: next, at: entry.at });
    // Journalled as well, so a request already in flight for this key does not undo
    // it on arrival — the same protection a mounted screen's own patch gets.
    recordEdit(key, reduce);
  });
}

const normaliseKey = (key) => {
  if (!key) return null;
  return Array.isArray(key) ? key.join('|') : String(key);
};

export default function useFetch(
  fetcher,
  deps = [],
  { enabled = true, initialData = null, cacheKey, staleMs = 30000 } = {}
) {
  const { i18n } = useTranslation();

  /*
   * The language is part of the key for the same reason it is part of the dependency
   * list: the same URL returns different copy in each one, and a Tamil shopper must
   * never be painted from the Hindi entry.
   */
  const key = cacheKey ? `${i18n.language}|${normaliseKey(cacheKey)}` : null;

  // Seeded from the cache so the very first render of a remounted page already has
  // its data, rather than painting a skeleton and replacing it a frame later.
  const seed = readCache(key);
  const [data, setData] = useState(seed ? seed.data : initialData);
  const [loading, setLoading] = useState(enabled && !seed);
  const [error, setError] = useState(null);

  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  /**
   * @param {{ force?: boolean }} [options] `force` skips a fresh cache entry, which is
   *        what a manual retry and a socket-driven refetch both want: they are asking
   *        precisely because they believe what is held is out of date.
   */
  const run = useCallback(
    async ({ force = false } = {}) => {
      if (!enabled) {
        setLoading(false);
        return;
      }

      const hit = readCache(key);
      const fresh = hit && Date.now() - hit.at < staleMs;

      if (hit) {
        // Paint what we have either way. A stale entry is still a far better first
        // frame than a skeleton, and the request below replaces it in place.
        setData(hit.data);
        setError(null);
      }
      if (fresh && !force) {
        setLoading(false);
        return;
      }

      const id = ++requestId.current;
      // Only an empty screen shows a loading state. Revalidating behind data already
      // on screen must not blank it out.
      setLoading(!hit);
      setError(null);

      // Where the journal stands as this request goes out. Anything applied while it
      // is in flight is replayed onto the answer rather than being overwritten by it.
      const editsAt = editVersion(key);

      try {
        /*
         * Two components asking for the same thing at the same moment share one
         * request.
         *
         * A forced call does not join one, though. `force` is what a socket event and
         * a manual retry both use, and they are asking *because* something changed —
         * so an in-flight request issued before that change is precisely the answer
         * they must not be given. Joining it returned pre-edit data and then stored it
         * as fresh, which hid the edit for the whole staleness window with no second
         * attempt on the way. The jitter in useLiveRefetch already spreads the
         * broadcast-driven calls, so little collapsing is given up here.
         */
        let promise = key && !force ? inFlight.get(key) : null;
        if (!promise) {
          promise = fetcherRef.current();
          if (key) {
            inFlight.set(key, promise);
            promise.finally(() => {
              if (inFlight.get(key) === promise) inFlight.delete(key);
            });
          }
        }

        const result = replayEdits(key, await promise, editsAt);
        writeCache(key, result);
        // A slower earlier request must not overwrite a newer response.
        if (mounted.current && id === requestId.current) setData(result);
      } catch (err) {
        if (mounted.current && id === requestId.current) setError(err);
      } finally {
        if (mounted.current && id === requestId.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, key, staleMs, i18n.language, ...deps]
  );

  useEffect(() => {
    run();
  }, [run]);

  /** Always a real request. Exposed as `refetch` so no caller has to know about the cache. */
  const refetch = useCallback(() => run({ force: true }), [run]);

  /**
   * A local edit — the stock patches applied from a socket broadcast, for one — has to
   * reach the cache too, or navigating away and back would resurrect the value the
   * event just corrected.
   *
   * It is journalled as well as written, so a request already in flight replays it
   * instead of landing on top of it. See the note on `edits` above.
   */
  const setCachedData = useCallback(
    (update) => {
      const reduce = typeof update === 'function' ? update : () => update;
      recordEdit(key, reduce);
      setData((prev) => {
        const next = reduce(prev);
        if (next !== prev) writeCache(key, next);
        return next;
      });
    },
    [key]
  );

  return { data, loading, error, refetch, setData: setCachedData };
}
