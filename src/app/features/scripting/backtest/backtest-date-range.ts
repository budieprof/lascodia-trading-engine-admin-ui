/** Quick date windows for the backtest forms: the run ends today (UTC) and starts this far back. */
export const DATE_RANGE_PRESETS = [
  { key: '3M', label: '3M', title: 'The last 3 months' },
  { key: '6M', label: '6M', title: 'The last 6 months' },
  { key: 'YTD', label: 'YTD', title: 'Since 1 January this year' },
  { key: '1Y', label: '1Y', title: 'The last year' },
  { key: '2Y', label: '2Y', title: 'The last 2 years' },
  { key: '5Y', label: '5Y', title: 'The last 5 years' },
] as const;

export type DateRangePresetKey = (typeof DATE_RANGE_PRESETS)[number]['key'];

/** `YYYY-MM-DD` of a date, in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The `{ fromDate, toDate }` (`YYYY-MM-DD`, UTC) a preset stands for, ending on `now`'s UTC day. */
export function presetRange(
  key: DateRangePresetKey,
  now: Date = new Date(),
): { fromDate: string; toDate: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  switch (key) {
    case '3M':
      from.setUTCMonth(from.getUTCMonth() - 3);
      break;
    case '6M':
      from.setUTCMonth(from.getUTCMonth() - 6);
      break;
    case 'YTD':
      from.setUTCMonth(0, 1);
      break;
    case '1Y':
      from.setUTCFullYear(from.getUTCFullYear() - 1);
      break;
    case '2Y':
      from.setUTCFullYear(from.getUTCFullYear() - 2);
      break;
    case '5Y':
      from.setUTCFullYear(from.getUTCFullYear() - 5);
      break;
  }
  return { fromDate: isoDay(from), toDate: isoDay(to) };
}

/** The preset a window matches exactly (to highlight its chip), or null. */
export function matchingPreset(
  fromDate: string,
  toDate: string,
  now: Date = new Date(),
): DateRangePresetKey | null {
  for (const p of DATE_RANGE_PRESETS) {
    const r = presetRange(p.key, now);
    if (r.fromDate === fromDate && r.toDate === toDate) return p.key;
  }
  return null;
}

/** "about 14 months · 61 weeks" style length of a window, for the hint under the dates; '' when invalid. */
export function describeSpan(fromDate: string, toDate: string): string {
  const from = Date.parse(fromDate);
  const to = Date.parse(toDate);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return '';
  const days = Math.round((to - from) / 86_400_000);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${days} days (about ${months} months)`;
  return `${days} days (about ${(days / 365.25).toFixed(1)} years)`;
}
