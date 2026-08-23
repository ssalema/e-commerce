const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { SUPPORTED_LANGUAGES } = require('../config/languages');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [60, 'Name cannot exceed 60 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/, 'Please provide a valid email address'],
    },
    phone: {
      type: String,
      trim: true,
      match: [/^[6-9]\d{9}$/, 'Please provide a valid 10 digit mobile number'],
    },
    password: {
      type: String,
      // Social accounts never set one — they authenticate through the provider.
      required: [
        function passwordRequired() {
          return !this.googleId;
        },
        'Password is required',
      ],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    googleId: { type: String, index: { unique: true, sparse: true } },
    authProviders: {
      type: [{ type: String, enum: ['local', 'google'] }],
      default: ['local'],
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
      index: true,
    },
    avatar: {
      url: String,
      // Only set for images we host — Google-hosted pictures have no asset of ours
      // to destroy, so `source` decides whether cleanup and refreshes apply.
      publicId: String,
      // No default: accounts that predate this field must not be mislabelled.
      source: { type: String, enum: ['upload', 'google'] },
    },
    /**
     * Where the account stands. Only `active` may sign in.
     *
     * The last two are one story rather than two states an admin picks between:
     * `deactivated` is where the account holder put it themselves, and
     * `reactivation-pending` is that same closure with a verified request sitting
     * in front of an approver. Neither is reachable from the admin status control
     * — staff block and unblock, the owner deactivates, and only an approval on a
     * reactivation request turns either back into `active`. Keeping those two
     * doors apart is what stops an account the owner closed being quietly reopened
     * from a screen that was only ever meant to lift a block.
     */
    status: {
      type: String,
      enum: ['active', 'blocked', 'deactivated', 'reactivation-pending'],
      default: 'active',
      index: true,
    },

    // Why the account was blocked, as typed by the admin who blocked it. Cleared on
    // reactivation so it always describes the current block, never an older one.
    blockedReason: { type: String, trim: true, maxlength: 200 },

    /**
     * Why and when the owner closed the account themselves.
     *
     * `reason` is stored as *text* rather than only as a pointer at the picklist
     * row, exactly as a cancelled order stores its cancellation reason: an admin
     * editing or retiring a reason must not rewrite what a closed account says it
     * closed for. `reasonId` rides along for reporting, and is simply absent when
     * the shopper wrote their own under "Other".
     *
     * `pending` holds the reason chosen at the first step while the one-time code
     * of the second is still outstanding. It lives on the document rather than in
     * the client's hands because the confirming request must not be able to
     * substitute a different reason for the one the code was issued against.
     */
    deactivation: {
      reason: { type: String, trim: true, maxlength: 300 },
      reasonId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeactivationReason' },
      isOther: Boolean,
      at: Date,
      pending: {
        reason: { type: String, trim: true, maxlength: 300 },
        reasonId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeactivationReason' },
        isOther: Boolean,
        at: Date,
      },
    },

    /**
     * The single-use link a deactivated account is mailed to start coming back.
     * Hashed and hidden for the same reason the password-reset token is: this one
     * opens a door that email/password and Google sign-in are both closed at.
     */
    reactivationToken: { type: String, select: false },
    reactivationExpires: { type: Date, select: false },
    /**
     * When the current link was first opened. Kept on the account rather than
     * derived at submit time because the two are minutes apart, and an admin
     * reading "emailed link opened" is being told a fact, not a re-stamp of the
     * moment the form was sent. Cleared with the token it belongs to.
     */
    reactivationLinkOpenedAt: { type: Date, select: false },
    /** When the pending request was submitted — mirrored for list and filter reads. */
    reactivationRequestedAt: Date,

    /**
     * Preferred interface language, so the choice follows the account across
     * devices. Deliberately without a default: "unset" is meaningful — it lets the
     * client adopt the language the visitor was already browsing in rather than
     * overwriting it with English the first time they sign in.
     *
     * NOT named `language`: this collection carries a text index (below), and
     * MongoDB reserves a top-level field of that exact name as the per-document
     * text-search language override. Storing `hi` or `ta` there makes every write
     * fail with "language override unsupported", because those are interface
     * languages, not stemmer languages. `en` would sneak through and mask the bug.
     */
    preferredLanguage: {
      type: String,
      enum: SUPPORTED_LANGUAGES,
    },

    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },

    /**
     * An address the owner has asked us to move the account to, still waiting on
     * the code we mailed to it.
     *
     * It lives here rather than in the client's hands for exactly the reason
     * `deactivation.pending` does: the confirming request must not be able to
     * substitute a different address for the one the code was issued against.
     * Whoever holds the code proves they read *that* inbox and no other.
     *
     * `email` is deliberately not unique — until the code is answered this is a
     * request, not an address the account owns, and two people may quite
     * legitimately be typing the same address into the form at the same moment.
     * The unique index on `email` is what settles it, and it settles it at the
     * only point that matters: the write that actually moves the account.
     */
    pendingEmail: {
      email: {
        type: String,
        lowercase: true,
        trim: true,
        match: [/^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/, 'Please provide a valid email address'],
      },
      requestedAt: Date,
    },

    /**
     * Whether this account still owes us a code before it may sign in.
     *
     * This — not `isEmailVerified` — is what the login path reads, and the two are
     * deliberately not the same question. `isEmailVerified` asks whether the address
     * has ever been proven, and it is false for every account that predates OTP
     * sign-up; gating login on it would lock those owners out of accounts they have
     * been using for months. This flag is only ever set by a registration that was
     * actually handed a code, so nobody is asked for one they were never sent.
     */
    emailVerificationPending: { type: Boolean, default: false },

    /**
     * The live one-time code, or nothing. Only ever one per account: asking for a
     * new code retires the old one, so a mailbox holding five of our emails still
     * has exactly one code that opens the account — the last one.
     *
     * `codeHash` is hidden for the same reason a password is. `attempts` and
     * `resends` are the two budgets that make a six-digit secret safe: one caps
     * guessing, the other caps how much mail one pending sign-up can send.
     */
    otp: {
      codeHash: { type: String, select: false },
      channel: { type: String, enum: ['email', 'sms'] },
      purpose: {
        type: String,
        enum: [
          'email-verification',
          'email-change',
          'account-deactivation',
          'account-reactivation',
        ],
      },
      expiresAt: Date,
      attempts: { type: Number, default: 0 },
      sentAt: Date,
      resends: { type: Number, default: 0 },
    },

    /**
     * Consecutive failed password attempts, and how long the account stays closed
     * to them once that runs out. Both are hidden: whether an account is currently
     * locked is exactly what an attacker probing for valid emails wants to learn.
     */
    loginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, select: false },

    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    passwordChangedAt: { type: Date, select: false },

    lastLoginAt: Date,
    /**
     * Refresh tokens used to live here as a capped array of hashes. They now live in
     * the `sessions` collection, one document per signed-in device, which is what
     * lets the account holder see and revoke each one individually — an array of
     * opaque hashes could only ever be dropped wholesale.
     */
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret) {
        delete ret.password;
        delete ret.otp;
        delete ret.passwordResetToken;
        delete ret.passwordResetExpires;
        delete ret.reactivationToken;
        delete ret.reactivationExpires;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

userSchema.index({ name: 'text', email: 'text' });
userSchema.index({ createdAt: -1 });

/**
 * Whether the account can sign in with email + password. `password` is select:false,
 * so the provider list — not the field — is the reliable signal, and every write that
 * sets a password adds 'local' to keep the two in step.
 */
userSchema.virtual('hasPassword').get(function hasPassword() {
  return this.authProviders?.includes('local') ?? false;
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, env.bcryptRounds);
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000); // guard token race
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return false; // Google-only account: nothing to compare against
  return bcrypt.compare(candidate, this.password);
};

