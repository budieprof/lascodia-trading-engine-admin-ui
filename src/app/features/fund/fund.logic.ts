import { isQuotaRefusal } from '@core/plans/quota-refusal';

import type {
  CashFlow,
  CashFlowKind,
  FillGroupStats,
  FlowSource,
  MonthReturn,
  PerformanceFlow,
  YearReturn,
} from './fund.types';

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

/** "2026-08-26 19:37" (UTC) for an ISO time; "—" when unknown. */
export function minuteUtc(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}

/** A statement flow's source; an engine older than the broker ledger sends only `inferred`. */
export function flowSource(f: Pick<PerformanceFlow, 'inferred' | 'source'>): FlowSource {
  return f.source ?? (f.inferred ? 'inferred' : 'recorded');
}

/** The chip shown for a flow source: label, tone and what it means (title). */
export function flowSourceChip(source: FlowSource): {
  label: string;
  tone: '' | 'ok' | 'warn';
  title: string;
} {
  switch (source) {
    case 'broker':
      return {
        label: 'broker',
        tone: 'ok',
        title: "The broker's own balance deal, reported by the EA",
      };
    case 'inferred':
      return {
        label: 'inferred',
        tone: 'warn',
        title: 'Equity moved on a day with no position open; no flow was reported or recorded',
      };
    default:
      return { label: 'recorded', tone: '', title: 'Entered by hand' };
  }
}

/** When a statement flow happened: the minute when known, else its day. */
export function flowWhen(f: Pick<PerformanceFlow, 'dayUtc' | 'atUtc'>): string {
  return f.atUtc ? minuteUtc(f.atUtc) : day(f.dayUtc);
}

/** Who a ledger row comes from: "Broker deal #123" (reported by the EA) or the person who entered it. */
export function ledgerSource(f: Pick<CashFlow, 'brokerDealTicket' | 'recordedBy'>): string {
  return f.brokerDealTicket ? `Broker deal #${f.brokerDealTicket}` : f.recordedBy;
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

/** A summary tile: label, value, a hint line and an optional tone. */
export interface SummaryTile {
  label: string;
  value: string;
  hint: string;
  tone?: 'pos' | 'neg' | '';
}

/** The headline tiles of a best-execution report (its "All fills" row). Pips are costs when positive. */
export function bestExTiles(r: {
  fillsMeasured: number;
  markoutHorizons: string[];
  overall: FillGroupStats;
}): SummaryTile[] {
  const o = r.overall;
  const h = r.markoutHorizons.findIndex((x) => x === '60s' || x === '1m');
  const mi = h >= 0 ? h : r.markoutHorizons.length - 1;
  const mo = mi >= 0 ? (o.meanMarkoutPips[mi] ?? null) : null;
  const tone = (v: number | null, costPositive = true): SummaryTile['tone'] =>
    v === null || v === 0 ? '' : v > 0 === costPositive ? 'neg' : 'pos';
  return [
    {
      label: 'Fills measured',
      value: String(r.fillsMeasured),
      hint: `${num(o.lots)} lots · ${o.withArrivalBenchmark} with an arrival price`,
    },
    {
      label: 'Mean slippage vs arrival',
      value: `${num(o.meanSlippagePips)} pips`,
      hint: `median ${num(o.medianSlippagePips)} · 95th pct |slip| ${num(o.p95AbsSlippagePips)}`,
      tone: tone(o.meanSlippagePips),
    },
    {
      label: 'Filled better than arrival',
      value: pct(o.priceImprovementShare, 0),
      hint: `vs requested price ${num(o.meanVsRequestedPips)} pips`,
    },
    {
      label: 'Effective spread',
      value: `${num(o.meanEffectiveSpreadPips)} pips`,
      hint: `quoted ${num(o.meanQuotedSpreadPips)} pips at the fill`,
      tone: tone(o.meanEffectiveSpreadPips),
    },
    {
      label: 'Fill latency',
      value: `${num(o.medianLatencyMs, 0)} ms`,
      hint: `p95 ${num(o.p95LatencyMs, 0)} ms (submit → fill)`,
    },
    {
      label: `Markout ${mi >= 0 ? r.markoutHorizons[mi] : ''}`.trim(),
      value: `${num(mo)} pips`,
      hint:
        mi >= 0
          ? `${pct(o.favourableMarkoutShare[mi] ?? null, 0)} favourable · n=${o.markoutSamples[mi] ?? 0}`
          : 'no markout horizon',
      tone: tone(mo, false),
    },
    { label: 'Commission paid', value: money(o.commission), hint: 'account currency, all fills' },
  ];
}

/**
 * The accounts a page opens on: the scope's accounts that are active (in the active list's order of the scope), at most
 * `max`; without an active list (null) the first `max` of the scope.
 */
export function liveScopeAccounts<T extends { id: number }>(
  accounts: readonly T[],
  activeIds: readonly number[] | null,
  max = 8,
): T[] {
  const live = activeIds === null ? accounts : accounts.filter((a) => activeIds.includes(a.id));
  return live.slice(0, max);
}

/** Each value as a percent of the largest (bar heights / widths); all 0 when every value is 0. */
export function shareOfMax(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 ? Math.round((Math.max(0, v) / max) * 1000) / 10 : 0));
}

/** Plain words for the engine's enum names in breakdowns ("PartiallyFilled" → "Partially filled"). */
export function enumWords(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
