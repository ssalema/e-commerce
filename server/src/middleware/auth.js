const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { inactiveAccountError } = require('../utils/accountStatus');
const asyncHandler = require('../utils/asyncHandler');
const User = require('../models/User');
const sessionService = require('../services/session.service');

/**
 * The access token, and only from the Authorization header.
 *
 * There is deliberately no cookie fallback. Nothing in this API sets an
 * `accessToken` cookie, so reading one only ever mattered if something started
 * to — and the moment it did, every authenticated route would have become
 * forgeable from another site: the refresh cookie is `SameSite=None` in
 * production and there is no CSRF token anywhere, because auth is supposed to
 * live in a header a cross-site form cannot set. Keeping the read out is what
 * makes that assumption hold. The refresh cookie stays a cookie; it is exchanged
 * at `/auth/refresh` and is useless on its own.
 */
function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Wording that tells the user what actually happened to their session. */
const SESSION_GONE = {
  revoked: 'You were signed out from this device',
  expired: 'Session expired, please log in again',
  inactive: 'Session expired after a long period of inactivity',
  unknown: 'Session is no longer valid, please log in again',
};

/** Requires a valid access token and an active user. */
const protect = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw ApiError.unauthorized('Please log in to continue');

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwt.accessSecret);
  } catch (err) {
    throw ApiError.unauthorized(
      err.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid token'
    );
  }

  /*
   * The user and the session are two independent reads of two collections, and
   * nothing below needs one to issue the other — so they go out together. Run in
   * sequence they were the latency floor of every authenticated request in the
   * API: two round trips to the cluster before a handler saw the request at all.
   *
   * `touch` is safe to have already run when the user turns out to be missing or
   * closed: it is a read plus a fire-and-forget heartbeat on a session that is
   * about to be refused anyway, and the refusal below is unchanged.
   */
  const [user, session] = await Promise.all([
    User.findById(decoded.sub).select('+passwordChangedAt'),
    decoded.sid ? sessionService.touch(decoded.sid) : null,
  ]);

  if (!user) throw ApiError.unauthorized('This account no longer exists');

  /**
   * Every closed state, not just the blocked one.
   *
   * This is the check that makes deactivation hold against a direct API call: the
   * sessions are revoked the instant an account closes, but an access token
   * already in flight is a bearer credential nobody can recall, and it stays
   * signable for up to its fifteen minutes. Reading the live status on every
   * request is what closes that window to zero.
   */
  const closed = inactiveAccountError(user);
  if (closed) throw closed;
  if (user.passwordChangedAfter(decoded.iat)) {
    throw ApiError.unauthorized('Password was changed recently, please log in again');
  }

  /**
   * The session behind this token has to still be live, and this is also where its
   * "last active" stamp is kept current. Revoking a device therefore takes effect on
   * its next request instead of whenever its access token would have lapsed.
   *
   * Tokens minted before sessions existed carry no `sid`. They are honoured until
   * they expire on their own — no more than the access-token lifetime — so shipping
   * this does not sign the whole user base out.
   */
  if (decoded.sid) {
    if (!session) {
      throw ApiError.unauthorized(SESSION_GONE[await sessionService.explain(decoded.sid)]);
    }
    req.sessionId = decoded.sid;
    req.session = session;
  }

  req.user = user;
  next();
});

/** Attaches req.user when a token is present, but never rejects. */
const optionalAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret);

    /*
     * This sits in front of every cached catalogue route, so its cost is paid on
     * the busiest reads in the API. Two things keep it small:
     *
     *  - the two collections are read in parallel rather than one after the other;
     *  - only what a public controller actually consults is fetched. Every route
     *    behind this middleware reads `_id`, `role` and nothing else (the account
     *    screens that want the whole document run under `protect`), so this is a
     *    projected, lean read instead of a full hydrated user.
     *
     * A revoked device must not keep browsing as its old owner — a signed-out phone
     * would otherwise still see that account's prices and cart hints — which is what
     * the session half is for.
     */
    const [user, session] = await Promise.all([
      User.findById(decoded.sub).select('role status').lean(),
      decoded.sid ? sessionService.touch(decoded.sid) : null,
    ]);

    if (!user || user.status !== 'active') return next();
    if (decoded.sid && !session) return next();

    req.user = user;
    req.sessionId = decoded.sid;
  } catch {
    /* anonymous request — carry on */
  }
  next();
});

const restrictTo =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
    next();
  };

module.exports = { protect, optionalAuth, adminOnly: restrictTo('admin') };
