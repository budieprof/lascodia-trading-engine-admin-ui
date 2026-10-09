/**
 * Pure defaults of the create-signal dialog (SP-13): the operator picks the strategy a manual signal is credited to
 * (no silent fallback to the first active one), and the default stop is ATR-based from real closed candles — not a
 * fixed 30 pips, which was 0.3 ATR on GBPJPY H1 and 3 ATR on EURCHF.
 */
import type { CandleDto, StrategyDto } from '@core/api/api.types';
import { atr, type Ohlc } from '@features/chart-analysis/indicators/math';

/** The stop sits this many ATRs from the entry. */
export const ATR_STOP_MULTIPLE = 1.5;
/** The target is this many times the stop distance (2R). */
export const REWARD_MULTIPLE = 2;
export const ATR_PERIOD = 14;
/** Candles read for the ATR: the period's warm-up plus a margin. */
export const ATR_CANDLES = 60;

/** Wilder ATR(period) of the CLOSED candles (any order); null with too few of them. */
export function atrFromCandles(candles: readonly CandleDto[], period = ATR_PERIOD): number | null {
  const bars: Ohlc[] = candles
    .filter((c) => c.isClosed !== false)
    .map((c) => ({ time: Date.parse(c.timestamp), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .filter((b) => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
  if (bars.length < period + 1) return null;
  const v = atr(bars, period).at(-1);
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

/** Round a price to the pair's digits. */
export function roundTo(price: number, digits: number): number {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)));
  return Math.round(price * f) / f;
}

/** Stop at `multiple` × ATR beyond the entry, target at `reward` × that distance on the other side. */
export function atrLevels(
  entry: number,
  direction: 'Buy' | 'Sell',
  atrValue: number,
  digits: number,
  multiple = ATR_STOP_MULTIPLE,
  reward = REWARD_MULTIPLE,
): { stopLoss: number; takeProfit: number; stopDistance: number } {
  const stopDistance = atrValue * multiple;
  const sign = direction === 'Buy' ? 1 : -1;
  return {
    stopLoss: roundTo(entry - sign * stopDistance, digits),
    takeProfit: roundTo(entry + sign * stopDistance * reward, digits),
    stopDistance,
  };
}

/** One pip for the pair: 10 points on a 3/5-digit quote, else one point. */
export function pipSizeFor(digits: number): number {
  return digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits;
}

/** The candles' timeframe for the ATR: the strategy's own, else H1. */
export function atrTimeframe(strategy: Pick<StrategyDto, 'timeframe'> | null | undefined): string {
  return strategy?.timeframe || 'H1';
}

/**
 * Strategies in pick order: those trading the signal's symbol first (by id), then the rest — every one selectable, so
 * the operator decides; a mismatch is warned about, not prevented.
 */
export function orderStrategies<T extends Pick<StrategyDto, 'id' | 'symbol'>>(list: readonly T[], symbol: string): T[] {
  const sym = symbol.trim().toUpperCase();
  const matches = (s: T) => !!sym && (s.symbol ?? '').toUpperCase() === sym;
  return [...list].sort((a, b) => Number(matches(b)) - Number(matches(a)) || a.id - b.id);
}