/**
 * A hash of nothing anyone can log in with, compared against when the submitted
 * email matches no account. Without it a miss returns as fast as the lookup while
 * a hit pays for bcrypt, and that difference alone tells an attacker which
 * addresses are registered — the thing every message in the login path is
 * carefully worded to avoid revealing.
 */
const DUMMY_HASH = bcrypt.hashSync('login-timing-equaliser', env.bcryptRounds);

userSchema.statics.burnPasswordCompare = function burnPasswordCompare(candidate) {
  return bcrypt.compare(String(candidate ?? ''), DUMMY_HASH);
};

/** Whether the account is currently closed to password sign-in. */
userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
});

/**
 * Takes one guess from the account's allowance, before the password is compared.
 *
 * Spent first and spent with `$inc`, for the reason `verifyEmailOtp` gives at
 * length: a count computed from the document this request loaded is a count that
 * every guess arriving alongside it overwrites, and a count that is only correct
 * *after* the comparison is one that lets a whole burst be compared while the
 * allowance still looks untouched. Sixty parallel guesses used to cost one.
 *
 * @returns {Promise<{attempts: number, remaining: number, overBudget: boolean,
 *   lockUntil: Date|null}>} `attempts` is this caller's own place in the queue —
 *   its guess is the Nth against the account. `overBudget` marks the ones that
 *   arrived after the allowance was gone; those must not be compared at all.
 *   `lockUntil` is a live lock somebody else's guess put in place meanwhile.
 */
