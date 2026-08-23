import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { userApi } from '../../api/endpoints';
import Modal from '../common/Modal';
import Spinner from '../common/Spinner';
import Icon from '../common/Icon';
import OtpInput from '../auth/OtpInput';

const DEFAULT_LENGTH = 6;

/**
 * The second step of changing the account's email address: the code the new
 * inbox was sent, and the change it performs.
 *
 * The address itself is collected in the profile form rather than here, because
 * that is where the shopper is already editing their details — this dialog opens
 * once the server has accepted that address and mailed a code to it. It is never
 * sent again from this side: the server holds it against the code it issued, so
 * the two cannot end up describing different addresses.
 *
 * Deliberately the deactivation dialog's twin — same code boxes, same ticking
 * resend, same handling of a code that can no longer work — because it asks for
 * exactly the same thing, and a shopper who has met one should not have to learn
 * the other.
 *
 * `sent` is the server's reply to the request: where the code went, how long it
 * lasts, and (locally, without SMTP) the code itself. `onChanged` runs only once
 * the account has actually moved, and is handed the updated user; `onClose` only
 * dismisses this dialog, while `onCancelChange` ends the change itself.
 */
export default function ChangeEmailDialog({
  open,
  sent,
  onClose,
  onCancelChange,
  onChanged,
  onResent,
}) {
  const { t } = useTranslation(['account', 'common']);

  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const codeLength = sent?.codeLength || DEFAULT_LENGTH;

  // Reopening starts clean rather than resuming a code the shopper can no longer
  // see, and the cooldown restarts from whatever the fresh reply said.
  useEffect(() => {
    if (!open) return;
    setCode('');
    setError('');
    setCooldown(sent?.resendAvailableInSeconds || 0);
  }, [open, sent]);

  // One ticking second at a time, like the sign-up code screen: the number is only
  // ever read by the button beside it, and it is never more than a minute.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setInterval(() => setCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  /** Asks for another code for the same address — the server counts it as a resend. */
  const resend = async () => {
    setError('');
    setWorking(true);
    try {
      const res = await userApi.email.change(sent.email);
      onResent?.(res.data);
      setCode('');
    } catch (err) {
      setError(err?.message || t('profile.emailChange.failed'));
      // A refused resend still has to stop the button offering something the
      // server has already said no to.
      if (err?.code === 'OTP_COOLDOWN') {
        const wait = Number(String(err.message).match(/\d+/)?.[0]);
        if (wait) setCooldown(wait);
      }
    } finally {
      setWorking(false);
    }
  };

  /** The code, and the move it performs. */
  const confirm = async (value = code) => {
    if (value.length !== codeLength) {
      return setError(t('auth.verifyIncomplete', { length: codeLength }));
    }

    setError('');
    setWorking(true);
    try {
      const res = await userApi.email.verify(value);
      await onChanged?.(res.data.user);
    } catch (err) {
      setError(err?.message || t('profile.emailChange.failed'));
      // A code that can no longer work is cleared rather than left in the boxes
      // looking like something that might still be tried.
      if (err?.code === 'OTP_EXPIRED' || err?.code === 'OTP_UNUSABLE') setCode('');
      // The claim itself is gone — nothing in this dialog can succeed any more,
      // so it hands back rather than leaving the shopper typing at a dead end.
      if (err?.code === 'EMAIL_TAKEN' || err?.code === 'NO_PENDING_EMAIL') onClose?.(err);
    } finally {
      setWorking(false);
    }
    return undefined;
  };

  return (
    <Modal
      open={open}
      onClose={working ? () => {} : onClose}
      title={t('profile.emailChange.title')}
      // Slides up from the bottom edge on phones, like the deactivation dialog
      // this one is deliberately built to feel like.
      sheet
      footer={
        <>
          {/*
            * "Cancel change", not "Cancel": dismissing the dialog with the X or
            * the backdrop leaves the claim standing — the pending banner on the
            * profile picks it up — so the button that ends it has to say so.
            */}
          <button
            type="button"
            onClick={onCancelChange}
            disabled={working}
            className="btn-outline"
          >
            {t('profile.emailChange.cancelChange')}
          </button>
          <button
            type="button"
            onClick={() => confirm()}
            disabled={working || code.length !== codeLength}
            className="btn-primary"
          >
            {working && <Spinner size={14} />}
            {t('profile.emailChange.action')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-600">
          {t('profile.emailChange.intro', { email: sent?.email })}
        </p>

        <OtpInput
          label={t('auth.verifyCodeLabel')}
          value={code}
          length={codeLength}
          disabled={working}
          invalid={Boolean(error)}
          onChange={(next) => {
            setCode(next);
            if (error) setError('');
          }}
          // Deliberately no auto-submit. The last digit here changes the address
          // the account signs in with, and that should cost a deliberate click.
        />

        <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-500">
          <Icon name="mail" size={14} className="mt-0.5 shrink-0" />
          {t('auth.verifyExpiry', { minutes: sent?.expiresInMinutes || 10 })}
        </p>

        {/* The reassurance that makes an abandoned dialog safe to abandon. */}
        <p className="flex items-start gap-2 rounded-lg bg-brand-50 p-3 text-xs leading-relaxed text-ink-600">
          <Icon name="shield" size={14} className="mt-0.5 shrink-0 text-brand-600" />
          {t('profile.emailChange.keepOldNote', { email: sent?.currentEmail })}
        </p>

        {sent?.devOtp && (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-3 text-xs">
            <p className="mb-1 font-semibold text-amber-800">{t('auth.devMode')}</p>
            <p className="font-mono text-base tracking-[0.3em] text-amber-900">{sent.devOtp}</p>
          </div>
        )}

        <div className="text-center text-sm text-ink-500">
          {t('auth.noCode')}{' '}
          <button
            type="button"
            onClick={resend}
            disabled={working || cooldown > 0}
            className="font-semibold text-brand-600 hover:underline disabled:text-ink-400 disabled:no-underline"
          >
            {cooldown > 0 ? t('auth.resendIn', { seconds: cooldown }) : t('auth.resend')}
          </button>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-danger">
            <Icon name="alert" size={14} className="shrink-0" />
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
