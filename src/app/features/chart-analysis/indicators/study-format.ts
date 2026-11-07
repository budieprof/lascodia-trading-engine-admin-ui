import type { Maybe } from './math';

/**
 * How many decimals a study's values and its pane's axis print with (UA10).
 *
 * FX keeps what it has always had (null here: the pane's histograms at 5 decimals, the legend's `1.2-5`) — a MACD on
 * EURUSD is a few pips, so five decimals is right there. Every other instrument printed the same five: a MACD on BTC-USD
 * read "-106.04026" on an axis of "-1000.00000", AAPL's "4.00000".
 *
 * Non-FX:
 * - a study on the price pane (an SMA, Bollinger) is a price: the instrument's own decimals;
 * - a study in its own pane is sized by its values: three significant digits at the largest magnitude it reaches
 *   (BTC MACD ≈ 1000 → 2, AAPL MACD ≈ 4 → 3, a 0.0003 spread oscillator → 6), never fewer than two (or the
 *   instrument's precision when that is under two), never more than eight.
 * Pure.
 */
export function studyDigits(opts: {
  overlay: boolean;
  /** The instrument's price decimals (`facts.precision`). */
  precision: number;
  isFx: boolean;
  /** The study's plotted values (any number of series); only used for a pane. */
  values?: Iterable<readonly Maybe[]>;
}): number | null {
  if (opts.isFx) return null;
  const precision = Math.max(0, Math.min(10, Math.round(opts.precision)));
  if (opts.overlay) return precision;
  let maxAbs = 0;
  for (const series of opts.values ?? [])
    for (const v of series)
      if (v !== null && v !== undefined && Number.isFinite(v))
        maxAbs = Math.max(maxAbs, Math.abs(v));
  const floor = Math.min(2, precision);
  if (maxAbs === 0) return Math.max(floor, 2);
  const digits = Math.ceil(3 - Math.log10(maxAbs));
  return Math.max(floor, Math.min(8, digits));
}

/** A price format at `digits` decimals (the axis and the last-value chip). */
export function digitsFormat(digits: number): {
  type: 'price';
  precision: number;
  minMove: number;
} {
  return { type: 'price', precision: digits, minMove: 10 ** -digits };
}

/** The legend's Angular `number` format for a value: FX (null) keeps `1.2-5`; otherwise exactly `digits`. */
export function legendDigitsFormat(digits: number | null | undefined): string {
  return digits === null || digits === undefined ? '1.2-5' : `1.${digits}-${digits}`;
}
