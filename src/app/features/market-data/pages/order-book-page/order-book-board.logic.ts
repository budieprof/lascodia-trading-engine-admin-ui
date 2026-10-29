import type { OrderBookSnapshotDto } from '@core/api/api.types';

export interface CandleWatermark {
  symbol: string;
  timeframe: string;
  latestTimestamp: string;
}

/** One symbol's latest broker book on the board (pages program). */
export interface BookBoardRow {
  symbol: string;
  snapshot: OrderBookSnapshotDto | null;
  /** Levels each side beyond top of book (0 = top of book only). */
  depth: number;
  ageSeconds: number | null;
}

/** Symbols whose newest M1 candle is recent — the ones EAs stream now (FX candles come from the EA). */
export function activeSymbols(
  rows: readonly CandleWatermark[],
  nowMs: number,
  maxAgeHours = 72,
): string[] {
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.timeframe === 'M1' &&
            nowMs - Date.parse(r.latestTimestamp) <= maxAgeHours * 3_600_000,
        )
        .map((r) => r.symbol),
    ),
  ].sort();
}

export function depthOf(levelsJson: string | null): number {
  if (!levelsJson) return 0;
  try {
    const p = JSON.parse(levelsJson) as { bids?: unknown[]; asks?: unknown[] };
    return Math.max(p.bids?.length ?? 0, p.asks?.length ?? 0);
  } catch {
    return 0;
  }
}

export function boardRow(
  symbol: string,
  s: OrderBookSnapshotDto | null,
  nowMs: number,
): BookBoardRow {
  return {
    symbol,
    snapshot: s,
    depth: s ? depthOf(s.levelsJson) : 0,
    ageSeconds: s ? Math.max(0, Math.round((nowMs - Date.parse(s.capturedAt)) / 1000)) : null,
  };
}

/** Freshest first, symbols without a book last. */
export function sortBoard(rows: readonly BookBoardRow[]): BookBoardRow[] {
  return [...rows].sort(
    (a, b) =>
      (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity) || a.symbol.localeCompare(b.symbol),
  );
}

/** The book to open when no symbol was asked for: EURUSD when it streams with depth, else the freshest with depth. */
export function defaultBook(rows: readonly BookBoardRow[], freshSeconds = 300): string | null {
  const fresh = rows.filter(
    (r) => r.ageSeconds !== null && r.ageSeconds <= freshSeconds && r.depth > 0,
  );
  return fresh.find((r) => r.symbol === 'EURUSD')?.symbol ?? sortBoard(fresh)[0]?.symbol ?? null;
}
