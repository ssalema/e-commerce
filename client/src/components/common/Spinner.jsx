import { useTranslation } from 'react-i18next';

export default function Spinner({ size = 20, className = '' }) {
  const { t } = useTranslation();

  return (
    <span
      role="status"
      aria-label={t('a11y.loading')}
      className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
