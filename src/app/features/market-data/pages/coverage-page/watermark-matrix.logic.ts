import type { CandleWatermark } from '../order-book-page/order-book-board.logic';

export const MATRIX_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;

/** How long after a bar's period a timeframe counts as current (a D1 bar is stamped at its day's start). */
const FRESH_MINUTES: Record<string, number> = {
  M1: 15,
  M5: 30,
  M15: 60,
  H1: 180,
  H4: 600,
  D1: 3 * 1440,
};

export interface MatrixCell {
  latest: string | null;
  ageMinutes: number | null;
  fresh: boolean;
}

export interface MatrixRow {
  symbol: string;
  cells: Record<string, MatrixCell>;
  /** Every timeframe current. */
  current: boolean;
}

export function ageText(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 90) return `${Math.max(0, Math.round(minutes))} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

/** Newest candle per symbol × timeframe (`GET market-data/candle/watermarks`), current symbols first. */
export function watermarkMatrix(rows: readonly CandleWatermark[], nowMs: number): MatrixRow[] {
  const by = new Map<string, Record<string, MatrixCell>>();
  for (const r of rows) {
    const cells = by.get(r.symbol) ?? {};
    const age = (nowMs - Date.parse(r.latestTimestamp)) / 60_000;
    cells[r.timeframe] = {
      latest: r.latestTimestamp,
      ageMinutes: age,
      fresh: age <= (FRESH_MINUTES[r.timeframe] ?? 60),
    };
    by.set(r.symbol, cells);
  }
  return [...by.entries()]
    .map(([symbol, cells]) => {
      for (const tf of MATRIX_TIMEFRAMES)
        cells[tf] ??= { latest: null, ageMinutes: null, fresh: false };
      return { symbol, cells, current: MATRIX_TIMEFRAMES.every((tf) => cells[tf].fresh) };
    })
    .sort((a, b) => Number(b.current) - Number(a.current) || a.symbol.localeCompare(b.symbol));
}
