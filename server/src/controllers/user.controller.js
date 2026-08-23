const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendSuccess, paginationMeta } = require('../utils/apiResponse');
// Shared with the auth controller: one wording and one set of tags for every
// screen that takes a six-digit answer, whichever flow asked for it.
const { otpError } = require('../utils/otpError');
const env = require('../config/env');
const {
  User,
  Order,
  DeactivationReason,
  ReactivationRequest,
  Cart,
  Wishlist,
} = require('../models');
const { uploadBuffer, destroyAsset } = require('../config/cloudinary');
const sessionService = require('../services/session.service');
const mailService = require('../services/mail.service');
const audit = require('../services/accountAudit.service');
const broadcast = require('../realtime/broadcast');
const logger = require('../utils/logger');
const { isSelfDeactivated } = require('../utils/accountStatus');
const { OPEN_STATUSES } = require('../models/Order');

/* ---------------- Self service ---------------- */

/** PATCH /users/me — the avatar has its own routes so no raw image URL is trusted here. */
exports.updateProfile = asyncHandler(async (req, res) => {
  const allowed = ['name', 'phone'];
  const payload = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => allowed.includes(key))
  );

  const user = await User.findByIdAndUpdate(req.user._id, payload, {
    new: true,
    runValidators: true,
  });

  broadcast.profileUpdated(user._id, user);
  broadcast.userChanged('updated', user);

  return sendSuccess(res, { message: 'Profile updated', data: { user } });
});

/**
 * PATCH /users/me/language — its own route because it is written on a click, not a
 * form submit, and must not drag the rest of the profile payload along with it.
 */
exports.updateLanguage = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.user._id,
    {
      // Stored as `preferredLanguage` — see the note on the schema field.
      $set: { preferredLanguage: req.body.language },
      // Accounts touched before that rename carry a stray top-level `language`.
      // It is inert now, but it is the field MongoDB reserves for text search, so
      // clear it as each user passes through rather than leaving a live landmine.
      $unset: { language: '' },
    },
    { new: true, runValidators: true }
  );

  // Other tabs and devices on this account follow along without a refresh.
  broadcast.profileUpdated(user._id, user);

  return sendSuccess(res, { message: 'Language preference saved', data: { user } });
});

/* ---------------- Changing the address the account lives at ---------------- *
 *
 * Three calls, and the shape is the deactivation flow's on purpose: the request
 * earns a code, the code performs the change, and a third call throws the whole
 * thing away. What differs is where the code is sent — to the address being
 * *claimed*, not the one on the account — because that is the only thing the
 * code can honestly prove, and the only thing worth proving here.
 *
 * The address itself is written to `pendingEmail` rather than handed back to the
 * client to return with the code, for exactly the reason the deactivation reason
 * is: the confirming request must not be able to substitute a different address
 * for the one the code was issued against. Otherwise a code mailed to an address
 * the caller owns would move the account to one they do not.
 *
 * Nothing in here touches the password, `passwordChangedAt` or the session rows.
 * That is deliberate and it is what "the account moved" means as opposed to "the
 * account was replaced": the same password still signs in, at the new address,
 * and every device that was signed in stays signed in.
 */

const EMAIL_CHANGE_PURPOSE = 'email-change';

/**
 * The resend budget, spent only by an actual resend.
 *
 * Lifted out because both the deactivation flow and this one need the same two
 * refusals in the same order, and they are the pair that stops "send me a code"
 * from being a button that mails an address on demand: the cooldown paces one
 * request, the ceiling caps the whole run.
 */
function requireResendAllowance(user) {
  const wait = user.otpResendWaitSeconds();
  if (wait > 0) {
    throw new ApiError(429, `Please wait ${wait} second(s) before asking for a new code.`, {
      code: 'OTP_COOLDOWN',
    });
  }
  if (user.otpResendsExhausted()) {
    throw new ApiError(
      429,
      'You have requested several codes already. Please try again in a little while.',
      { code: 'OTP_RESEND_LIMIT' }
    );
  }
}

/**
 * POST /users/me/email/change — the new address, and the code it earns.
 *
 * The address is checked against the collection here as well as by the unique
 * index later, because the two answer different questions at different moments:
 * this one is the courtesy that stops us mailing a code towards an address that
 * could never be accepted, and the index is the guarantee that no two accounts
 * ever end up on one address whatever raced whom.
 *
 * Answering "that address is already in use" does disclose that an account
 * exists on it. That is the same thing the sign-up form answers, to a caller who
 * is by then signed in to an account of their own — and the alternative is
 * mailing a stranger a code for a change that will be refused at the last step
 * anyway, which discloses the same fact to a wider audience.
 */
