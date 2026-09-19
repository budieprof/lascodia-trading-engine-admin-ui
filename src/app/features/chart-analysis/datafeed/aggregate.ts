import type { CandleDto } from '@core/api/api.types';
import { resolutionSource, timeframeMs, type TvResolution } from './resolution';

/**
 * Client-side bar aggregation for the resolutions the engine does not store.
 *
 * The engine persists M1/M5/M15/H1/H4/D1 only, so `30`, `1W` and `1M` are built
 * here from the nearest stored timeframe.
 *
 * ── Why the week starts on SUNDAY ────────────────────────────────────────────
 * Verified against the live `Candle` table on 2026-09-19: D1 bars are stamped at
 * 00:00 and **Sunday bars exist** — 1,493 of them, the same count as Mondays —
 * with no Saturdays. The broker's trading week therefore runs Sunday→Friday
 * (the Sunday row is the short open session).
 *
 * Bucketing by ISO week (Monday start) would push every Sunday bar into the
 * PREVIOUS week, so each weekly candle would carry the wrong open and the wrong
 * low/high whenever the gap-open mattered. Nothing would error — the chart would
 * just quietly disagree with every other platform the operator cross-checks
 * against, which is the worst way for a charting bug to present.
 */

/** Start of the Sunday-anchored trading week containing `ms`, in UTC. */
export function weekStartMs(ms: number): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // getUTCDay(): 0 = Sunday. Subtracting it lands on the Sunday at or before.
  return dayStart - new Date(dayStart).getUTCDay() * 86_400_000;
}

/** Start of the UTC calendar month containing `ms`. */
export function monthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Bucket key for a source bar at `ms`, given the target resolution.
 * Returns the bucket's START time, which is also the aggregated bar's time.
 */
export function bucketStartFor(resolution: TvResolution, ms: number): number | null {
  const src = resolutionSource(resolution);
  if (!src) return null;
  if (src.aggregate === 'week') return weekStartMs(ms);
  if (src.aggregate === 'month') return monthStartMs(ms);
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
  if (!src) return [];
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
  // successor, so it stays open: we cannot tell a complete week from a week
  // still in progress without fetching bars beyond the window we were asked for.
  if (out.length > 0) out[out.length - 1].isClosed = false;
  return out;
}