userSchema.methods.spendLoginAttempt = async function spendLoginAttempt() {
  const { maxAttempts } = env.login;
  const projection = { loginAttempts: 1, lockUntil: 1 };

  // A lock that has already run out is not carried forward: the next wrong
  // password starts a fresh count rather than re-locking on the old total. The
  // filter names the expired lock, so exactly one caller performs the reset and
  // the rest fall through to counting normally.
  if (this.lockUntil && this.lockUntil.getTime() <= Date.now()) {
    const cleared = await this.constructor.findOneAndUpdate(
      { _id: this._id, lockUntil: this.lockUntil },
      { $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } },
      { new: true, projection }
    );
    if (cleared) {
      this.loginAttempts = 1;
      this.lockUntil = undefined;
      return { attempts: 1, remaining: maxAttempts - 1, overBudget: false, lockUntil: null };
    }
  }

  const spent = await this.constructor.findOneAndUpdate(
    { _id: this._id },
    { $inc: { loginAttempts: 1 } },
    { new: true, projection }
  );

  const attempts = spent?.loginAttempts || 1;
  const lockUntil = spent?.lockUntil && spent.lockUntil.getTime() > Date.now() ? spent.lockUntil : null;
  this.loginAttempts = attempts;

  return {
    attempts,
    remaining: Math.max(0, maxAttempts - attempts),
    // Strictly greater: the guess that lands *on* the ceiling is the last one
    // this account allows, and it is the one that trips the lock below.
    overBudget: attempts > maxAttempts,
    lockUntil,
  };
};

/**
 * Closes the account for `lockMinutes` once the allowance is spent.
 *
 * Written only if no window is already in place, so a burst that all crosses the
 * line together locks once rather than each guess pushing the expiry further out.
 *
 * @returns {Promise<{justLocked: boolean, lockUntil: Date}>} `justLocked` is true
 *   for the single caller whose write landed — the only one that should email the
 *   owner about it.
 */
userSchema.methods.applyLoginLock = async function applyLoginLock() {
  const { lockMinutes } = env.login;
  const lockUntil = new Date(Date.now() + lockMinutes * 60 * 1000);

  const claimed = await this.constructor.findOneAndUpdate(
    { _id: this._id, $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lte: new Date() } }] },
    { $set: { lockUntil } },
    { new: true, projection: { lockUntil: 1 } }
  );

  if (claimed) {
    this.lockUntil = claimed.lockUntil;
    return { justLocked: true, lockUntil: claimed.lockUntil };
  }

  // Somebody else's guess locked it a moment ago; adopt their window.
  const current = await this.constructor.findById(this._id).select('+lockUntil').lean();
  return { justLocked: false, lockUntil: current?.lockUntil || lockUntil };
};

/** Clears the count — on a correct password, and on a completed password reset. */
userSchema.statics.clearLoginAttempts = function clearLoginAttempts(userId) {
  return this.updateOne({ _id: userId }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } });
};

/** True when the password changed after the JWT was issued. */
userSchema.methods.passwordChangedAfter = function passwordChangedAfter(jwtIssuedAtSeconds) {
  if (!this.passwordChangedAt) return false;
  return Math.floor(this.passwordChangedAt.getTime() / 1000) > jwtIssuedAtSeconds;
};

/**
 * Records that this account now has a password of its own. Google sign-in stays
 * available — the two providers coexist, and the Google avatar is left untouched.
 */
userSchema.methods.enableLocalLogin = function enableLocalLogin() {
  if (!this.authProviders.includes('local')) this.authProviders.push('local');
};

/* ------------------------------------------------------------------ *
 * Email verification — the one-time code a new sign-up types back
 * ------------------------------------------------------------------ */

