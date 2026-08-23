import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import useSettings from '../../settings/useSettings';
import { formatPrice } from '../../utils/format';

/**
 * The values every policy page interpolates into its copy, plus the two readers
 * that resolve it.
 *
 * The store's name, the two delivery figures and the return window are all
 * admin-managed, so no policy hardcodes any of them — a rename, a change to the
 * free-delivery bar or a longer return threshold updates all seven pages at once.
 */
export default function usePolicyVars() {
  const { t, i18n } = useTranslation(['legal', 'common']);
  const { siteName, commerce } = useSettings();

  const vars = {
    app: siteName,
    freeShipping: formatPrice(commerce.freeShippingThreshold),
    shippingFee: formatPrice(commerce.shippingFlatRate),
    returnDays: commerce.returnWindowDays,
  };

  /**
   * i18next rebuilds a `returnObjects` result on every call, so an un-cached
   * `list()` would hand back a new array each render and defeat every `useMemo`
   * and dependency array downstream. Cached per language, store name and
   * commerce rules — the only things that change what the copy resolves to.
   */
  const cacheKey = `${i18n.language}|${siteName}|${JSON.stringify(commerce)}`;
  const cache = useRef({ key: cacheKey, entries: new Map() });
  if (cache.current.key !== cacheKey) cache.current = { key: cacheKey, entries: new Map() };

  return {
    t,
    i18n,
    vars,
    /** `t()` with the shared vars already applied. */
    tx: (key, options) => t(key, { ...vars, ...options }),
    /**
     * A nested block of content — a `sections` array, a `categories` array.
     * i18next walks the object and re-translates each leaf with the options it was
     * given, so `{{app}}` inside a deeply nested string still resolves.
     */
    list: (key) => {
      if (!cache.current.entries.has(key)) {
        const value = t(key, { ...vars, returnObjects: true });
        cache.current.entries.set(key, Array.isArray(value) ? value : []);
      }
      return cache.current.entries.get(key);
    },
  };
}
