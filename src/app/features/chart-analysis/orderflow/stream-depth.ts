import type { BookState } from '@core/realtime/md-book';
import type { MdSourceStream } from '@core/realtime/marketdata-stream';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';

/**
 * The streamed book (C4) in the shape the depth panel and the heatmap's live column already read
 * (`market-data/order-book/latest`'s {@link OrderBookSnapshot}), so the hub can replace the 1.5 s poll without either
 * consumer changing. `instanceId` carries the SOURCE id (the hub has no EA instance), flagged by `sourceId`.
 */
export function bookToSnapshot(symbol: string, sourceId: string, book: BookState, maxLevels = 50): OrderBookSnapshot | null {
  if (!book.known || !Number.isFinite(book.t)) return null;
  const bids = book.bidLevels().slice(0, maxLevels);
  const asks = book.askLevels().slice(0, maxLevels);
  if (!bids.length && !asks.length) return null;
  return {
    id: 0,
    symbol,
    bidPrice: bids[0]?.[0] ?? 0,
    askPrice: asks[0]?.[0] ?? 0,
    bidVolume: bids[0]?.[1] ?? 0,
    askVolume: asks[0]?.[1] ?? 0,
    spreadPoints: 0,
    levelsJson: JSON.stringify({
      bids: bids.map(([P, V]) => ({ P, V })),
      asks: asks.map(([P, V]) => ({ P, V })),
    }),
    instanceId: sourceId,
    capturedAt: new Date(book.t).toISOString(),
    sourceId,
  };
}

/** A stream is delivering a book when it is known and a frame came within this long (the EA sends an S every ≤ 30 s). */
export const STREAM_BOOK_FRESH_MS = 35_000;

/**
 * Which source's book to show: the preferred one when it is streaming a known book, else the known book updated most
 * recently. Null when no source has a book.
 */
export function pickBookStream(
  streams: readonly MdSourceStream[],
  preferred: string | null,
  nowMs: number,
): MdSourceStream | null {
  const live = streams.filter((s) => s.book.known && nowMs - s.lastFrameAt <= STREAM_BOOK_FRESH_MS);
  if (preferred) return live.find((s) => s.sourceId === preferred) ?? null;
  let best: MdSourceStream | null = null;
  for (const s of live) if (!best || s.book.t > best.book.t) best = s;
  return best;
}