/**
 * Only the digest is stored, exactly as for a password reset token: a database
 * dump must not hand over live codes. SHA-256 rather than bcrypt because this
 * secret defends itself by expiring in minutes and answering five guesses, not by
 * being expensive to hash — and the login path already pays for one bcrypt.
 */
const hashOtp = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * How long a re-activation link stays good. Stated once because three places
 * depend on agreeing about it: the mint, the email that prints the window, and
 * the cooldown that works out how long ago a link was sent.
 */
const REACTIVATION_TTL_MINUTES = 10;

/**
 * Mints a fresh code and retires whatever came before it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.resend] Counts against the resend budget. A first code
 *   for a sign-up starts that budget at zero; every later one spends from it.
 * @param {string} [opts.purpose] What answering this code will do. Recorded on
 *   the code and checked when it is spent, so a code minted to confirm a
 *   deactivation cannot be typed into the sign-up screen — or the reverse. The
 *   account only ever holds one code, and that code is only good for the one
 *   thing it was asked for.
 * @returns {string} The plain code — emailed, never stored.
 */
userSchema.methods.createEmailOtp = function createEmailOtp({
  resend = false,
  purpose = 'email-verification',
} = {}) {
  const { length, expiryMinutes } = env.otp;

  // randomInt, not Math.random: the code is a credential, and it is short enough
  // that a predictable generator would be guessable outright. Zero-padded, so
  // `000123` stays six digits rather than becoming three.
  const code = String(crypto.randomInt(0, 10 ** length)).padStart(length, '0');

  this.otp = {
    codeHash: hashOtp(code),
    channel: 'email',
    purpose,
    expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
    // A new code gets a clean attempt budget; that is what makes "request a new
    // code" the honest way out of having burnt the guesses on the old one.
    attempts: 0,
    sentAt: new Date(),
    resends: resend ? (this.otp?.resends || 0) + 1 : 0,
  };

  return code;
};

/** Seconds still to wait before another code may be asked for; 0 once it may. */
userSchema.methods.otpResendWaitSeconds = function otpResendWaitSeconds() {
  const sentAt = this.otp?.sentAt;
  if (!sentAt) return 0;
  const elapsed = (Date.now() - sentAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(env.otp.resendCooldownSeconds - elapsed));
};

/** Whether this sign-up has already spent its allowance of codes. */
userSchema.methods.otpResendsExhausted = function otpResendsExhausted() {
  return (this.otp?.resends || 0) >= env.otp.maxResends;
};

/**
 * Checks a submitted code and spends one of the account's guesses.
 *
 * Requires `otp.codeHash`, which is `select: false` — a document loaded without it
 * would compare against nothing and reject every code, so callers must ask for it
 * by name. The attempt is recorded atomically and *before* the comparison: an
 * attempt that is not spent until after the code has been judged is an attempt
 * that parallel guesses can ride over.
 *
 * @param {string} [purpose] What the caller is spending the code on. A code
 *   minted for something else answers 'no-code' — the same dead end as no code
 *   at all, because that is exactly what this caller has: the account's one
 *   outstanding code belongs to a different flow.
 * @returns {Promise<{ok: boolean, reason?: 'no-code'|'expired'|'exhausted'|'mismatch',
 *   remaining: number}>}
 */
