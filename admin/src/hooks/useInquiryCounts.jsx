import { createContext, useCallback, useContext, useMemo } from 'react';

import { inquiryApi } from '../api/endpoints';
import useFetch from './useFetch';
import { useLiveRefetch } from '../realtime/useRealtime';
import { INQUIRY_EVENTS, CAREER_EVENTS } from '../realtime/events';

const EMPTY = { messages: 0, careers: 0, total: 0 };

const InquiryCountsContext = createContext({ counts: EMPTY, refresh: () => {} });

/**
 * How many unread enquiries and job applications are waiting, shared by the
 * sidebar's Inquiries badge and the two tab badges on the Inquiries page.
 *
 * The counts are read from the server on every mount rather than kept in the
 * browser, because "new" is a stored property of the record: it survives a
 * refresh, a logout and the next admin who signs in, and only opening the
 * message — or, for an application, opening it or moving its status — clears it.
 *
 * One provider sits above the whole panel so the two badges can never disagree,
 * and both a realtime event and an explicit `refresh()` from the tab that just
 * marked something read bring them back in step.
 */
export function InquiryCountsProvider({ children }) {
  const query = useFetch(useCallback(() => inquiryApi.stats(), []), []);

  // A submission from the storefront, or another admin opening a record, moves
  // these numbers without this tab doing anything.
  useLiveRefetch(query.refetch, [...INQUIRY_EVENTS, ...CAREER_EVENTS]);

  const stats = query.data?.data?.stats;
  const badges = stats?.newBadges;

  const value = useMemo(
    () => ({
      counts: badges
        ? {
            messages: badges.messages || 0,
            careers: badges.careers || 0,
            total: badges.total || 0,
          }
        : EMPTY,
      refresh: query.refetch,
    }),
    [badges, query.refetch]
  );

  return <InquiryCountsContext.Provider value={value}>{children}</InquiryCountsContext.Provider>;
}

/** `{ counts: { messages, careers, total }, refresh }`. */
export default function useInquiryCounts() {
  return useContext(InquiryCountsContext);
}
