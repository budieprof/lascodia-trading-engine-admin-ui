import { isQuotaRefusal } from '@core/plans/quota-refusal';

import type { CashFlowKind, MonthReturn, YearReturn } from './fund.types';

/** "1.23 %" for a fraction; "—" when unknown. */
export function pct(fraction: number | null | undefined, digits = 2): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction)
    ? '—'
    : `${(fraction * 100).toFixed(digits)} %`;
}

/** A plain number with fixed decimals; "—" when unknown. */
export function num(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits);
}

/** Money with thousands separators. */
export function money(value: number | null | undefined, currency = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = value.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${text} ${currency}` : text;
}

/** "2026-10-24" from an ISO instant (UTC day). */
export function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** The default report period: the last `days` full UTC days ending today (to = tomorrow 00:00 UTC, exclusive). */
export function defaultPeriod(now: Date, days = 30): { from: string; to: string } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The period as the engine takes it (UTC midnight instants), or a problem in plain words. */
export function periodQuery(
  from: string,
  to: string,
): { from: string; to: string } | { problem: string } {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return { problem: 'Choose the period.' };
  if (t <= f) return { problem: 'The period must end after it starts.' };
  if (t - f > 366 * 86_400_000) return { problem: 'A report covers at most 366 days.' };
  return { from: `${from}T00:00:00Z`, to: `${to}T00:00:00Z` };
}

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export interface MonthlyRow {
  year: number;
  months: (number | null)[];
  total: number | null;
}

/** The monthly-returns grid: one row per year, twelve cells (null = no data) and the year's return. */
export function monthlyGrid(
  months: readonly MonthReturn[],
  years: readonly YearReturn[],
): MonthlyRow[] {
  const ys = [...new Set(months.map((m) => m.year))].sort((a, b) => a - b);
  return ys.map((y) => ({
    year: y,
    months: Array.from(
      { length: 12 },
      (_, i) => months.find((m) => m.year === y && m.month === i + 1)?.return ?? null,
    ),
    total: years.find((x) => x.year === y)?.return ?? null,
  }));
}

/** The sign a cash flow of this kind must carry (the engine refuses others). */
export function signedAmount(kind: CashFlowKind, amount: number): number {
  const abs = Math.abs(amount);
  if (kind === 'Deposit') return abs;
  if (kind === 'Withdrawal' || kind === 'Fee') return -abs;
  return amount;
}

/** A plan refusal (`-403-quota`): the page shows the upgrade notice instead of an error. */
export function isUpgradeNotice(err: unknown): boolean {
  return isQuotaRefusal(err);
}

/** SVG polyline points for a series scaled into a w×h box (empty for fewer than two points). */
export function sparkline(values: readonly number[], w: number, h: number, pad = 2): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = pad + (i * (w - 2 * pad)) / (values.length - 1);
      const y = h - pad - ((v - min) * (h - 2 * pad)) / span;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** "64 chars" → "ab12cd34…ef56" for showing a hash in a table. */
export function shortHash(hash: string | null | undefined): string {
  return !hash ? '—' : hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

/** True for a 64-character hex SHA-256. */
export function isSha256(text: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(text.trim());
}

/** Markout cell: "0.40 (n=12)". */
export function markoutCell(mean: number | null | undefined, samples: number | undefined): string {
  return mean === null || mean === undefined ? '—' : `${mean.toFixed(2)} (n=${samples ?? 0})`;
}
