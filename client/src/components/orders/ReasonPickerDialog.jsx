import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import Spinner from '../common/Spinner';
import Icon from '../common/Icon';

/** The escape hatch is not a stored reason — it is always the last radio. */
const OTHER = 'other';

/**
 * "Why?", for the two journeys that ask it: cancelling an order and returning one.
 *
 * Both are the second step of their flow — the confirmation dialog has already
 * asked whether to go ahead — so this one only collects the reason and then does
 * the thing. The list is whatever an admin has published, fetched each time the
 * dialog opens so a reason retired this morning is not still on offer in a tab
 * left open since yesterday; the server re-checks the chosen id for exactly the
 * same reason.
 *
 * The two flows read from different picklists on purpose (a shopper holding a
 * damaged parcel must never be offered "Wrong address selected"), so `fetch` and
 * the copy are the props — everything else about the dialog is identical, and
 * making them one component is what keeps them behaving identically.
 *
 * `onConfirm` receives the payload the API takes: `{ reasonId }` for a published
 * reason, `{ reason }` for the shopper's own words.
 */
export default function ReasonPickerDialog({
  open,
  onClose,
  onConfirm,
  /** () => Promise<{ data: { reasons: [] } }> — the picklist for this flow. */
  fetchReasons,
  /** Radio group name; distinct per flow so two mounted dialogs never share state. */
  name,
  /** Translated copy: title, submit, otherLabel, otherPlaceholder, required, customRequired, failed. */
  copy,
  /** Danger red for cancelling; brand for a return, which is not destructive. */
  tone = 'danger',
}) {
  const { t } = useTranslation(['account', 'common']);

  const [reasons, setReasons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return undefined;

    // Reopening after a failed attempt starts clean rather than re-submitting a
    // choice the shopper can no longer see.
    setSelected('');
    setCustom('');
    setError('');

    let cancelled = false;
    setLoading(true);
    fetchReasons()
      .then((res) => {
        if (!cancelled) setReasons(res?.data?.reasons || []);
      })
      .catch(() => {
        // "Other" alone still lets the shopper through, so a failed list is a
        // degraded dialog rather than a dead end.
        if (!cancelled) setReasons([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, fetchReasons]);

  const isOther = selected === OTHER;

  const submit = async () => {
    if (!selected) return setError(copy.required);
    const typed = custom.trim();
    if (isOther && typed.length < 5) return setError(copy.customRequired);

    setError('');
    setWorking(true);
    try {
      await onConfirm(isOther ? { reason: typed } : { reasonId: selected });
      onClose?.();
    } catch (err) {
      setError(err?.message || copy.failed);
    } finally {
      setWorking(false);
    }
  };

  const options = [
    ...reasons.map((reason) => ({ value: reason._id, label: reason.label })),
    { value: OTHER, label: t('detail.reasonOther') },
  ];

  return (
    <Modal
      open={open}
      onClose={working ? () => {} : onClose}
      title={copy.title}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={working} className="btn-outline">
            {copy.dismiss}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={working || loading}
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
          >
            {working && <Spinner size={14} />}
            {copy.submit}
          </button>
        </>
      }
    >
      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner size={22} />
        </div>
      ) : (
        <div className="space-y-1">
          {options.map((option) => {
            const active = selected === option.value;

            return (
              <label
                key={option.value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg px-2 py-3 transition
                            hover:bg-ink-50 ${active ? 'bg-ink-50' : ''}`}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={active}
                  onChange={() => {
                    setSelected(option.value);
                    setError('');
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
                />
                <span className="min-w-0 text-sm text-ink-800">{option.label}</span>
              </label>
            );
          })}

          {isOther && (
            <div className="pt-2">
              <label htmlFor={`${name}-other`} className="label">
                {t('detail.reasonOtherLabel')}
              </label>
              <textarea
                id={`${name}-other`}
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError('');
                }}
                rows={3}
                maxLength={300}
                autoFocus
                placeholder={copy.otherPlaceholder}
                className="input resize-none"
              />
              <p className="mt-1 text-right text-xs text-ink-400">{custom.length}/300</p>
            </div>
          )}

          {error && (
            <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-danger">
              <Icon name="alert" size={14} />
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