exports.requestEmailChange = asyncHandler(async (req, res) => {
  const next = String(req.body.email).trim().toLowerCase();
  const user = await User.findById(req.user._id).select('+otp.codeHash');

  if (next === user.email) {
    throw new ApiError(400, 'That is already the email address on your account.', {
      code: 'EMAIL_UNCHANGED',
    });
  }

  /**
   * Somebody else's address, or somebody else's outstanding claim on one.
   *
   * Both halves are narrower than they first look, and both had to be.
   *
   * A row whose sign-up never answered its code is *not* an account: nobody has
   * proven they own that inbox, and `register` already says so in as many words
   * by replacing such a row wholesale rather than refusing the address. It is
   * also invisible in the admin Users list, which filters pending rows out — so
   * refusing on it produced the worst possible answer, "already in use by
   * another account" about an account nobody can find. Whoever answers the code
   * we are about to send proves the ownership that row never did, and displaces
   * it at the last step.
   *
   * A claim is only a blocker while it is live. `pendingEmail` has no expiry of
   * its own — it is retired by being answered, cancelled or replaced — so an
   * abandoned change would otherwise squat an address forever, invisibly, with
   * that same unfindable message. The code it was issued against is the thing
   * with a lifetime, so that is what decides. It is not a guarantee either way:
   * two live claims are settled by whichever code is answered first.
   */
  const taken = await User.findOne({
    _id: { $ne: user._id },
    $or: [
      { email: next, emailVerificationPending: { $ne: true } },
      {
        'pendingEmail.email': next,
        'otp.purpose': EMAIL_CHANGE_PURPOSE,
        'otp.expiresAt': { $gt: new Date() },
      },
    ],
  })
    .select('_id')
    .lean();

  if (taken) {
    throw new ApiError(409, 'That email address is already in use by another account.', {
      code: 'EMAIL_TAKEN',
    });
  }

  /**
   * Only a repeat of *this* change counts as a resend. Starting over with a
   * different address is a new decision and gets a clean budget — the cooldown
   * still paces it, so that is not a way around the ceiling, just a way around
   * being punished for a typo.
   */
  const resending =
    user.otp?.purpose === EMAIL_CHANGE_PURPOSE && user.pendingEmail?.email === next;
  if (resending) requireResendAllowance(user);

  const code = user.createEmailOtp({ resend: resending, purpose: EMAIL_CHANGE_PURPOSE });
  const claimed = await User.findByIdAndUpdate(
    user._id,
    { $set: { otp: user.otp, pendingEmail: { email: next, requestedAt: new Date() } } },
    { new: true }
  );

  // The claim is part of the account, so every other tab on it learns about the
  // change straight away — including the banner that offers to call it off.
  broadcast.profileUpdated(user._id, claimed);

  const sent = await mailService
    .sendEmailChangeOtpEmail({
      to: next,
      name: user.name,
      code,
      minutes: env.otp.expiryMinutes,
      currentEmail: user.email,
    })
    .catch((err) => {
      logger.error(`Could not compose email change code for ${next}: ${err.message}`);
      return false;
    });

  await audit.record(user, 'email-change-requested', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: `Email change started — ${user.email} → ${next}`,
    meta: { from: user.email, to: next, resend: resending, delivered: Boolean(sent) },
  });

  if (!sent && env.isProd) {
    throw ApiError.serviceUnavailable(
      'We could not send your confirmation code right now. Please try again in a few minutes.'
    );
  }

  return sendSuccess(res, {
    message: `We've sent a ${env.otp.length}-digit confirmation code to ${next}.`,
    data: {
      email: next,
      currentEmail: user.email,
      codeLength: env.otp.length,
      expiresInMinutes: env.otp.expiryMinutes,
      resendAvailableInSeconds: env.otp.resendCooldownSeconds,
      // Dev convenience, exactly as the sign-up code screen has: without SMTP
      // wired up there is otherwise no way past this dialog locally.
      ...(!sent && !env.isProd ? { devOtp: code } : {}),
    },
  });
});

/**
 * POST /users/me/email/verify — the code, and the move it performs.
 *
 * The write is a single conditional update rather than a read, a check and a
 * save. Two things depend on that: the filter names the pending address, so a
 * code answered twice — or answered while a second request has already replaced
 * the claim — cannot land on an address nobody asked for; and the unique index
 * gets to be the last word on the address itself, which is the only place the
 * question can be settled against every other account at once.
 */
