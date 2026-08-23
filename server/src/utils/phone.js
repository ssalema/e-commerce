/**
 * Phone numbers are stored as the ten digits the forms collect — the +91 is
 * presentation, added by whatever prints them. These two helpers are the pair:
 * `phoneDigits` on the way in, `displayPhone` on the way out.
 */

/** Whatever was typed or pasted, reduced to the ten digits we store. */
const phoneDigits = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 && digits.startsWith('91') ? digits.slice(2, 12) : digits.slice(0, 10);
};

/**
 * The stored number as a reader should see it. Anything that is not a plain ten
 * digit number is printed as held — a legacy value that already carries a country
 * code is better shown as typed than relabelled as Indian.
 */
const displayPhone = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^\d{10}$/.test(raw) ? `+91 ${raw}` : raw;
};

module.exports = { phoneDigits, displayPhone };
