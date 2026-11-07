import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cumulativePnl,
  equityCurveChart,
  monthlyPnl,
  monthlyPnlChart,
  rollingProfitFactor,
  rollingProfitFactorChart,
  rollingWinRateChart,
  rollingWinRatePct,
  toMonitorTrades,
  type MonitorTrade,
} from './monitor-charts';

const t = (closedAt: string, pnl: number): MonitorTrade => ({ closedAt, pnl });

describe('monitor charts (real closed trades)', () => {
  it('maps and sorts the engine points oldest first', () => {
    const trades = toMonitorTrades([
      { closedAt: '2026-11-02T00:00:00Z', realizedPnL: 5, cumulativePnL: 0 },
      { closedAt: '2026-11-01T00:00:00Z', realizedPnL: -2, cumulativePnL: 0 },
    ]);
    expect(trades.map((x) => x.pnl)).toEqual([-2, 5]);
    expect(toMonitorTrades(null)).toEqual([]);
  });

  it('builds the cumulative P&L', () => {
    expect(cumulativePnl([t('a', 1), t('b', -3), t('c', 2.5)]).map(([, v]) => v)).toEqual([
      1, -2, 0.5,
    ]);
  });

  it('computes a rolling win rate in percent, break-even is not a win', () => {
    const trades = [t('1', 1), t('2', -1), t('3', 0), t('4', 2)];
    expect(rollingWinRatePct(trades, 2)).toEqual([
      ['2', 50],
      ['3', 0],
      ['4', 50],
    ]);
  });

  it('leaves a gap (null) where a window has no losing trade — no invented cap', () => {
    const trades = [t('1', 2), t('2', -1), t('3', 3), t('4', 1)];
    expect(rollingProfitFactor(trades, 2)).toEqual([
      ['2', 2],
      ['3', 3],
      ['4', null],
    ]);
  });

  it('sums P&L per UTC month', () => {
    expect(
      monthlyPnl([
        t('2026-10-31T23:30:00Z', 1),
        t('2026-11-01T00:30:00Z', 2),
        t('2026-11-15T00:00:00Z', -0.5),
      ]),
    ).toEqual([
      { month: '2026-10', pnl: 1 },
      { month: '2026-11', pnl: 1.5 },
    ]);
  });

  it('returns null (empty state) when there is too little data', () => {
    expect(equityCurveChart([t('1', 1)])).toBeNull();
    expect(monthlyPnlChart([])).toBeNull();
    const few = Array.from({ length: 20 }, (_, i) =>
      t(`2026-11-01T00:${String(i).padStart(2, '0')}:00Z`, 1),
    );
    expect(rollingWinRateChart(few)).toBeNull(); // one rolling point only
    expect(rollingProfitFactorChart(few)).toBeNull(); // never a losing trade
    const more = [...few, t('2026-11-01T01:00:00Z', -1), t('2026-11-01T01:01:00Z', -1)];
    expect(rollingWinRateChart(more)).not.toBeNull();
    expect(rollingProfitFactorChart(more)).not.toBeNull();
    expect(equityCurveChart(more)).not.toBeNull();
  });

  it('the strategies page never draws a random series again', () => {
    const src = readFileSync(join(__dirname, 'strategies-page.component.ts'), 'utf8');
    expect(src).not.toMatch(/Math\.random\(/);
    expect(src).not.toMatch(/· sample series/);
  });
});
