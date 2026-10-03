import { describe, expect, it } from 'vitest';
import { toChartScriptResult } from './chart-script.model';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import { tradeDetail, tradeWindow } from './trade-detail';

describe('trade detail', () => {
  const result = toChartScriptResult(BOLLINGER_RUN as never);
  const t = result.strategy!.trades[0];

  it('carries the fills, excursions and bars held from the engine report', () => {
    const d = tradeDetail(result, t, {}, 5);
    expect(d.title).toBe(`Trade #${t.number}`);
    const outcome = Object.fromEntries(d.outcome.map((r) => [r.label, r.value]));
    expect(outcome['Run-up (MFE)']).toContain('+20.60');
    expect(outcome['Drawdown (MAE)']).toContain('-14.60');
    const trade = Object.fromEntries(d.trade.map((r) => [r.label, r.value]));
    expect(trade['Held']).toMatch(/^21 bars/);
    expect(trade['Entry signal']).toBe('BBandLE');
  });

  it('reads every plotted series at the entry and exit bars', () => {
    const d = tradeDetail(result, t);
    expect(d.series.length).toBeGreaterThan(0);
    expect(d.series.every((s) => s.entry !== null || s.exit !== null)).toBe(true);
    expect(d.bars.find((b) => b.label === 'Close')!.entry).not.toBeNull();
  });

  it('frames the trade with a margin of at least 10 bars', () => {
    const w = tradeWindow({ ...t, entryTime: 1000 * 3600, exitTime: 1001 * 3600 }, 3600, 0);
    expect(w.fromMs).toBe((1000 - 10) * 3600 * 1000);
    expect(w.toMs).toBe((1001 + 10) * 3600 * 1000);
  });
});
