import { describe, expect, it } from 'vitest';
import type { StrategyReport } from '@features/scripting/report/strategy-report.model';
import { ladderFromDslTrades, ladderFromScriptReport } from './backtest-martingale';

const rt = (number: number, rMultiple: number | null, exitLeg = '', isOpen = false) => ({
  number,
  isOpen,
  entryTime: Date.UTC(2026, 0, 1, number),
  exitTime: Date.UTC(2026, 0, 1, number, 30),
  rMultiple,
  exitLeg,
});
const report = (trades: unknown[], trimmedTrades = 0) =>
  ({ meta: { symbol: 'EURUSD', trimmedTrades }, trades }) as unknown as StrategyReport;

describe('ladderFromScriptReport', () => {
  it('uses the report R, drops open trades and sizes for the smallest take-profit R', () => {
    const l = ladderFromScriptReport(
      report([
        rt(1, -1, 'StopLoss'),
        rt(2, 2.9, 'TakeProfit'),
        rt(3, 3.1, 'TakeProfit'),
        rt(4, 0.4),
        rt(5, null, '', true),
      ]),
    );
    expect(l.trades.map((t) => t.r)).toEqual([-1, 2.9, 3.1, 0.4]);
    expect(l.trades.every((t) => t.geomR === null && t.symbol === 'EURUSD')).toBe(true);
    expect(l.assumedGeomR).toBe(2.9);
    expect(l.geomNote).toContain('2 trades');
    expect(l.notice).toBeNull();
  });

  it('falls back to 1R without take-profit exits and flags a trimmed list', () => {
    const l = ladderFromScriptReport(report([rt(1, -1), rt(2, 0.5)], 120));
    expect(l.assumedGeomR).toBe(1);
    expect(l.notice).toContain('120');
  });
});

describe('ladderFromDslTrades', () => {
  const t = (
    dir: number,
    entry: number,
    exit: number,
    sl: number | null,
    tp: number | null,
    pnl: number,
    gross: number,
    h: number,
  ) => ({
    Direction: dir,
    EntryPrice: entry,
    ExitPrice: exit,
    StopLoss: sl,
    TakeProfit: tp,
    PnL: pnl,
    GrossPnL: gross,
    EntryTime: new Date(Date.UTC(2026, 0, 1, h)).toISOString(),
    ExitTime: new Date(Date.UTC(2026, 0, 1, h, 30)).toISOString(),
  });
  it('derives R from prices net of costs and R:R from the recorded target', () => {
    const l = ladderFromDslTrades(
      [
        t(0, 1.1, 1.102, 1.099, 1.102, 180, 200, 1),
        t(1, 1.1, 1.101, 1.101, 1.098, -110, -100, 2),
        t(0, 1.1, 1.1, null, null, -5, 0, 3),
      ],
      'EURUSD',
    );
    expect(l.trades[0].r).toBeCloseTo(2 * 0.9);
    // Net of the trade's own costs: a win at its target is exactly its sizing R.
    expect(l.trades[0].geomR).toBeCloseTo(l.trades[0].r!);
    expect(l.trades[1].r).toBeCloseTo(-1.1);
    expect(l.trades[1].geomR).toBeCloseTo(2 - 0.1);
    expect(l.trades[2].r).toBeNull();
    expect(l.notice).toContain('1 trade');
  });
});