exports.verifyEmailChange = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+otp.codeHash');

  const pending = user.pendingEmail?.email;
  if (!pending) {
    throw new ApiError(400, 'There is no email change waiting to be confirmed.', {
      code: 'NO_PENDING_EMAIL',
    });
  }

  const result = await user.verifyEmailOtp(req.body.otp, EMAIL_CHANGE_PURPOSE);
  if (!result.ok) {
    await audit.record(user, 'email-change-otp-failed', {
      actor: 'user',
      actorId: user._id,
      req,
      summary: `Email change code rejected (${result.reason})`,
      meta: { reason: result.reason, to: pending },
    });
    throw otpError(result);
  }

  const previous = user.email;
  const at = new Date();

  /**
   * A sign-up that never answered its code is standing on this address. It is
   * cleared out of the way, and it is cleared *here* — after the code has been
   * answered and nowhere else — because answering it is the proof that row never
   * had: whoever typed it reads the inbox, and the squatter demonstrably does
   * not. `register` makes the same judgement about the same rows when it
   * replaces one rather than refusing the address.
   *
   * The filter names `emailVerificationPending`, so a registration that was
   * *completed* in the meantime is not deleted — it is a real account now, it
   * matches nothing here, and the unique index below turns it into the plain
   * "somebody took it" answer instead.
   */
  const squatter = await User.findOneAndDelete({
    email: pending,
    emailVerificationPending: true,
    _id: { $ne: user._id },
  })
    .select('_id')
    .lean();

  if (squatter) {
    // The two empty collections a sign-up is given up front. Nothing can have
    // been put in them — the row never signed in — but they must not outlive the
    // row that owned them. Logged rather than thrown: the change is what the
    // caller asked for, and a stray empty cart is not a reason to refuse it.
    await Promise.all([
      Cart.deleteOne({ user: squatter._id }),
      Wishlist.deleteOne({ user: squatter._id }),
    ]).catch((err) =>
      logger.error(`Could not clear the cart/wishlist of unverified ${pending}: ${err.message}`)
    );

    await audit.record(user, 'email-change-verified', {
      actor: 'system',
      req,
      summary: `Removed an unverified sign-up squatting ${pending}`,
      meta: { to: pending, removedUser: String(squatter._id), reason: 'unverified-signup' },
    });
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { _id: user._id, 'pendingEmail.email': pending },
      {
        $set: {
          email: pending,
          // The address is proven by the very code that was just spent, so it
          // arrives verified. `emailVerificationPending` is cleared for the
          // account that somehow still carried it: whatever a pending sign-up
          // was waiting to be told, it has now been told.
          isEmailVerified: true,
          emailVerificationPending: false,
        },
        // The spent code goes with it. Assigning `undefined` to a nested path
        // leaves the stored subdocument exactly where it was, and a spent code
        // that survives is a spent code that can be replayed.
        $unset: { otp: 1, pendingEmail: 1 },
      },
      { new: true, runValidators: true }
    );
  } catch (err) {
    /**
     * The address was taken between the request and this moment. The claim is
     * dropped rather than left sitting there — it can never succeed now — and
     * the account keeps the address it has, which is the whole promise this
     * flow makes about every way it can fail.
     */
    if (err.code === 11000) {
      await User.updateOne({ _id: user._id }, { $unset: { otp: 1, pendingEmail: 1 } });
      await audit.record(user, 'email-change-cancelled', {
        actor: 'system',
        req,
        summary: `Email change to ${pending} refused — the address was registered meanwhile`,
        meta: { from: previous, to: pending, reason: 'taken' },
      });
      throw new ApiError(
        409,
        'That email address was registered by someone else while you were verifying it. ' +
          'Your address has not been changed.',
        { code: 'EMAIL_TAKEN' }
      );
    }
    throw err;
  }

  // The claim moved out from under this request — a second request replaced it,
  // or a cancel landed first. The code is spent either way; nothing to apply.
  if (!updated) {
    throw new ApiError(
      409,
      'This email change is no longer valid. Start again and we will send a new code.',
      { code: 'NO_PENDING_EMAIL' }
    );
  }

  await audit.record(updated, 'email-change-verified', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: `Email changed — ${previous} → ${updated.email}`,
    meta: { from: previous, to: updated.email },
  });

  /**
   * Both addresses, and neither await'ed: the change is already made, and a mail
   * relay that is down must not answer a completed change with a failure. The
   * old address gets the last message it will ever get from us, which is the one
   * that matters — it is the only warning an owner who did not do this will see.
   */
  for (const address of [previous, updated.email]) {
    mailService
      .sendEmailChangedEmail({
        to: address,
        name: updated.name,
        oldEmail: previous,
        newEmail: updated.email,
        at,
      })
      .catch((err) => logger.error(`Email change receipt to ${address} failed: ${err.message}`));
  }

  // Other tabs and devices on this account follow along without a refresh, and
  // the admin users list sees the row it is showing change address.
  broadcast.profileUpdated(updated._id, updated);
  broadcast.userChanged('updated', updated);

  return sendSuccess(res, {
    message: 'Your email address has been updated',
    data: { user: updated },
  });
});

/**
 * POST /users/me/email/cancel — throw the claim away.
 *
 * Idempotent, and answers the same way whether there was anything to cancel or
 * not: this is what the old address is told to press, and someone arriving from
 * that mail a minute after the code expired should be told the change is off,
 * not handed an error about a claim that has already lapsed.
 *
 * Two writes rather than one, each precisely scoped. The account's single code
 * slot may by now hold a code for something else entirely — a deactivation
 * started in another tab — and cancelling an email change is not permission to
 * throw that away.
 */
