import { useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { updateProfile, uploadAvatar, removeAvatar, setUser } from '../../store/authSlice';
import { orderApi, addressApi, userApi } from '../../api/endpoints';
import useFetch from '../../hooks/useFetch';
import { useLiveRefetch } from '../../realtime/useRealtime';
import { EVENTS, ORDER_EVENTS } from '../../realtime/events';
import { formatDate, formatPrice } from '../../utils/format';
import Seo from '../../components/common/Seo';
import Icon from '../../components/common/Icon';
import Spinner from '../../components/common/Spinner';
import PhoneInput from '../../components/common/PhoneInput';
import StatusBadge from '../../components/common/StatusBadge';
import UserAvatar from '../../components/common/UserAvatar';
import LanguageSelector from '../../components/language/LanguageSelector';
import ChangeEmailDialog from '../../components/account/ChangeEmailDialog';

const AVATAR_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // mirrors the server's multer limit

/** Deliberately the server's own rule, so the two agree on what an address is. */
const EMAIL_RE = /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/;

export default function Profile() {
  const { t } = useTranslation(['account', 'common']);
  const dispatch = useDispatch();
  const user = useSelector((s) => s.auth.user);
  const wishlistCount = useSelector((s) => s.wishlist.ids.length);

  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({
    name: user?.name || '',
    phone: user?.phone || '',
    email: user?.email || '',
  });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  /**
   * The reply to a `change` call: where the code went, how long it lasts, and
   * locally the code itself. Holding it here rather than inside the dialog is
   * what lets a resend replace it without the dialog closing and reopening.
   */
  const [emailSent, setEmailSent] = useState(null);
  const [otpOpen, setOtpOpen] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);

  const fileRef = useRef(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change event.
    e.target.value = '';
    if (!file) return;

    if (!AVATAR_TYPES.includes(file.type)) {
      return toast.error(t('photo.badType'));
    }
    if (file.size > AVATAR_MAX_BYTES) {
      return toast.error(t('photo.tooLarge'));
    }

    setPhotoBusy(true);
    setProgress(0);
    try {
      await dispatch(uploadAvatar({ file, onProgress: setProgress })).unwrap();
      toast.success(t('photo.updated'));
    } catch (err) {
      toast.error(err?.message || t('photo.uploadFailed'));
    } finally {
      setPhotoBusy(false);
      setProgress(0);
    }
  };

  const deletePhoto = async () => {
    setPhotoBusy(true);
    try {
      await dispatch(removeAvatar()).unwrap();
      toast.success(t('photo.removed'));
    } catch (err) {
      toast.error(err?.message || t('photo.removeFailed'));
    } finally {
      setPhotoBusy(false);
    }
  };

  const orders = useFetch(useCallback(() => orderApi.list({ limit: 3 }), []), []);
  const addresses = useFetch(useCallback(() => addressApi.list(), []), []);

  // The overview repeats what Orders and Addresses show, so it follows the same
  // events — otherwise the counts here disagree with the pages they link to.
  useLiveRefetch(orders.refetch, ORDER_EVENTS);
  useLiveRefetch(addresses.refetch, EVENTS.ADDRESS_CHANGED);

  const recentOrders = orders.data?.data?.orders || [];
  const orderCount = orders.data?.meta?.total ?? 0;
  const addressCount = addresses.data?.data?.addresses?.length ?? 0;

  /** Asks the server to start a change, and opens the code dialog if it agrees. */
  const startEmailChange = async (address) => {
    setEmailBusy(true);
    try {
      const res = await userApi.email.change(address);
      setEmailSent(res.data);
      setOtpOpen(true);
      return true;
    } catch (err) {
      // Anything the server can say about the address itself belongs beside the
      // field it was typed into, not in a toast that disappears.
      if (['EMAIL_TAKEN', 'EMAIL_UNCHANGED'].includes(err?.code) || err?.errors?.length) {
        setErrors((prev) => ({ ...prev, email: err.message }));
      } else {
        toast.error(err?.message || t('profile.emailChange.failed'));
      }
      return false;
    } finally {
      setEmailBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();

    const found = {};
    if (values.name.trim().length < 2) found.name = t('common:validation.nameRequired');
    if (values.phone && !/^[6-9]\d{9}$/.test(values.phone)) {
      found.phone = t('common:validation.phoneInvalid');
    }
    const address = values.email.trim().toLowerCase();
    if (!address) found.email = t('common:validation.emailRequired');
    else if (!EMAIL_RE.test(address)) found.email = t('common:validation.emailInvalid');
    if (Object.keys(found).length) return setErrors(found);

    setErrors({});
    setSaving(true);
    try {
      /**
       * The name and the phone number are saved outright; the address is not, and
       * that asymmetry is the whole feature. It goes no further than a request
       * for a code until the code comes back — so the two halves are separate
       * calls, and a rejected address does not roll back a saved name.
       */
      const changedDetails =
        values.name.trim() !== (user?.name || '') || values.phone !== (user?.phone || '');

      if (changedDetails) {
        await dispatch(updateProfile({ name: values.name, phone: values.phone })).unwrap();
      }

      if (address !== user?.email) {
        const started = await startEmailChange(address);
        // The form stays open behind the dialog: a refused address has to be
        // corrected, and a verified one closes it from `emailChanged` below.
        if (started && changedDetails) toast.success(t('profile.updated'));
        return undefined;
      }

      if (changedDetails) toast.success(t('profile.updated'));
      setEditing(false);
    } catch (err) {
      toast.error(err?.message || t('profile.updateFailed'));
    } finally {
      setSaving(false);
    }
    return undefined;
  };

  /** The account has moved. Adopt the returned user and close everything down. */
  const emailChanged = (updated) => {
    dispatch(setUser(updated));
    setOtpOpen(false);
    setEmailSent(null);
    setValues((v) => ({ ...v, email: updated.email }));
    setEditing(false);
    toast.success(t('profile.emailChange.verified'));
  };

  /** Drops the claim, so the account is not left with one nobody is answering. */
  const cancelEmailChange = async () => {
    setEmailBusy(true);
    try {
      // The account carries the pending change, so the cleared document is what
      // takes the banner away — the call hands it straight back.
      const res = await userApi.email.cancel();
      dispatch(setUser(res.data.user));
      setOtpOpen(false);
      setEmailSent(null);
      setValues((v) => ({ ...v, email: res.data.user.email }));
      toast.success(t('profile.emailChange.cancelled'));
    } catch (err) {
      toast.error(err?.message || t('profile.emailChange.failed'));
    } finally {
      setEmailBusy(false);
    }
  };

  const stats = [
    { key: 'orders', value: orderCount, icon: 'package', to: '/account/orders' },
    { key: 'addresses', value: addressCount, icon: 'location', to: '/account/addresses' },
    { key: 'wishlist', value: wishlistCount, icon: 'heart', to: '/wishlist' },
  ];

  const hasPhoto = Boolean(user?.avatar?.url);
  const fromGoogle = user?.avatar?.source === 'google';

  return (
    <div className="space-y-5">
      <Seo title={t('common:nav.myProfile')} noIndex />

      <ChangeEmailDialog
        open={otpOpen}
        sent={emailSent}
        // Dismissing leaves the claim standing; the pending banner picks it up.
        onClose={() => setOtpOpen(false)}
        onCancelChange={cancelEmailChange}
        onResent={setEmailSent}
        onChanged={emailChanged}
      />

      <section className="card p-5">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <div className="relative">
            <UserAvatar user={user} size={88} />

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={photoBusy}
              className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full border-2 border-white bg-brand-600 text-white shadow transition hover:bg-brand-700 disabled:opacity-60"
              aria-label={t(hasPhoto ? 'photo.changeAria' : 'photo.addAria')}
            >
              {photoBusy ? <Spinner size={15} /> : <Icon name="camera" size={16} />}
            </button>

            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_TYPES.join(',')}
              onChange={pickPhoto}
              className="hidden"
            />
          </div>

          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h2 className="text-base font-bold text-ink-900">{t('photo.title')}</h2>
            <p className="mt-0.5 text-sm text-ink-500">
              {photoBusy && progress > 0
                ? t('photo.uploading', { percent: progress })
                : fromGoogle
                  ? t('photo.fromGoogle')
                  : t('photo.hint')}
            </p>

            <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={photoBusy}
                className="btn-outline !py-2 text-sm"
              >
                {t(hasPhoto ? 'photo.change' : 'photo.upload')}
              </button>
              {hasPhoto && (
                <button
                  type="button"
                  onClick={deletePhoto}
                  disabled={photoBusy}
                  className="rounded-lg px-3 py-2 text-sm font-semibold text-danger transition hover:bg-red-50 disabled:opacity-60"
                >
                  {t('common:actions.remove')}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <Link key={stat.key} to={stat.to} className="card p-4 transition hover:shadow-card-hover">
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600">
                <Icon name={stat.icon} size={20} />
              </span>
              <div>
                <p className="text-xl font-extrabold text-ink-900">{stat.value}</p>
                <p className="text-xs text-ink-500">{t(`profile.stats.${stat.key}`)}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <section className="card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">{t('profile.personalInfo')}</h2>
          {!editing && (
            <button
              type="button"
              onClick={() => {
                // Seeded from the account each time rather than from whatever the
                // last edit left behind — another device may have changed it since.
                setValues({ name: user.name, phone: user.phone || '', email: user.email || '' });
                setErrors({});
                setEditing(true);
              }}
              className="text-sm font-semibold text-brand-600 hover:underline"
            >
              {t('common:actions.edit')}
            </button>
          )}
        </div>


        {editing ? (
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="name" className="label">
                {t('profile.fullName')}
              </label>
              <input
                id="name"
                value={values.name}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
                className={`input ${errors.name ? 'input-error' : ''}`}
              />
              {errors.name && <p className="error-text">{errors.name}</p>}
            </div>

            <div>
              <label htmlFor="phone" className="label">
                {t('profile.mobile')}
              </label>
              <PhoneInput
                id="phone"
                value={values.phone}
                onChange={(e) => setValues((v) => ({ ...v, phone: e.target.value }))}
                error={errors.phone}
                placeholder={t('auth.phonePlaceholder')}
              />
              {errors.phone && <p className="error-text">{errors.phone}</p>}
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="email" className="label">
                {t('profile.email')}
              </label>
              {/*
                * Editable, but never saved by this form. The address is the
                * account's identity, so it moves only once a code sent to the new
                * inbox has been typed back — see `save` above.
                */}
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={values.email}
                onChange={(e) => {
                  setValues((v) => ({ ...v, email: e.target.value }));
                  if (errors.email) setErrors((prev) => ({ ...prev, email: '' }));
                }}
                className={`input ${errors.email ? 'input-error' : ''}`}
              />
              {errors.email ? (
                <p className="error-text">{errors.email}</p>
              ) : (
                <p className="mt-1 text-xs text-ink-400">{t('profile.emailHint')}</p>
              )}
            </div>

            <div className="flex gap-3 sm:col-span-2">
              <button type="submit" disabled={saving || emailBusy} className="btn-primary">
                {(saving || emailBusy) && <Spinner size={14} />}
                {t('common:actions.saveChanges')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValues({ name: user.name, phone: user.phone || '', email: user.email || '' });
                  setErrors({});
                }}
                className="btn-outline"
              >
                {t('common:actions.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            {[
              ['fullName', user?.name],
              ['email', user?.email],
              ['mobile', user?.phone || t('profile.notAdded')],
              ['memberSince', user?.createdAt ? formatDate(user.createdAt) : '—'],
            ].map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">
                  {t(`profile.${key}`)}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold text-ink-800">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-1 flex items-center gap-2 text-base font-bold text-ink-900">
          <Icon name="globe" size={18} className="text-brand-600" />
          {t('common:language.sectionTitle')}
        </h2>
        <p className="mb-4 text-sm text-ink-500">{t('common:language.sectionHint')}</p>
        <LanguageSelector className="max-w-md" />
      </section>

      <section className="card p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-ink-900">{t('profile.recentOrders')}</h2>
          <Link to="/account/orders" className="text-sm font-semibold text-brand-600 hover:underline">
            {t('common:actions.viewAll')}
          </Link>
        </div>

        {orders.loading ? (
          <p className="py-6 text-center text-sm text-ink-400">{t('orders.loading')}</p>
        ) : !recentOrders.length ? (
          <div className="py-8 text-center">
            <p className="mb-3 text-sm text-ink-500">{t('orders.noneYet')}</p>
            <Link to="/products" className="btn-primary">
              {t('orders.startShopping')}
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-ink-100">
            {recentOrders.map((order) => (
              <Link
                key={order._id}
                to={`/account/orders/${order._id}`}
                className="flex items-center justify-between gap-4 py-3 transition hover:bg-ink-50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink-900">{order.orderNumber}</p>
                  <p className="text-xs text-ink-500">
                    {formatDate(order.createdAt)} ·{' '}
                    {t('orders.itemCount', { count: order.items.length })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusBadge status={order.orderStatus} />
                  <span className="text-sm font-bold text-ink-900">
                    {formatPrice(order.pricing.total)}
                  </span>
                  <Icon name="chevronRight" size={16} className="text-ink-300" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
