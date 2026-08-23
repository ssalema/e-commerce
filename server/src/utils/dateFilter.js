const startOfDay = (value) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const endOfDay = (value) => {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
};

/**
 * ?range=month|year|all|custom (with ?from/?to for custom) -> a createdAt filter,
 * the same vocabulary the dashboard panels use. "all" — or anything unrecognised —
 * means no date narrowing at all.
 *
 * Shared by every admin list that offers the panel's Date control, so the three
 * Inbox tabs and the dashboard can never disagree about what "this month" means.
 */
function dateFilter(query) {
  // A custom window is whatever the two date inputs say, in either order, with
  // an open "to" meaning "up to today".
  if (query.from || query.to) {
    const from = new Date(query.from || query.to);
    const to = new Date(query.to || Date.now());
    if (!Number.isNaN(from.valueOf()) && !Number.isNaN(to.valueOf())) {
      return { $gte: startOfDay(Math.min(from, to)), $lte: endOfDay(Math.max(from, to)) };
    }
  }

  const range = String(query.range || '').toLowerCase();
  const from = new Date();

  if (range === 'month') from.setDate(from.getDate() - 29);
  else if (range === 'year') from.setFullYear(from.getFullYear() - 1);
  else return null;

  return { $gte: startOfDay(from) };
}

module.exports = { dateFilter, startOfDay, endOfDay };