exports.cancelEmailChange = asyncHandler(async (req, res) => {
  const pending = req.user.pendingEmail?.email;

  const cleared = await User.findByIdAndUpdate(
    req.user._id,
    { $unset: { pendingEmail: 1 } },
    { new: true }
  );
  await User.updateOne(
    { _id: req.user._id, 'otp.purpose': EMAIL_CHANGE_PURPOSE },
    { $unset: { otp: 1 } }
  );

  // Any other tab drops the pending banner without waiting for a refresh.
  broadcast.profileUpdated(req.user._id, cleared);

  if (pending) {
    await audit.record(req.user, 'email-change-cancelled', {
      actor: 'user',
      actorId: req.user._id,
      req,
      summary: `Email change to ${pending} cancelled`,
      meta: { from: req.user.email, to: pending, reason: 'cancelled' },
    });
  }

  // The account comes back with it, so the caller can adopt the cleared document
  // rather than making a second round trip to find out what it now says.
  return sendSuccess(res, { message: 'Email change cancelled', data: { user: cleared } });
});

/** POST /users/me/avatar  (field: image) */
exports.updateAvatar = asyncHandler(async (req, res) => {
  if (!env.cloudinaryEnabled) {
    throw ApiError.serviceUnavailable(
      'Image uploads are not configured. Add your Cloudinary credentials to the server .env file.'
    );
  }
  if (!req.file) throw ApiError.badRequest('No image received');

  const previousPublicId = req.user.avatar?.publicId;

  const image = await uploadBuffer(req.file.buffer, {
    folder: `${env.cloudinary.folder}/avatars`,
  });

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { avatar: { url: image.url, publicId: image.publicId, source: 'upload' } },
    { new: true, runValidators: true }
  );

  // Only after the new photo is safely stored — a failed upload must leave the old one intact.
  // A Google-hosted picture has no publicId, so nothing is destroyed when replacing one.
  if (previousPublicId && previousPublicId !== image.publicId) await destroyAsset(previousPublicId);

  broadcast.profileUpdated(user._id, user);

  return sendSuccess(res, { message: 'Profile photo updated', data: { user } });
});

/** DELETE /users/me/avatar — falls back to the initial-letter avatar. */
exports.removeAvatar = asyncHandler(async (req, res) => {
  const publicId = req.user.avatar?.publicId;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $unset: { avatar: 1 } },
    { new: true }
  );

  if (publicId) await destroyAsset(publicId);

  broadcast.profileUpdated(user._id, user);

  return sendSuccess(res, { message: 'Profile photo removed', data: { user } });
});

/* ------------------------------------------------------------------ *
 * Deactivation — closing your own account
 *
 * Three steps, in this order: say why, prove it is you, and only then
 * is anything written. The reason is collected first because it is the
 * only part a shopper who changes their mind can abandon for free; the
 * code is second because it is the point of no return, and no code is
 * ever minted for a request that has not already named its reason.
 * ------------------------------------------------------------------ */

/**
 * The message an account with orders still on their way is turned away with.
 * One sentence, one place, because three routes say it: the pre-flight check the
 * dialog runs, and both steps of the flow itself.
 */
const OPEN_ORDERS_MESSAGE =
  'You have pending orders that are still in progress. Please wait until your orders are ' +
  'delivered or cancelled before deactivating your account.';

/**
 * The caller's orders that are still going somewhere.
 *
 * Deactivation revokes every session and closes the account to sign-in, which
 * would leave a shopper unable to track a parcel that is genuinely on its way,
 * unable to cancel it, and unable to read the delivery updates we keep sending —
 * while we still owe them goods or money. So the gate is not about tidiness: it
 * is about not letting someone lock themselves out of an obligation we have not
 * finished meeting.
 *
 * `delivered`, `cancelled` and `returned` all pass. Everything before delivery
 * blocks, which is exactly the set an order can still be cancelled from.
 *
 * Returned lean and trimmed to what a dialog lists — the shopper is being shown
 * *which* orders are in the way so the message is actionable rather than a flat
 * refusal.
 */
const openOrdersFor = (userId) =>
  Order.find({ user: userId, orderStatus: { $in: OPEN_STATUSES } })
    .select('orderNumber orderStatus pricing.total createdAt')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

/** Throws the shared refusal when anything is still open. */
async function requireNoOpenOrders(user, req) {
  const openOrders = await openOrdersFor(user._id);
  if (!openOrders.length) return;

  await audit.record(user, 'deactivation-blocked', {
    actor: 'system',
    req,
    summary: `Deactivation refused — ${openOrders.length} order(s) still in progress`,
    meta: { orderNumbers: openOrders.map((order) => order.orderNumber) },
  });

  throw new ApiError(409, OPEN_ORDERS_MESSAGE, {
    code: 'PENDING_ORDERS',
    details: {
      openOrders: openOrders.map((order) => ({
        _id: String(order._id),
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        total: order.pricing?.total,
        createdAt: order.createdAt,
      })),
    },
  });
}

