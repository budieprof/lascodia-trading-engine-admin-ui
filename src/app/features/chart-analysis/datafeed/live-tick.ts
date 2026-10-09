import { applyStoredTick } from './aggregate';
import type { Bar } from './candle-feed.service';
import { isSessionResolution, type TvResolution } from './resolution';
import { applySessionTick } from './session-bars';
import { nextSessionPeriod, type TradingCalendar } from './session-calendar';

/**
 * A live price on a series that is not the chart's own — a compare study's other symbol (CC-13), a
 * split panel (CC-12): the newest bar moves, or the next one opens, by the same rules as the main
 * chart's (`applyStoredTick` on 1m … 1h, `applySessionTick` on the session grid, the symbol's
 * session laying out the next period when known). Null when the price changes nothing — or when only
 * the engine can say where the next period opens: these series have no resync of their own, and
 * catch up on their next load.
 */
export function liveTick(
  bars: readonly Bar[],
  price: number,
  nowMs: number,
  resolution: TvResolution,
  calendar: TradingCalendar | null,
): Bar[] | null {
  if (bars.length === 0 || !Number.isFinite(price)) return null;
  if (isSessionResolution(resolution)) {
    const outcome = applySessionTick(
      bars,
      price,
      nowMs,
      calendar ? (last, now) => nextSessionPeriod(calendar, resolution, last, now) : undefined,
    );
    return outcome.kind === 'update' || outcome.kind === 'open' ? outcome.bars : null;
  }
  return applyStoredTick(bars, price, nowMs, resolution) as Bar[] | null;
}
