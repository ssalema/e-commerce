const ApiError = require('./ApiError');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Turns a rejected one-time code into the answer the caller sends back.
 *
 * Shared by every screen that asks for one — sign-up, deactivation, reactivation
 * and the email change — so the wording and the tags cannot drift apart. A client
 * that learns to clear its boxes on `OTP_EXPIRED` learns it once.
 *
 * A wrong code with guesses left is the only case worth distinguishing, because
 * it is the only one where trying again is the right move. Expired, exhausted and
 * simply-gone all get one answer, because there is one thing to do about all
 * three — and because telling them apart would say more about the account's
 * outstanding code than a wrong guess has earned.
 *
 * @param {{ok: boolean, reason?: string, remaining: number}} result The verdict
 *   from `verifyEmailOtp`.
 * @returns {ApiError}
 */
function otpError(result) {
  if (result.reason === 'mismatch' && result.remaining > 0) {
    return new ApiError(
      400,
      `That code is not correct. ${plural(result.remaining, 'attempt')} left before you will ` +
        `need a new one.`,
      { code: 'OTP_INVALID' }
    );
  }
  return new ApiError(
    400,
    result.reason === 'expired'
      ? 'This code has expired. Request a new one and we will send it straight away.'
      : 'This code can no longer be used. Request a new one and we will send it straight away.',
    { code: result.reason === 'expired' ? 'OTP_EXPIRED' : 'OTP_UNUSABLE' }
  );
}

module.exports = { otpError, plural };
