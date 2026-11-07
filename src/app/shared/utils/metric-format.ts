/**
 * One place for the engine's metric UNITS, so a fraction is never printed as a percent again.
 *
 * Wire units (engine BacktestMetricsCalculator / StrategyHealthWorker):
 *  - `winRate`                 FRACTION 0..1   → print with {@link fmtFraction}
 *  - `totalReturn`, `maxDrawdownPct`, `*Pct`   PERCENT          → print with {@link fmtPct}
 *  - `profitFactor` 9999       sentinel "no losing trades"     → print with {@link fmtProfitFactor}
 *
 * A static spec (metric-format.spec.ts) rejects calling toFixed on a raw `winRate` anywhere in the app: a win rate
 * of 0.52 came out as "0.5%" on the strategy form's preview for as long as that pattern existed.
 */

/** The engine writes this for a profit factor with no losing trades — not a measured ratio. */
export const PF_NO_LOSS_SENTINEL = 9999;

const DASH = '—';

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A fraction (0..1) as a percent string: 0.523 → "52.3%". null / NaN → "—". */
export function fmtFraction(v: number | null | undefined, digits = 1): string {
  return finite(v) ? `${(v * 100).toFixed(digits)}%` : DASH;
}

/** A value that is ALREADY a percent: 12.34 → "12.3%". null / NaN → "—". */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  return finite(v) ? `${v.toFixed(digits)}%` : DASH;
}

/** A fraction (0..1) as a percent number for charts / metric cards: 0.523 → 52.3. */
export function fractionToPct(v: number | null | undefined): number | null {
  return finite(v) ? v * 100 : null;
}

/** True when the engine's 9999 "no losing trades" sentinel (or anything above it) is present. */
export function isNoLossProfitFactor(v: number | null | undefined): boolean {
  return finite(v) && v >= PF_NO_LOSS_SENTINEL;
}

/**
 * Profit factor for display: the 9999 sentinel → "∞", no trades or no value → "—", otherwise the
 * ratio with `digits` decimals.
 */
export function fmtProfitFactor(
  v: number | null | undefined,
  digits = 2,
  hasTrades = true,
): string {
  if (!hasTrades || !finite(v)) return DASH;
  if (isNoLossProfitFactor(v)) return '∞';
  return v.toFixed(digits);
}
