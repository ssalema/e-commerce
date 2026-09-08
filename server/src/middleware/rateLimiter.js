const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const message = (msg) => ({ success: false, message: msg });

/**
 * Broad ceiling for the whole API — an abuse backstop, not a capacity control.
 *
 * The number has to be read against what a real visit costs. One cold home page is
 * already six requests (session, settings, categories, banners, the feed, recently
 * viewed) before the shopper has clicked anything, and a browse-and-buy session runs
 * to several dozen. At 300 per fifteen minutes an ordinary afternoon of shopping
 * approached the ceiling on its own.
 *
 * The bucket is also per IP, and an IP is not a person: mobile carriers, offices,
 * schools and campus networks put hundreds of shoppers behind one address. Whoever
 * arrived last is the one shown an error, having done nothing.
 *
 * Raised to a level a determined shopper cannot reach by shopping, while still
 * refusing the volume a scraper needs to be worth running. GETs that the storefront
 * caches — see middleware/cacheControl — are the bulk of the traffic and the cheapest
 * to serve, so the tighter per-endpoint limiters below remain the real defence on
 * everything that costs something: credentials, verification codes, uploads and the
 * public forms.
 */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isProd ? 1500 : 5000,
  standardHeaders: true,
  legacyHeaders: false,
  /*
   * A preflight is the browser asking permission, not the app asking for data, and
   * spending a shopper's budget on it means a page can be refused for requests it
   * never made.
   */
  skip: (req) => req.method === 'OPTIONS',
  message: message('Too many requests, please try again in a few minutes'),
});

/** Credential endpoints get a much tighter budget to blunt brute force. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isProd ? 10 : 200,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many attempts. Please try again after 15 minutes'),
});

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 5 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many password reset requests. Please try again later'),
});

/**
 * Verification codes: both the guessing and the asking.
 *
 * A six-digit code is narrow enough that the per-account attempt counter is the
 * real defence; this is what stops the same attacker walking that counter across
 * a list of addresses from one machine, and what keeps "resend" from becoming a
 * button that mails somebody else's inbox on demand.
 */
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.isProd ? 15 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Too many verification attempts. Please try again in a few minutes'),
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: env.isProd ? 60 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('Upload limit reached, please wait a few minutes'),
});

/**
 * Public, unauthenticated forms (contact us, job applications). Generous enough for
 * a genuine visitor who mistypes an email, tight enough that the inbox cannot be
 * flooded from one address.
 */
const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.isProd ? 8 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: message('You have sent several messages already. Please try again later.'),
});

module.exports = {
  apiLimiter,
  authLimiter,
  otpLimiter,
  passwordResetLimiter,
  uploadLimiter,
  publicFormLimiter,
};
