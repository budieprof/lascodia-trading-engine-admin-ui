import { utcMs } from '../panels/fx-fundamentals';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';

/**
 * OF-5 — order flow in Bar Replay: every layer stops at the replay head, and the depth panel shows the book as it was
 * there (C4, `market-data/order-book/recent?AsOfUtc=`), never a later one.
 */

/**
 * The instant the replay has revealed up to: the end of the newest unit on screen — the intrabar bar forming the head
 * (`unitMs` its resolution) or the last closed bar (its session close when it has one). Null outside replay.
 */
export function replayClipUtc(
  head: { time: number; closeTime?: number } | null,
  unitMs: number | null,
): number | null {
  if (!head) return null;
  if (head.closeTime !== undefined && head.closeTime > head.time) return head.closeTime;
  return unitMs && unitMs > 0 ? head.time + unitMs : head.time;
}

/** A book older than this at the head is shown, but called out as old. */
export const STALE_BOOK_MS = 5 * 60_000;

export type BookAtHead =
  | { kind: 'book'; snapshot: OrderBookSnapshot; ageMs: number; stale: boolean }
  /** The engine answered with a book captured AFTER the head (it ignored the point-in-time filter): not shown. */
  | { kind: 'future' }
  | { kind: 'none' };

/** What the replay depth panel may show for the snapshot C4 returned at `headUtc`. */
export function bookAtHead(snapshot: OrderBookSnapshot | null, headUtc: number): BookAtHead {
  if (!snapshot) return { kind: 'none' };
  const at = utcMs(snapshot.capturedAt);
  if (!Number.isFinite(at)) return { kind: 'none' };
  if (at > headUtc) return { kind: 'future' };
  const ageMs = headUtc - at;
  return { kind: 'book', snapshot, ageMs, stale: ageMs > STALE_BOOK_MS };
}