/**
 * GET /users/me/deactivate/eligibility
 *
 * Read-only, and the reason the shopper meets this rule before the first dialog
 * rather than after choosing a reason and waiting for a code. Answering "no" three
 * screens into a flow is the kind of thing that reads as a bug; answering it on
 * the click that starts the flow reads as an explanation.
 *
 * It never throws for an ineligible account — "you cannot do this yet" is the
 * successful answer to this question, and the flow's own routes are what refuse.
 */
exports.deactivationEligibility = asyncHandler(async (req, res) => {
  const openOrders = await openOrdersFor(req.user._id);

  return sendSuccess(res, {
    message: openOrders.length ? OPEN_ORDERS_MESSAGE : 'Account can be deactivated',
    data: {
      eligible: openOrders.length === 0,
      reason: openOrders.length ? 'PENDING_ORDERS' : null,
      openOrders: openOrders.map((order) => ({
        _id: String(order._id),
        orderNumber: order.orderNumber,
        orderStatus: order.orderStatus,
        total: order.pricing?.total,
        createdAt: order.createdAt,
      })),
    },
  });
});

/**
 * Resolves whichever half of the picklist arrived into the text that will be
 * stored, or throws.
 *
 * A published row is re-read rather than trusted from the payload for the same
 * reason the order cancel dialog re-reads its own: a reason retired this morning
 * must not still be selectable from a tab left open since yesterday, and a client
 * could otherwise post any label it liked into a field an admin later reports on.
 */
async function resolveDeactivationReason({ reasonId, reason }) {
  if (reasonId) {
    const row = await DeactivationReason.findOne({ _id: reasonId, isActive: true }).lean();
    if (!row) {
      throw ApiError.badRequest('That reason is no longer available — please choose another.');
    }
    return { reason: row.label, reasonId: row._id, isOther: false };
  }

  return { reason: String(reason).trim(), reasonId: undefined, isOther: true };
}

/**
 * POST /users/me/deactivate/request — the reason, and the code it earns.
 *
 * The reason is written to `deactivation.pending` rather than handed back to the
 * client to return with the code. That is what stops the confirming request
 * substituting a different reason for the one this step recorded — the code and
 * the reason have to describe the same decision, and only the server can
 * guarantee they do.
 */
exports.requestDeactivation = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+otp.codeHash');

  /**
   * An admin closing their own account would leave the panel with one fewer way
   * in and no way to undo it from inside — reactivation needs an approver, and
   * the last admin has nobody to approve them. Staff hand the role over first.
   */
  if (user.role === 'admin') {
    throw ApiError.forbidden(
      'Admin accounts cannot be deactivated from here. Ask another administrator to change ' +
        'your role first.'
    );
  }

  /**
   * Checked before the reason is stored and before a code is minted, so a shopper
   * who cannot deactivate is never sent an email telling them how to.
   */
  await requireNoOpenOrders(user, req);

  const chosen = await resolveDeactivationReason(req.body);

  // The resend budget is only spent by an actual resend; opening the dialog again
  // after abandoning it starts the count fresh, which is what the cooldown is for.
  const resending = user.otp?.purpose === 'account-deactivation';
  if (resending) requireResendAllowance(user);

  const code = user.createEmailOtp({ resend: resending, purpose: 'account-deactivation' });
  await User.updateOne(
    { _id: user._id },
    { $set: { otp: user.otp, 'deactivation.pending': { ...chosen, at: new Date() } } }
  );

  const sent = await mailService
    .sendDeactivationOtpEmail({
      to: user.email,
      name: user.name,
      code,
      minutes: env.otp.expiryMinutes,
    })
    .catch((err) => {
      logger.error(`Could not compose deactivation code for ${user.email}: ${err.message}`);
      return false;
    });

  await audit.record(user, 'deactivation-requested', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: `Deactivation started — reason: ${chosen.reason}`,
    meta: { reason: chosen.reason, isOther: chosen.isOther },
  });
  await audit.record(user, 'deactivation-otp-sent', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: sent ? 'Confirmation code emailed' : 'Confirmation code generated but not delivered',
    meta: { delivered: Boolean(sent) },
  });

  if (!sent && env.isProd) {
    throw ApiError.serviceUnavailable(
      'We could not send your confirmation code right now. Please try again in a few minutes.'
    );
  }

  return sendSuccess(res, {
    message: `We've sent a ${env.otp.length}-digit confirmation code to ${user.email}.`,
    data: {
      email: user.email,
      codeLength: env.otp.length,
      expiresInMinutes: env.otp.expiryMinutes,
      resendAvailableInSeconds: env.otp.resendCooldownSeconds,
      reason: chosen.reason,
      // Dev convenience, exactly as the sign-up code screen has: without SMTP
      // wired up there is otherwise no way past this dialog locally.
      ...(!sent && !env.isProd ? { devOtp: code } : {}),
    },
  });
});

