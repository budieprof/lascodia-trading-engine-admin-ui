import { bucketStartFor } from '../datafeed/aggregate';
import { resolutionSource, timeframeMs, type TvResolution } from '../datafeed/resolution';
import type { ChartStyle } from './chart-host.component';

/** Chart types whose bars are built from price movement — no bar "closes" on the clock. */
const NON_TIME_STYLES: ReadonlySet<ChartStyle> = new Set<ChartStyle>([
  'renko',
  'kagi',
  'pnf',
  'line-break',
  'range',
]);

export function isTimeStyle(style: ChartStyle): boolean {
  return !NON_TIME_STYLES.has(style);
}

/**
 * Close time (exclusive end, UTC ms) of the bar opening at `openMs` on the STORED grid (1m … 1h),
 * aligned exactly as the candle feed buckets periods (`bucketStartFor`): fixed widths on the UTC
 * epoch grid, so DST never moves a boundary. Null for a resolution the feed does not know, and for
 * the session grid (2h … 1M), where the engine sends each bar's close (`Bar.closeTime`) — weekends,
 * DST and month lengths are its calendar, not arithmetic here.
 */
export function barCloseMs(resolution: TvResolution, openMs: number): number | null {
  const src = resolutionSource(resolution);
  if (!src || src.kind !== 'stored') return null;
  const width = timeframeMs(src.timeframe) * src.aggregate;
  return Math.floor(openMs / width) * width + width;
}

/** TradingView's countdown text: `mm:ss` under 1 h, `hh:mm:ss` under a day, `Nd hh:mm` beyond. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (days > 0) return `${days}d ${pad(h)}:${pad(m)}`;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** How long without a live price before the countdown hides (market closed or feed down). */
export const STALE_FEED_MS = 3 * 60_000;

/**
 * The countdown for the newest bar, or null when there is nothing honest to count:
 * a non-time chart type, an unknown resolution, a newest bar that is not the period containing
 * `nowMs` (market closed / weekend / history only), or a live feed silent for {@link STALE_FEED_MS}.
 * At the boundary the bar it belongs to is over, so it shows nothing until the next bar opens —
 * never a negative count.
 *
 * `lastBarCloseMs` is the newest bar's own close when the engine sent one (the session grid): the bar
 * is current while `nowMs` is in [its open, that close), and the count runs to that close. Without
 * one, the stored grid's buckets decide both.
 */
export function countdownText(
  resolution: TvResolution,
  style: ChartStyle,
  lastBarOpenMs: number | null,
  nowMs: number,
  lastLiveMs: number | null,
  lastBarCloseMs: number | null = null,
): string | null {
  if (lastBarOpenMs === null || !isTimeStyle(style)) return null;
  if (lastLiveMs === null || nowMs - lastLiveMs > STALE_FEED_MS) return null;
  let close: number | null;
  if (lastBarCloseMs !== null && Number.isFinite(lastBarCloseMs)) {
    if (nowMs < lastBarOpenMs) return null;
    close = lastBarCloseMs;
  } else {
    const current = bucketStartFor(resolution, nowMs);
    if (current === null || current !== lastBarOpenMs) return null;
    close = barCloseMs(resolution, lastBarOpenMs);
  }
  if (close === null || close <= nowMs) return null;
  return formatCountdown(close - nowMs);
}