userSchema.methods.verifyEmailOtp = async function verifyEmailOtp(
  code,
  purpose = 'email-verification'
) {
  const { maxAttempts } = env.otp;
  const otp = this.otp;

  if (!otp?.codeHash || !otp.expiresAt) return { ok: false, reason: 'no-code', remaining: 0 };
  // Codes written before purposes existed carry none, and every one of those is
  // an email verification — the only flow there was.
  if ((otp.purpose || 'email-verification') !== purpose) {
    return { ok: false, reason: 'no-code', remaining: 0 };
  }
  if (otp.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired', remaining: 0 };
  // A cheap early out on a budget already known to be spent. It is not what
  // enforces the ceiling — the counter read below is — because this one reads a
  // document that was loaded before any of the guesses racing this one landed.
  if ((otp.attempts || 0) >= maxAttempts) return { ok: false, reason: 'exhausted', remaining: 0 };

  /**
   * The guess is spent before it is judged, and spent with `$inc`.
   *
   * Both halves of that matter. `$inc` because a read-then-`$set` loses under
   * concurrency — guesses arriving together all read the same `attempts` and
   * overwrite one another, so a burst of fifty costs one attempt between them.
   * And *before*, because a counter that is only accurate after the comparison
   * still lets all fifty be compared against the code: every one of them clears
   * the pre-check above while the budget looks untouched. Spending first is what
   * makes the ceiling count guesses rather than count the ones that were slow.
   *
   * The filter names the code being guessed at, so an increment cannot land on a
   * code that was rotated or spent in the meantime — that request is guessing at
   * something the account no longer holds, which is the same dead end as no code.
   */
  const spent = await this.constructor.findOneAndUpdate(
    { _id: this._id, 'otp.codeHash': otp.codeHash },
    { $inc: { 'otp.attempts': 1 } },
    { new: true, projection: { 'otp.attempts': 1 } }
  );

  if (!spent) return { ok: false, reason: 'no-code', remaining: 0 };

  const attempts = spent.otp?.attempts || 0;
  this.otp.attempts = attempts;

  // Whoever's increment pushed past the ceiling loses, correct code or not: the
  // guess that takes the budget over is a guess there was no budget left for.
  if (attempts > maxAttempts) return { ok: false, reason: 'exhausted', remaining: 0 };

  const submitted = hashOtp(String(code || '').trim());
  // Constant time, so the response cannot be timed digit by digit. Both sides are
  // fixed-length hex digests, which is what makes the lengths safe to assume.
  const match = crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(otp.codeHash));

  if (match) return { ok: true, remaining: maxAttempts - attempts };

  return { ok: false, reason: 'mismatch', remaining: Math.max(0, maxAttempts - attempts) };
};

/**
 * Records that the address is proven: the code is spent and the gate comes down.
 *
 * Written straight through rather than via `save()`, because the code has to be
 * *gone* — assigning `undefined` to a nested path leaves the stored subdocument
 * exactly where it was, and a spent code that survives in the database is a spent
 * code that can be replayed. `$unset` is the only thing that removes it.
 */
userSchema.methods.markEmailVerified = async function markEmailVerified() {
  await this.constructor.updateOne(
    { _id: this._id },
    { $set: { isEmailVerified: true, emailVerificationPending: false }, $unset: { otp: 1 } }
  );
  this.isEmailVerified = true;
  this.emailVerificationPending = false;
  this.otp = undefined;
};

/**
 * Spends the outstanding code without marking anything verified.
 *
 * `markEmailVerified` is the sign-up's version of this and does two jobs at
 * once; the deactivation and reactivation flows only ever want the first, and
 * for the same reason it gives: a code that survives in the database is a code
 * that can be replayed, and only `$unset` actually removes it.
 */
userSchema.methods.clearOtp = async function clearOtp() {
  await this.constructor.updateOne({ _id: this._id }, { $unset: { otp: 1 } });
  this.otp = undefined;
};

/**
 * Mints the single-use link that starts a reactivation, exactly as the password
 * reset token is minted: the raw value is emailed and only its digest is kept,
 * so a database dump is not a folder of live keys to closed accounts.
 *
 * Ten minutes, matching the reset link. A reactivation link is the one
 * credential a deactivated account has, and the person holding it is by
 * definition already reading the inbox it was sent to — there is nothing for a
 * longer window to buy.
 */
userSchema.methods.createReactivationToken = function createReactivationToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  this.reactivationToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.reactivationExpires = new Date(Date.now() + REACTIVATION_TTL_MINUTES * 60 * 1000);
  return rawToken; // emailed to the user; only the hash is stored
};

/** The digest a submitted reactivation token has to match. */
userSchema.statics.hashReactivationToken = (rawToken) =>
  crypto.createHash('sha256').update(String(rawToken)).digest('hex');

/**
 * When a link with this expiry was sent. The mint time is not stored separately —
 * the window is fixed, so the expiry carries it — and the caller that needs it is
 * the one deciding whether a second press is soon enough to be the same request.
 */
userSchema.statics.reactivationLinkSentAt = (expiresAt) =>
  (expiresAt ? new Date(expiresAt.getTime() - REACTIVATION_TTL_MINUTES * 60 * 1000) : null);

userSchema.statics.REACTIVATION_TTL_MINUTES = REACTIVATION_TTL_MINUTES;

userSchema.methods.createPasswordResetToken = function createPasswordResetToken() {
  const rawToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  this.passwordResetExpires = new Date(Date.now() + 10 * 60 * 1000);
  return rawToken; // emailed to the user; only the hash is stored
};

module.exports = mongoose.model('User', userSchema);