/**
 * POST /users/me/deactivate/confirm — the code, and the closure it performs.
 *
 * Everything irreversible happens here and nowhere else. The order matters: the
 * status is written first, so that even if the session sweep or the email fails
 * afterwards the account is genuinely closed rather than half-closed — every
 * gate reads the status, and a live session on a closed account dies on its next
 * request regardless.
 */
exports.confirmDeactivation = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+otp.codeHash');

  const pending = user.deactivation?.pending;
  if (!pending?.reason) {
    throw new ApiError(400, 'Please choose a reason for deactivating first.', {
      code: 'REASON_REQUIRED',
    });
  }

  /**
   * Re-checked here rather than trusted from step one. The code is good for ten
   * minutes, and placing an order takes less than that — a shopper who checks out
   * with the confirmation screen still open would otherwise close their account
   * over an order we have just accepted money for.
   */
  await requireNoOpenOrders(user, req);

  const result = await user.verifyEmailOtp(req.body.otp, 'account-deactivation');
  if (!result.ok) {
    await audit.record(user, 'deactivation-otp-failed', {
      actor: 'user',
      actorId: user._id,
      req,
      summary: `Deactivation code rejected (${result.reason})`,
      meta: { reason: result.reason },
    });

    throw otpError(result);
  }

  const at = new Date();
  const updated = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        status: 'deactivated',
        deactivation: {
          reason: pending.reason,
          reasonId: pending.reasonId,
          isOther: pending.isOther,
          at,
        },
      },
      // The spent code goes, and so does any half-finished reactivation from a
      // previous closure — neither describes the account as it now stands.
      $unset: { otp: 1, reactivationToken: 1, reactivationExpires: 1, reactivationRequestedAt: 1 },
    },
    { new: true }
  );

  /**
   * Every device, not just this one. A closed account must not stay usable on the
   * phone its owner last had it open on, and revoking the session rows is what
   * makes that true immediately rather than whenever a 15-minute access token
   * happens to lapse — the refresh tokens die with the rows they name.
   */
  await sessionService.revokeAllForUser(user._id, { reason: 'account-deactivated' });
  broadcast.sessionRevoked(user._id, { reason: 'account-deactivated' });

  res.clearCookie('refreshToken');

  await audit.record(updated, 'deactivation-otp-verified', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: 'Confirmation code accepted',
  });
  await audit.record(updated, 'deactivated', {
    actor: 'user',
    actorId: user._id,
    req,
    summary: `Account deactivated — reason: ${pending.reason}`,
    meta: { reason: pending.reason, isOther: pending.isOther },
  });

  mailService
    .sendAccountDeactivatedEmail({
      to: updated.email,
      name: updated.name,
      reason: pending.reason,
      at,
    })
    .catch((err) => logger.error(`Deactivation confirmation email failed: ${err.message}`));

  broadcast.userChanged('status', updated);

  return sendSuccess(res, { message: 'Your account has been deactivated' });
});

/* ---------------- Admin ---------------- */

/** GET /users (admin) */
exports.listUsers = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 15);

  // Sign-ups that never answered their code are not accounts yet — nobody has proven
  // they own the address, and the row exists only because the code has to be stored
  // somewhere. `$ne: true` rather than `false`: every account made before OTP sign-up
  // existed, and every one made through Google, has no such field at all.
  const filter = { emailVerificationPending: { $ne: true } };
  if (req.query.role && req.query.role !== 'all') filter.role = req.query.role;
  /**
   * 'deactivated' selects both halves of that one story — closed, and closed with
   * a request in the queue. An admin filtering for deactivated accounts is asking
   * "who has left", and splitting that into two chips they have to remember to
   * tick both of would only hide half the answer.
   */
  if (req.query.status && req.query.status !== 'all') {
    filter.status =
      req.query.status === 'deactivated'
        ? { $in: ['deactivated', 'reactivation-pending'] }
        : req.query.status;
  }
  if (req.query.search) {
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.createdAt.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  // Order counts make the list far more useful than raw registrations.
  const stats = await Order.aggregate([
    { $match: { user: { $in: users.map((u) => u._id) } } },
    { $group: { _id: '$user', orderCount: { $sum: 1 }, totalSpent: { $sum: '$pricing.total' } } },
  ]);
  const byUser = new Map(stats.map((s) => [String(s._id), s]));

  return sendSuccess(res, {
    message: 'Users fetched',
    data: {
      users: users.map((u) => ({
        ...u,
        orderCount: byUser.get(String(u._id))?.orderCount || 0,
        totalSpent: Math.round((byUser.get(String(u._id))?.totalSpent || 0) * 100) / 100,
      })),
    },
    meta: paginationMeta({ total, page, limit }),
  });
});

