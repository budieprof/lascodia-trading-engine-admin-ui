import { toCsv } from '@features/scripting/shared/download';

/**
 * U11 — a backtest's engine trade list (`ResultJson.Trades`, PascalCase) as grid rows with what the run recorded about
 * each trade's path: its R (the engine's `RMultiple`, else PnL ÷ RiskedAmount), the maximum favourable / adverse
 * excursion (MFE / MAE, account currency, measured on the simulated price path) and, when the trade risked a known
 * amount, the excursions in R as well. Fields an older run did not record stay empty — never filled in. Pure.
 */

export interface LegacyTradeRow {
  index: number;
  direction: 'Long' | 'Short';
  entryTime: string;
  exitTime: string;
  entryPrice: number | null;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lots: number | null;
  pnl: number | null;
  r: number | null;
  /** Account currency, ≥ 0; null when the run did not record it. */
  mfe: number | null;
  mae: number | null;
  mfeR: number | null;
  maeR: number | null;
  bars: number | null;
  exitReason: string;
  commission: number | null;
  swap: number | null;
}

const EXIT_REASONS: Record<number, string> = {
  0: 'Stop loss',
  1: 'Take profit',
  2: 'End of data',
  3: 'Trailing stop',
  4: 'Strategy exit',
  5: 'Margin call',
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function exitReasonText(v: unknown): string {
  if (typeof v === 'number') return EXIT_REASONS[v] ?? String(v);
  return str(v);
}

export function legacyTradeRows(trades: readonly unknown[]): LegacyTradeRow[] {
  return trades
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => {
      const pnl = num(t['PnL']);
      const risked = num(t['RiskedAmount']);
      const r =
        num(t['RMultiple']) ??
        (pnl !== null && risked !== null && risked > 0 ? pnl / risked : null);
      const mfe = num(t['MaxFavorableExcursion']);
      const mae = num(t['MaxAdverseExcursion']);
      const perR = risked !== null && risked > 0 ? risked : null;
      const dir = t['Direction'];
      return {
        index: i + 1,
        direction: dir === 1 || dir === 'Sell' || dir === 'Short' ? 'Short' : 'Long',
        entryTime: str(t['EntryTime']),
        exitTime: str(t['ExitTime']),
        entryPrice: num(t['EntryPrice']),
        exitPrice: num(t['ExitPrice']),
        stopLoss: num(t['StopLoss']),
        takeProfit: num(t['TakeProfit']),
        lots: num(t['LotSize']),
        pnl,
        r,
        mfe,
        mae,
        mfeR: mfe !== null && perR !== null ? mfe / perR : null,
        maeR: mae !== null && perR !== null ? mae / perR : null,
        bars: num(t['BarsInTrade']),
        exitReason: exitReasonText(t['ExitReason']),
        commission: num(t['Commission']),
        swap: num(t['Swap']),
      } satisfies LegacyTradeRow;
    });
}

/** True when the run recorded excursions for at least one trade (older runs record none). */
export function hasExcursions(rows: readonly LegacyTradeRow[]): boolean {
  return rows.some((r) => r.mfe !== null || r.mae !== null);
}

export function legacyTradesCsv(rows: readonly LegacyTradeRow[]): string {
  return toCsv(
    [
      '#',
      'Direction',
      'Entry time (UTC)',
      'Exit time (UTC)',
      'Entry price',
      'Exit price',
      'Stop loss',
      'Take profit',
      'Lots',
      'P&L',
      'R',
      'MFE',
      'MAE',
      'MFE (R)',
      'MAE (R)',
      'Bars',
      'Exit reason',
      'Commission',
      'Swap',
    ],
    rows.map((r) => [
      r.index,
      r.direction,
      r.entryTime,
      r.exitTime,
      r.entryPrice,
      r.exitPrice,
      r.stopLoss,
      r.takeProfit,
      r.lots,
      r.pnl,
      r.r,
      r.mfe,
      r.mae,
      r.mfeR,
      r.maeR,
      r.bars,
      r.exitReason,
      r.commission,
      r.swap,
    ]),
  );
}
