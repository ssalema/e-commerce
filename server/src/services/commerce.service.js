const { Setting } = require('../models');
const logger = require('../utils/logger');

/**
 * The shop's commerce rules — free-delivery bar, flat shipping rate, return
 * threshold — read from the admin's Organization settings rather than from .env.
 *
 * Every cart serialisation and every checkout needs these, and most of the code
 * that needs them is synchronous (`serialiseCart` is called from a dozen places
 * and returns a plain object). So rather than turning that whole path async for
 * three numbers that change a few times a year, the snapshot is held here:
 *
 *   - primed once at boot, before the first request is served;
 *   - replaced on the spot whenever an admin saves the settings;
 *   - refreshed lazily in the background once it is older than the TTL, which is
 *     the backstop for a second process saving the document.
 *
 * `get()` is therefore always synchronous and always answers with real values —
 * the DEFAULTS below only stand in for the window between process start and the
 * first successful read, and they are the same numbers the schema defaults to.
 */
const DEFAULTS = Object.freeze({
  freeShippingThreshold: 499,
  shippingFlatRate: 49,
  returnWindowDays: 7,
});

/** Long, because a save refreshes this explicitly; the timer is only a safety net. */
const TTL_MS = 5 * 60 * 1000;

let snapshot = { ...DEFAULTS };
let loadedAt = 0;
/** The in-flight refresh, so a burst of requests triggers one read, not twenty. */
let inFlight = null;

/** Coerces one leaf, falling back to its default rather than letting NaN reach a price. */
const read = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const toSnapshot = (commerce = {}) => ({
  freeShippingThreshold: read(commerce.freeShippingThreshold, DEFAULTS.freeShippingThreshold),
  shippingFlatRate: read(commerce.shippingFlatRate, DEFAULTS.shippingFlatRate),
  returnWindowDays: read(commerce.returnWindowDays, DEFAULTS.returnWindowDays),
});

/** Re-reads the settings document and adopts its commerce block. */
async function refresh() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const settings = await Setting.getSingleton();
      snapshot = toSnapshot(settings?.commerce);
      loadedAt = Date.now();
    } catch (err) {
      // A failed read must never take a checkout down with it — the last good
      // snapshot (or the defaults) keeps serving.
      logger.warn(`Could not refresh commerce settings: ${err.message}`);
    } finally {
      inFlight = null;
    }
    return snapshot;
  })();

  return inFlight;
}

/**
 * Adopts a settings document the caller already has in hand — what the settings
 * controller calls after a save, so the very next request prices with the new
 * numbers rather than waiting on a round trip.
 */
function adopt(settings) {
  snapshot = toSnapshot(settings?.commerce);
  loadedAt = Date.now();
  return snapshot;
}

/**
 * The current rules. Synchronous by design (see the note above); a stale snapshot
 * kicks off a background refresh and answers with what it has, so no request ever
 * waits on this.
 */
function get() {
  if (Date.now() - loadedAt > TTL_MS) refresh();
  return snapshot;
}

module.exports = { get, refresh, adopt, prime: refresh, DEFAULTS };
