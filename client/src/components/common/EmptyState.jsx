import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

/** Consistent "nothing here" panel — always offers a next action. */
export default function EmptyState({
  icon = 'emptyBox',
  title,
  message,
  actionLabel,
  actionTo,
  onAction,
  compact = false,
  className = '',
}) {
  const { t } = useTranslation();

  return (
    /*
     * `compact` is the same panel sized for a band inside a card rather than for
     * the middle of a screen. It is a prop rather than a padding class passed
     * through `className` because Tailwind resolves two competing `py-*`
     * utilities by their order in the generated stylesheet, not by their order
     * in the attribute — so the override would win or lose at random.
     */
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'px-4 py-8' : 'px-6 py-16'
      } ${className}`}
    >
      <div
        className={`flex items-center justify-center rounded-full bg-ink-100 text-ink-400 ${
          compact ? 'mb-3 h-14 w-14' : 'mb-4 h-20 w-20'
        }`}
      >
        <Icon name={icon} size={compact ? 26 : 36} />
      </div>
      <h3
        className={`mb-1.5 font-bold text-ink-900 ${compact ? 'text-base' : 'text-lg'}`}
      >
        {title || t('empty.nothingHere')}
      </h3>
      {message && (
        <p className={`max-w-md text-sm text-ink-500 ${compact ? 'mb-4' : 'mb-6'}`}>{message}</p>
      )}

      {actionLabel && actionTo && (
        <Link to={actionTo} className={`btn-primary ${compact ? 'btn-sm' : ''}`}>
          {actionLabel}
        </Link>
      )}
      {actionLabel && onAction && !actionTo && (
        <button
          type="button"
          onClick={onAction}
          className={`btn-primary ${compact ? 'btn-sm' : ''}`}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
