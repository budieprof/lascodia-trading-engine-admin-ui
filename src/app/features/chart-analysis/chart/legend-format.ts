/**
 * How the legend and the data window print a bar (CC-18, CC-I6). Pure.
 */

const MINUS = '−';

const signed = (v: number, digits: number) =>
  `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(digits)}`;

/**
 * The bar's change from the previous close, as TradingView prints it with pips: "−0.00002 / −0.2 pip
 * (−0.00%)". `pip` in price (null: no pip part); `precision` the quote's decimals. Null without a
 * previous bar.
 */
export function changeText(
  change: number | null,
  changePct: number | null,
  pip: number | null,
  precision: number,
): string | null {
  if (change === null || !Number.isFinite(change)) return null;
  const parts = [signed(change, precision)];
  if (pip !== null && pip > 0) {
    const pips = change / pip;
    parts.push(`${signed(pips, 1)} ${Math.abs(pips) === 1 ? 'pip' : 'pips'}`);
  }
  const price = parts.join(' / ');
  return changePct === null || !Number.isFinite(changePct)
    ? price
    : `${price} (${signed(changePct, 2)}%)`;
}

/** Volume as TradingView abbreviates it: 950, 1.23K, 4.5M, 2.1B. */
export function formatVolume(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const short = (n: number, unit: string) =>
    `${(Math.round(n * 100) / 100).toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2).replace(/\.?0+$/, '')}${unit}`;
  if (abs >= 1e9) return short(v / 1e9, 'B');
  if (abs >= 1e6) return short(v / 1e6, 'M');
  if (abs >= 1e3) return short(v / 1e3, 'K');
  return String(Math.round(v));
}

/**
 * A study value as the data window prints it: the symbol's decimals for a value on the price scale,
 * up to 4 significant decimals otherwise, "—" for none.
 */
export function formatStudyValue(
  v: number | null | undefined,
  onPriceScale: boolean,
  precision: number,
): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (onPriceScale) return v.toFixed(precision);
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  return v.toFixed(digits);
}
