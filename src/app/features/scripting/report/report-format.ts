import { formatUnits as unitsText } from '@shared/pine-chart/core/quantity';

import type { Num } from './strategy-report.model';

/**
 * Formatting for the Strategy report. Every function takes the report's `Num` (null = na) and
 * returns "—" for na, so a template never prints "null", "NaN" or "-0.00".
 *
 * Signs use a real minus (U+2212) and an explicit plus, so a value's direction is readable
 * without its colour.
 */

export const NA = '—';
export const MINUS = '\u2212';

const formatters = new Map<string, Intl.NumberFormat>();

function nf(min: number, max: number): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
    formatters.set(key, f);
  }
  return f;
}

function isNum(v: Num | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** "−0.00" is noise: anything that rounds to zero at the shown precision prints unsigned. */
function roundsToZero(v: number, decimals: number): boolean {
  return Math.abs(v) < 0.5 * Math.pow(10, -decimals);
}

function signed(body: string, v: number, decimals: number, showPlus: boolean): string {
  if (roundsToZero(v, decimals)) return body;
  if (v < 0) return `${MINUS}${body}`;
  return showPlus ? `+${body}` : body;
}

export interface MoneyOptions {
  /** Prefix a "+" on gains (losses always carry "−"). */
  signed?: boolean;
  decimals?: number;
}

/** "1,234.56 USD" — account currency as a suffix, like the Strategy Tester. */
export function formatMoney(v: Num | undefined, currency = '', opts: MoneyOptions = {}): string {
  if (!isNum(v)) return NA;
  const decimals = opts.decimals ?? 2;
  const body = nf(decimals, decimals).format(Math.abs(v));
  const text = signed(body, v, decimals, opts.signed === true);
  return currency ? `${text} ${currency}` : text;
}

export interface PercentOptions {
  signed?: boolean;
  decimals?: number;
}

/** "12.34%"; the input is already a percentage (the engine multiplies by 100). */
export function formatPercent(v: Num | undefined, opts: PercentOptions = {}): string {
  if (!isNum(v)) return NA;
  const decimals = opts.decimals ?? 2;
  const body = nf(decimals, decimals).format(Math.abs(v));
  return `${signed(body, v, decimals, opts.signed === true)}%`;
}

/** Plain number with thousands separators. */
export function formatNumber(v: Num | undefined, decimals = 2, signedPlus = false): string {
  if (!isNum(v)) return NA;
  const body = nf(decimals, decimals).format(Math.abs(v));
  return signed(body, v, decimals, signedPlus);
}

/** Ratios (profit factor, Sharpe, Sortino) — three decimals, as the Strategy Tester shows them. */
export function formatRatio(v: Num | undefined, decimals = 3): string {
  return formatNumber(v, decimals);
}

export function formatInteger(v: Num | undefined): string {
  if (!isNum(v)) return NA;
  return nf(0, 0).format(Math.round(v));
}

/** A bare quantity: up to 4 decimals, trailing zeros dropped. Its unit goes in the header. */
export function formatQty(v: Num | undefined): string {
  if (!isNum(v)) return NA;
  const body = nf(0, 4).format(Math.abs(v));
  return v < 0 ? `${MINUS}${body}` : body;
}

/**
 * A Pine quantity with its unit — "100,000 units", "1 unit" — for values that stand alone. A
 * report's quantities are always units: one Pine contract is one unit of the underlying, and the
 * engine converts to broker lots only where an order reaches a broker.
 */
export function formatUnits(v: Num | undefined): string {
  return isNum(v) ? unitsText(v) : NA;
}

/** Bar counts that may be averages ("12.5"). */
export function formatBars(v: Num | undefined): string {
  if (!isNum(v)) return NA;
  return nf(0, 1).format(v);
}

/** A price at a fixed precision (see {@link inferPriceDecimals}). */
export function formatPrice(v: Num | undefined, decimals = 5): string {
  if (!isNum(v)) return NA;
  return nf(decimals, decimals).format(v);
}

/**
 * The precision the prices were quoted at: the most decimals any of them carries (after rounding
 * away float noise), clamped to 2–6. EURUSD reads 5, USDJPY 3, an index 2.
 */
export function inferPriceDecimals(values: readonly Num[]): number {
  let decimals = 2;
  for (const v of values) {
    if (!isNum(v)) continue;
    const text = String(Number(v.toFixed(8)));
    const dot = text.indexOf('.');
    if (dot >= 0 && !text.includes('e')) decimals = Math.max(decimals, text.length - dot - 1);
    if (decimals >= 6) return 6;
  }
  return decimals;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "2026-03-04 13:00" in UTC (the report's times are Unix ms UTC). */
export function formatDateTime(ms: Num | undefined): string {
  if (!isNum(ms)) return NA;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return NA;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** "2026-03-04" in UTC. */
export function formatDate(ms: Num | undefined): string {
  if (!isNum(ms)) return NA;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return NA;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export type Polarity = 'pos' | 'neg' | 'zero' | 'na';

/** Which way a value points — drives the gain / loss text classes. */
export function polarity(v: Num | undefined): Polarity {
  if (!isNum(v)) return 'na';
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return 'zero';
}

export const MONTH_LABELS = [
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
