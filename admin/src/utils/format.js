const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const inrPrecise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
});

export const formatPrice = (value, precise = false) =>
  (precise ? inrPrecise : inr).format(Number(value) || 0);

export const formatNumber = (value) => new Intl.NumberFormat('en-IN').format(Number(value) || 0);

export const formatDate = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

/**
 * Numbers are stored as the ten digits the forms collect; the +91 is presentation,
 * so every screen that prints one goes through here. Anything that already carries
 * a country code, or isn't ten digits, is shown as typed rather than mislabelled.
 */
export const formatPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '—';
  if (digits.length === 10) return `+91 ${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2)}`;
  return String(value);
};

/**
 * The inverse of the above: whatever a field or the database holds, reduced to the
 * ten digits the platform stores, so a value saved as "+91 98765 43210" can be
 * edited in a PhoneField without the country code appearing twice.
 */
export const phoneDigits = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 && digits.startsWith('91') ? digits.slice(2, 12) : digits.slice(0, 10);
};

export const titleCase = (value = '') =>
  String(value).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Cloudinary transform helper — thumbnails in tables should not download full-size art. */
export function thumb(url, size = 80) {
  if (!url || !url.includes('/upload/')) return url;
  return url.replace('/upload/', `/upload/w_${size},h_${size},c_fill,q_auto,f_auto/`);
}

export const primaryImageOf = (product) =>
  product?.images?.find((i) => i.isPrimary)?.url || product?.images?.[0]?.url || '';

/** finalPrice is computed server-side; this mirrors it for live preview in the wizard. */
export const computeFinalPrice = (price, discountPercent) => {
  const p = Number(price) || 0;
  const d = Number(discountPercent) || 0;
  return Math.round((p - (p * d) / 100) * 100) / 100;
};
