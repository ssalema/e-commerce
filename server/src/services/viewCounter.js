/**
 * Product view counts, buffered in memory and flushed on a timer.
 *
 * `GET /products/:idOrSlug` is the most-requested read in the shop, and it was issuing
 * a write on every single one of them — an unbatched `$inc` per page view, arriving at
 * the primary in step with traffic. That is the worst possible shape for a write: its
 * volume tracks reads, it competes with the order path for the same primary, and
 * nothing whatsoever depends on it being immediate. `viewCount` feeds the popularity
 * blend in recommendation.service, which is itself cached for a minute.
 *
 * So the increments are accumulated per product and written once per flush as a single
 * bulk operation. A thousand views of one product between flushes is one `$inc` of a
 * thousand instead of a thousand round trips.
 *
 * What this trades away is honest and small: views counted in the current window are
 * lost if the process dies, and in a multi-instance deployment each process keeps its
 * own tally until it flushes. Neither matters for a popularity signal — nobody audits
 * a view count, and the ranking it feeds is relative.
 */

const logger = require('../utils/logger');

/** How often the buffer is drained. Long enough to batch, short enough to stay current. */
const FLUSH_INTERVAL_MS = 30 * 1000;

/**
 * Ceiling on distinct products held between flushes. A crawler walking the whole
 * catalogue must not turn this into unbounded memory; past the ceiling the buffer is
 * flushed early rather than grown.
 */
const MAX_PENDING = 500;

/** @type {Map<string, number>} product id → views since the last flush. */
const pending = new Map();

let timer = null;
let ProductModel = null;

/**
 * The write a flush is currently waiting on, so `stop` can wait for it too.
 *
 * `record` starts a flush without awaiting it when the buffer fills, and the timer
 * starts one on its own schedule. Either can still be mid-`bulkWrite` when the
 * process is asked to shut down — and `stop` returning early puts `disconnectDB`
 * immediately after it, killing the connection under a write that was about to
 * succeed.
 */
let writing = Promise.resolve();

/** Late-required so this module can be loaded from a controller without a cycle. */
function model() {
  if (!ProductModel) ProductModel = require('../models').Product;
  return ProductModel;
}

/** Writes the buffer out. Safe to call at any time, including with nothing pending. */
async function flush() {
  if (!pending.size) return;

  // Swapped out before the await: views arriving during the write belong to the next
  // window, and must not be dropped by a `clear()` afterwards.
  const batch = [...pending.entries()];
  pending.clear();

  // Held so a shutdown mid-write waits for it rather than pulling the connection
  // out from under it. Chained, so overlapping flushes are all covered.
  writing = writing.then(async () => {
    try {
      await model().bulkWrite(
        batch.map(([id, views]) => ({
          updateOne: { filter: { _id: id }, update: { $inc: { viewCount: views } } },
        })),
        // These are independent counters; one failing row must not abandon the rest.
        { ordered: false }
      );
    } catch (err) {
      // A lost window of view counts is not worth surfacing, let alone retrying — the
      // next window overwrites the picture anyway.
      logger.warn(`View counter flush failed: ${err.message}`);
    }
  });

  await writing;
}

/** Records one view. Never awaited by a request, and never throws. */
function record(productId) {
  if (!productId) return;
  const key = String(productId);
  pending.set(key, (pending.get(key) || 0) + 1);
  if (pending.size >= MAX_PENDING) flush();
}

/**
 * Starts the flush timer. `unref` so it never holds the process open — shutdown
 * calls `stop`, which drains whatever is left first.
 */
function start() {
  if (timer) return;
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
  timer.unref();
}

/**
 * Stops the timer and writes out the final window — including any write a `record`
 * or a timer tick had already started, which is why `writing` is awaited even when
 * the buffer itself is empty.
 */
async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  await flush();
  await writing;
}

module.exports = { record, flush, start, stop };
