import type { CandleDto } from '@core/api/api.types';

/**
 * Composing the in-progress bar from the live tick stream.
 *
 * <p><b>Why this exists.</b> The engine stores CLOSED bars only — the EA pushes
 * a candle when it completes, and nothing writes an in-progress row (the
 * `IsClosed` column has 4 rows set false in the entire table, all from April).
 * So the newest candle the API returns is the last COMPLETED bar, never the one
 * currently forming.</p>
 *
 * <p>Both charts previously assumed the opposite: they painted every live tick
 * onto <c>candles[length - 1]</c>, described in-code as "the in-progress
 * (rightmost) candle". Because that bar was already closed, the effect was a
 * chart permanently one bar behind, with the live price mutating a finished
 * candle's close/high/low instead of forming a new one.</p>
 *
 * <p>The fix is to decide, per tick, whether the rightmost bar is genuinely the
 * current bucket. If it is, patch it; if the clock has moved into a new bucket,
 * open a synthetic forming bar instead. That is how a live chart is normally
 * built when history and ticks arrive on separate channels.</p>
 */

/** Bucket width in milliseconds for the intraday timeframes. */
const MINUTE_MS = 60_000;
const INTRADAY_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
};

/**
 * Start of the timeframe bucket containing <paramref name="atMs"/>, in epoch ms.
 *
 * <p>Returns null for a timeframe whose boundary this cannot compute safely —
 * W1 depends on the broker's week-start convention, which the UI does not know.
 * Callers must treat null as "don't synthesize", not as "assume zero".</p>
 *
 * <p>All arithmetic is UTC. The engine timestamps candles in UTC and the charts
 * render them as such, so introducing local time here would silently shift every
 * bucket by the viewer's offset.</p>
 */
export function bucketStartMs(timeframe: string | null | undefined, atMs: number): number | null {
  if (!timeframe || !Number.isFinite(atMs)) return null;
  const tf = timeframe.toUpperCase();

  const minutes = INTRADAY_MINUTES[tf];
  if (minutes) {
    // Intraday buckets are aligned to the UTC epoch, which lands them on
    // midnight for every width here (1/5/15/30/60/240 all divide a day).
    const width = minutes * MINUTE_MS;
    return Math.floor(atMs / width) * width;
  }

  if (tf === 'D1') {
    const d = new Date(atMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // W1 (and anything unrecognised): the week boundary is a broker convention
  // (Sunday open for most FX venues, Monday elsewhere). Guessing would put the
  // synthetic bar in the wrong bucket for half the week, which is worse than
  // leaving the chart as it is.
  return null;
}

/**
 * Applies a live tick to a closed-bar history, returning the new series.
 *
 * <p>Either extends the current forming bar or opens one, depending on whether
 * the tick falls in the same bucket as the rightmost candle. Returns the SAME
 * array reference when nothing changed, so callers can skip a re-render.</p>
 *
 * @param candles Oldest-first series as returned by the API (closed bars).
 * @param timeframe Chart timeframe ("M1", "H4", …).
 * @param tickPrice Latest traded/bid price.
 * @param nowMs Wall-clock in epoch ms — injected so this is testable.
 */
export function applyTickToCandles(
  candles: readonly CandleDto[],
  timeframe: string | null | undefined,
  tickPrice: number,
  nowMs: number,
): CandleDto[] {
  const series = candles as CandleDto[];
  if (!Number.isFinite(tickPrice) || tickPrice <= 0) return series;
  if (series.length === 0) return series;

  const last = series[series.length - 1];
  const bucket = bucketStartMs(timeframe, nowMs);
  const lastMs = Date.parse(last.timestamp);

  // Unknown timeframe, or an unparseable timestamp: fall back to patching the
  // rightmost bar. Same as the old behaviour — wrong by one bar, but stable,
  // and strictly better than inventing a bucket we cannot place.
  if (bucket === null || !Number.isFinite(lastMs)) {
    return patchLast(series, last, tickPrice);
  }

  // A NEW bucket has begun: the rightmost bar is closed history. Open a forming
  // bar rather than mutating a finished candle — this is the actual bug fix.
  if (bucket > lastMs) {
    const forming: CandleDto = {
      id: -1, // synthetic: never persisted, and negative so it cannot collide
      symbol: last.symbol,
      timeframe: last.timeframe,
      open: tickPrice,
      high: tickPrice,
      low: tickPrice,
      close: tickPrice,
      volume: 0,
      timestamp: new Date(bucket).toISOString(),
      isClosed: false,
    };
    return [...series, forming];
  }

  // Same bucket — the rightmost bar IS the one forming, so extend it. This is
  // the path taken on every tick after the first within a bucket, and the only
  // path taken at all when the server has begun serving open bars.
  return patchLast(series, last, tickPrice);
}

function patchLast(series: CandleDto[], last: CandleDto, tickPrice: number): CandleDto[] {
  // Already covered by the bar's range — no visual change, so avoid the
  // allocation and let the caller skip re-rendering.
  if (last.close === tickPrice && last.high >= tickPrice && last.low <= tickPrice) return series;

  const updated: CandleDto = {
    ...last,
    close: tickPrice,
    high: Math.max(last.high, tickPrice),
    low: Math.min(last.low, tickPrice),
  };
  return [...series.slice(0, -1), updated];
}
