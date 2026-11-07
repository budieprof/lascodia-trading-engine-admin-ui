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

/**
 * The signal-sensitivity and LLM-backtest sensitivity analyses (engine AnalyzeSignalSensitivityQuery /
 * AnalyzeLlmBacktestSensitivityQuery `Aggregate`) write 999 — not 9999 — for "no losing trades", and so does the
 * page's own client-side recomputation of a filtered aggregate. Pass it as `noLossAt` for those numbers.
 * (CME experiments send decimal.MaxValue, which the default threshold already covers.)
 */
export const PF_SENSITIVITY_NO_LOSS = 999;

/** Tooltip text for a profit factor shown as "∞". */
export const PF_NO_LOSS_TITLE = 'No losing trades — not a measured ratio';

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

/**
 * True when the engine's 9999 "no losing trades" sentinel (or anything above it) is present. `noLossAt` lowers the
 * threshold for producers that use another sentinel ({@link PF_SENSITIVITY_NO_LOSS}).
 */
export function isNoLossProfitFactor(
  v: number | null | undefined,
  noLossAt = PF_NO_LOSS_SENTINEL,
): boolean {
  return finite(v) && v >= noLossAt;
}

/**
 * Profit factor for display: the 9999 sentinel (or `noLossAt`) → "∞", no trades or no value → "—", otherwise the
 * ratio with `digits` decimals.
 */
export function fmtProfitFactor(
  v: number | null | undefined,
  digits = 2,
  hasTrades = true,
  noLossAt = PF_NO_LOSS_SENTINEL,
): string {
  if (!hasTrades || !finite(v)) return DASH;
  if (isNoLossProfitFactor(v, noLossAt)) return '∞';
  return v.toFixed(digits);
}

/** `title` for a profit-factor cell: explains "∞", empty otherwise. */
export function profitFactorTitle(
  v: number | null | undefined,
  noLossAt = PF_NO_LOSS_SENTINEL,
): string {
  return isNoLossProfitFactor(v, noLossAt) ? PF_NO_LOSS_TITLE : '';
}

/**
 * A DIFFERENCE of two profit factors (e.g. real − proxy). When either side was a no-loss sentinel the difference is
 * meaningless (≈ ±sentinel): "—" instead of a nine-digit number.
 */
export function fmtProfitFactorDelta(
  v: number | null | undefined,
  digits = 2,
  noLossAt = PF_NO_LOSS_SENTINEL,
): string {
  if (!finite(v) || Math.abs(v) >= noLossAt / 2) return DASH;
  return v.toFixed(digits);
}
