import type { Maybe, Ohlc } from './math';
import { periodKey, type AnchorPeriod, type DayOf } from './periods';

/**
 * Previous day / week / month high, low and close as levels on the price (UA08): every bar of a period carries the
 * PREVIOUS completed period's values, so the lines step at each period's open. Periods are the symbol's trading days
 * (`tradingDay`: FX's 17:00 New York day, NYSE's session, crypto's UTC day); null before the first complete period.
 * Pure.
 */
export function previousPeriodLevels(
  bars: readonly Ohlc[],
  period: AnchorPeriod,
  tradingDay?: DayOf,
): { high: Maybe[]; low: Maybe[]; close: Maybe[] } {
  const n = bars.length;
  const high: Maybe[] = new Array<Maybe>(n).fill(null);
  const low: Maybe[] = new Array<Maybe>(n).fill(null);
  const close: Maybe[] = new Array<Maybe>(n).fill(null);
  let key: number | null = null;
  let cur: { h: number; l: number; c: number } | null = null;
  let prev: { h: number; l: number; c: number } | null = null;
  let closed = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const k = periodKey(b.time, period, tradingDay);
    if (k !== key) {
      // The first period seen may be partial (history starts inside it): it never becomes "previous".
      if (key !== null && cur && closed > 0) prev = cur;
      if (key !== null) closed++;
      key = k;
      cur = { h: b.high, l: b.low, c: b.close };
    } else if (cur) {
      cur.h = Math.max(cur.h, b.high);
      cur.l = Math.min(cur.l, b.low);
      cur.c = b.close;
    }
    if (prev) {
      high[i] = prev.h;
      low[i] = prev.l;
      close[i] = prev.c;
    }
  }
  return { high, low, close };
}