/** GET /users/:id (admin) */
exports.getUser = asyncHandler(async (req, res) => {
  // Same rule as the list it is opened from: an id that only exists because a
  // sign-up is half-finished must not resolve to a profile page.
  const user = await User.findOne({
    _id: req.params.id,
    emailVerificationPending: { $ne: true },
  }).lean();
  if (!user) throw ApiError.notFound('User not found');

  const orders = await Order.find({ user: user._id })
    .select('orderNumber pricing.total orderStatus paymentStatus createdAt')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return sendSuccess(res, { message: 'User fetched', data: { user, recentOrders: orders } });
});

/** PATCH /users/:id/status (admin) */
exports.updateUserStatus = asyncHandler(async (req, res) => {
  const { status, blockedReason } = req.body;

  if (String(req.params.id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot change your own status');
  }

  /**
   * An account its owner closed is not reachable from this control, in either
   * direction.
   *
   * Blocking one would overwrite the record of a self-deactivation with a staff
   * suspension and lose why it closed. Flipping one to active is the more
   * important half: reactivation exists precisely because coming back requires
   * the account holder to prove who they are, and a status dropdown that reopens
   * an account skips every one of those proofs — it would let a single mis-click
   * hand a closed account back to whoever asked. The Reactivation Requests screen
   * is the only door, and this is the check that makes it the only one.
   */
  const target = await User.findById(req.params.id).select('status name');
  if (!target) throw ApiError.notFound('User not found');

  if (isSelfDeactivated(target)) {
    throw ApiError.badRequest(
      target.status === 'reactivation-pending'
        ? `${target.name} deactivated this account and has asked to come back. Approve or reject ` +
          `the request under Reactivation Requests — the status cannot be changed here.`
        : `${target.name} deactivated this account themselves. It can only be reopened by ` +
          `approving a reactivation request, which the customer starts from the sign-in page.`
    );
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    // Reactivating unsets the stored reason so it never outlives the block it explains.
    status === 'blocked'
      ? { status, blockedReason: String(blockedReason).trim() }
      : { status, $unset: { blockedReason: '' } },
    { new: true, runValidators: true }
  );
  if (!user) throw ApiError.notFound('User not found');

  if (status === 'blocked') {
    await sessionService.revokeAllForUser(user._id, { reason: 'account-blocked' });
    broadcast.sessionRevoked(user._id, { reason: 'account-blocked' });
  }

  broadcast.userChanged('status', user);
  // Tell the affected session immediately instead of waiting for its next 401.
  broadcast.accountStatusChanged(user);

  return sendSuccess(res, { message: `User ${status}`, data: { user } });
});

/* ------------------------------------------------------------------ *
 * Reactivation requests (admin)
 *
 * The queue where a closed account comes back — or does not. Every row
 * here has already proven the link, the code and the account's own
 * details; what is left is the judgement call, and these three routes
 * are all there is to it.
 * ------------------------------------------------------------------ */

/** GET /users/reactivation-requests (admin) */
exports.listReactivationRequests = asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 15);

  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.search) {
    const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }

  const [requests, total, counts] = await Promise.all([
    ReactivationRequest.find(filter)
      .sort({ requestedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      // The live status, which the snapshot deliberately does not carry: an
      // approved request sits next to an account that is active again, and the
      // row should say so rather than only what it said the day it arrived.
      .populate('user', 'status email name phone avatar createdAt')
      .lean(),
    ReactivationRequest.countDocuments(filter),
    ReactivationRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const stats = { pending: 0, approved: 0, rejected: 0 };
  for (const row of counts) stats[row._id] = row.count;

  return sendSuccess(res, {
    message: 'Reactivation requests fetched',
    data: { requests, stats },
    meta: paginationMeta({ total, page, limit }),
  });
});

/**
 * GET /users/reactivation-requests/:id (admin)
 *
 * The request plus the account's whole audit trail. The trail is what turns this
 * from a form into a decision: it shows when the account was closed and why, how
 * many refused sign-ins there have been since, and — on a second request — what
 * happened to the first.
 */
exports.getReactivationRequest = asyncHandler(async (req, res) => {
  const request = await ReactivationRequest.findById(req.params.id)
    .populate('user', 'status email name phone avatar createdAt deactivation authProviders')
    .populate('reviewedBy', 'name email')
    .lean();
  if (!request) throw ApiError.notFound('Request not found');

  const [trail, orderStats] = await Promise.all([
    audit.forUser(request.user?._id || request.user),
    Order.aggregate([
      { $match: { user: request.user?._id || request.user } },
      { $group: { _id: null, orders: { $sum: 1 }, spent: { $sum: '$pricing.total' } } },
    ]),
  ]);

  return sendSuccess(res, {
    message: 'Request fetched',
    data: {
      request,
      trail,
      customer: {
        orders: orderStats[0]?.orders || 0,
        spent: Math.round((orderStats[0]?.spent || 0) * 100) / 100,
      },
    },
  });
});

/**
 * PATCH /users/reactivation-requests/:id (admin) — approve or reject.
 *
 * One route for both because they are one decision with two answers, and because
 * everything around the answer — the request must still be open, the account must
 * still be the one that asked, the trail must record who decided and when — is
 * identical either way.
 *
 * Approving is the only thing in the system that turns a self-closed account back
 * to active. That is why the account is re-read here rather than trusted from the
 * request snapshot: a shopper whose account was blocked by staff *after* asking to
 * come back must not be laundered into an active one by an approval.
 */
exports.decideReactivationRequest = asyncHandler(async (req, res) => {
  const { decision, adminNotes, rejectionReason } = req.body;

  const request = await ReactivationRequest.findById(req.params.id);
  if (!request) throw ApiError.notFound('Request not found');
  if (request.status !== 'pending') {
    throw ApiError.badRequest(`This request has already been ${request.status}.`);
  }

  const user = await User.findById(request.user);
  if (!user) throw ApiError.notFound('The account this request belongs to no longer exists');
  if (user.status === 'blocked') {
    throw ApiError.badRequest(
      'This account has since been blocked by an administrator. Unblock it first if you intend ' +
        'to let the customer back in.'
    );
  }

  const at = new Date();
  request.status = decision;
  request.reviewedBy = req.user._id;
  request.reviewedByName = req.user.name;
  request.reviewedAt = at;
  if (adminNotes) request.adminNotes = String(adminNotes).trim();
  if (decision === 'rejected') request.rejectionReason = String(rejectionReason).trim();
  await request.save();

  if (decision === 'approved') {
    /**
     * Back to where the account was before its owner closed it: active, with the
     * closure's own record cleared so a later reading of this document describes
     * the account as it now stands rather than as it once was. The trail keeps the
     * history — that is what it is for.
     */
    await User.updateOne(
      { _id: user._id },
      {
        $set: { status: 'active' },
        $unset: {
          deactivation: 1,
          reactivationRequestedAt: 1,
          reactivationToken: 1,
          reactivationExpires: 1,
        },
      }
    );
    user.status = 'active';

    // A returning account needs the two empty collections every sign-up gets —
    // upserted, because an account that only ever closed still has both.
    await Promise.all([
      Cart.updateOne({ user: user._id }, { $setOnInsert: { user: user._id } }, { upsert: true }),
      Wishlist.updateOne({ user: user._id }, { $setOnInsert: { user: user._id } }, { upsert: true }),
    ]);
  } else {
    /**
     * A refusal returns the account to plain 'deactivated' rather than leaving it
     * pending: pending means "someone is looking at this", and once nobody is, the
     * customer must be able to ask again — with a fresh link and fresh proof.
     */
    await User.updateOne(
      { _id: user._id },
      { $set: { status: 'deactivated' }, $unset: { reactivationRequestedAt: 1 } }
    );
    user.status = 'deactivated';
  }

  await audit.record(user, decision === 'approved' ? 'reactivation-approved' : 'reactivation-rejected', {
    actor: 'admin',
    actorId: req.user._id,
    actorName: req.user.name,
    req,
    summary:
      decision === 'approved'
        ? `Reactivation approved by ${req.user.name}`
        : `Reactivation rejected by ${req.user.name} — ${request.rejectionReason}`,
    meta: { requestId: String(request._id), adminNotes: request.adminNotes },
  });

  if (decision === 'approved') {
    await audit.record(user, 'reactivated', {
      actor: 'admin',
      actorId: req.user._id,
      actorName: req.user.name,
      req,
      summary: 'Account returned to active',
    });
  }

  const mail =
    decision === 'approved'
      ? mailService.sendAccountReactivatedEmail({
          to: request.email,
          name: request.name,
          reviewedAt: at,
          adminNotes: request.adminNotes,
        })
      : mailService.sendReactivationRejectedEmail({
          to: request.email,
          name: request.name,
          reason: request.rejectionReason,
          reviewedAt: at,
        });
  mail.catch((err) => logger.error(`Reactivation decision email failed: ${err.message}`));

  broadcast.reactivationRequestChanged(decision, request);
  broadcast.userChanged('status', user);
  broadcast.accountStatusChanged(user);

  return sendSuccess(res, {
    message: decision === 'approved' ? 'Account reactivated' : 'Request rejected',
    data: { request },
  });
});

/** PATCH /users/:id/role (admin) */
exports.updateUserRole = asyncHandler(async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) {
    throw ApiError.badRequest('You cannot change your own role');
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { role: req.body.role },
    { new: true, runValidators: true }
  );
  if (!user) throw ApiError.notFound('User not found');

  broadcast.userChanged('role', user);
  broadcast.accountStatusChanged(user);

  return sendSuccess(res, { message: `Role updated to ${req.body.role}`, data: { user } });
});
