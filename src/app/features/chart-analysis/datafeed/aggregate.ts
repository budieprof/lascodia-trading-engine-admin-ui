import type { CandleDto } from '@core/api/api.types';
import { resolutionSource, timeframeMs, type TvResolution } from './resolution';

/**
 * Client-side bar aggregation — for the STORED grid only (`resolution.ts`).
 *
 * The engine persists M1/M5/M15/H1/H4/D1, so `30` is built here from M15, and the bar still forming
 * on 5m … 1h is folded from M1. Fixed-width buckets on the UTC epoch grid are exact there.
 *
 * 2h, 4h, 1D, 1W and 1M are NOT bucketed here, nor anywhere in the client: they sit on the engine's
 * FX session grid (17:00 New York days, Monday–Friday weeks, DST-shifted UTC opens, the weekend
 * gap), which the engine lays out and `scripting/chart-bars` serves with each bar's close. Every
 * function below answers null / nothing for them rather than guess a calendar.
 */

/**
 * Bucket key for a source bar at `ms`, given the target resolution: the bucket's START time, which is
 * also the aggregated bar's time. Null for an unknown or a session-grid resolution.
 */
export function bucketStartFor(resolution: TvResolution, ms: number): number | null {
  const src = resolutionSource(resolution);
  if (!src || src.kind !== 'stored') return null;
  // Fixed-width buckets align to the UTC epoch grid, which is also where the
  // brokers emit (M30 → :00 and :30). Flooring is therefore exact, not an
  // approximation of the broker's own boundaries.
  const width = timeframeMs(src.timeframe) * src.aggregate;
  return Math.floor(ms / width) * width;
}

/**
 * Fold source bars into `resolution` buckets.
 *
 * Input MUST be ascending by timestamp — the reduction takes `open` from the
 * first bar it sees in a bucket and `close` from the last, so a descending input
 * silently produces inverted candles rather than failing.
 *
 * `volume` sums. `isClosed` is true only when every source bar in the bucket is
 * closed AND the bucket has a successor, i.e. we have positive evidence the
 * bucket is complete rather than merely the newest thing we fetched.
 */
export function aggregateCandles(candles: CandleDto[], resolution: TvResolution): CandleDto[] {
  const src = resolutionSource(resolution);
  if (!src || src.kind !== 'stored') return [];
  if (src.aggregate === 1) return candles;
  if (candles.length === 0) return [];

  const out: CandleDto[] = [];
  let bucketKey: number | null = null;
  let allClosed = true;

  for (const c of candles) {
    const ms = Date.parse(c.timestamp);
    if (Number.isNaN(ms)) continue;
    const key = bucketStartFor(resolution, ms);
    if (key === null) continue;

    if (key !== bucketKey) {
      if (out.length > 0) out[out.length - 1].isClosed = allClosed;
      bucketKey = key;
      allClosed = true;
      out.push({
        ...c,
        timestamp: new Date(key).toISOString(),
        timeframe: resolution,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        isClosed: false,
      });
    } else {
      const bar = out[out.length - 1];
      bar.high = Math.max(bar.high, c.high);
      bar.low = Math.min(bar.low, c.low);
      bar.close = c.close;
      bar.volume += c.volume;
    }
    if (!c.isClosed) allClosed = false;
  }

  // Every bucket is closed out when its successor appears. The last one has no
  // successor, so it stays open: we cannot tell a complete bucket from one
  // still in progress without fetching bars beyond the window we were asked for.
  if (out.length > 0) out[out.length - 1].isClosed = false;
  return out;
}

/** The subset of a bar the forming-bar fold needs. Matches `Bar` in candle-feed.service. */
export interface FoldBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fold near-live 1-minute bars into `resolution` buckets.
 *
 * <p>This is what builds the bar that is still FORMING. The engine stores a bar only once it has
 * closed, so the newest bar on any timeframe above M1 is never in the history. The chart used to
 * invent it from the first live tick the browser happened to receive: open the page forty minutes
 * into an H1 bar and that bar's open, high and low covered the last few seconds, not the hour — a
 * candle that visibly jumped away from the previous close. M1 bars are at most a minute behind, so
 * folding them gives the true open, high, low and volume.</p>
 *
 * <p>Input must be ascending. Output is ascending, one bar per bucket.</p>
 */
export function foldBars(bars: readonly FoldBar[], resolution: TvResolution): FoldBar[] {
  const out: FoldBar[] = [];
  for (const b of bars) {
    const key = bucketStartFor(resolution, b.time);
    if (key === null) continue;
    const tail = out[out.length - 1];
    if (tail && tail.time === key) {
      tail.high = Math.max(tail.high, b.high);
      tail.low = Math.min(tail.low, b.low);
      tail.close = b.close;
      tail.volume += b.volume;
    } else {
      out.push({
        time: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
    }
  }
  return out;
}

/**
 * Lay the forming bars over the chart's bars, without disturbing anything already stored.
 *
 * <ul>
 *   <li>Bars at or before `lastStored` came from the engine's history and are closed. They are
 *       authoritative and never replaced.</li>
 *   <li>After that, the folded M1 bars are the truth for open, high, low and volume.</li>
 *   <li>A live bar at the same time wins on CLOSE and widens high/low: ticks are newer than M1,
 *       which trails by up to a minute.</li>
 *   <li>A live bar newer than anything M1 has yet (a bucket that opened seconds ago) is kept as it
 *       is, and the next sync corrects it.</li>
 * </ul>
 */
export function mergeForming(
  current: readonly FoldBar[],
  folded: readonly FoldBar[],
  lastStored: number,
): FoldBar[] {
  const out = current.filter((b) => b.time <= lastStored).map((b) => ({ ...b }));
  const live = new Map(current.filter((b) => b.time > lastStored).map((b) => [b.time, b]));

  for (const f of folded) {
    if (f.time <= lastStored) continue;
    const l = live.get(f.time);
    if (l) {
      out.push({
        time: f.time,
        open: f.open,
        high: Math.max(f.high, l.high),
        low: Math.min(f.low, l.low),
        close: l.close,
        volume: Math.max(f.volume, l.volume),
      });
      live.delete(f.time);
    } else {
      out.push({ ...f });
    }
  }
  for (const l of live.values()) out.push({ ...l });
  return out.sort((a, b) => a.time - b.time);
}

/**
 * The newest bar in freshly loaded history that can be trusted as COMPLETE.
 *
 * <p>For a timeframe the engine stores, that is simply the last bar — the engine writes a bar only
 * once it has closed. For one this app builds by aggregation (30m from M15) the last bucket is
 * usually still open: it holds only the source bars that have closed so far. Treating it as complete
 * would freeze a half-built candle, so the cut-off sits just before it and the bucket is rebuilt from
 * M1 with the rest of the forming bars.</p>
 *
 * <p>Null for a session-grid resolution: its bars come from the engine with the forming one already
 * built, and nothing is folded from M1 for them.</p>
 */
export function lastCompleteBarTime(
  bars: readonly FoldBar[],
  resolution: TvResolution,
): number | null {
  if (bars.length === 0) return null;
  const src = resolutionSource(resolution);
  if (src?.kind === 'session') return null;
  const last = bars[bars.length - 1].time;
  const aggregated = src?.kind === 'stored' && src.aggregate !== 1;
  return aggregated ? last - 1 : last;
}
