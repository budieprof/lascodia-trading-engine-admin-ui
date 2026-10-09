import { describe, expect, it } from 'vitest';
import { plotValueAt } from '@shared/pine-chart/render/legend';
import type { PlotLayer } from '@shared/pine-chart/render/render-model';
import { toChartScriptResult } from './chart-script.model';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import { scriptRenderModel } from './script-model-cache';
import { tradeDetail, tradeTimeLabel, tradeWindow } from './trade-detail';

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

  it('reads the series from the render model the chart draws, at the fills’ bar indexes', () => {
    const d = tradeDetail(result, t, {}, 5);
    const model = scriptRenderModel(result, 5)!;
    const plots = model.panes.main.series as PlotLayer[];
    // The fixture's trade enters on bar_index 32 and exits on 53 (the report's bar indexes).
    expect(d.series.map((s) => s.title)).toEqual(['Basis', 'Upper', 'Lower']);
    d.series.forEach((s, i) => {
      expect(s.entry).toBe(plotValueAt(plots[i], 32));
      expect(s.exit).toBe(plotValueAt(plots[i], 53));
    });
  });

  it('formats the series at the symbol’s precision when the script declares none (PC-12)', () => {
    const at5 = tradeDetail(result, t, {}, 5).series[0];
    const at3 = tradeDetail(result, t, {}, 3).series[0];
    expect(at5.entryText).toBe(at5.entry!.toFixed(5));
    expect(at3.entryText).toBe(at3.entry!.toFixed(3));
  });

  it('an open trade has no exit values', () => {
    const open = { ...t, isOpen: true, exitTime: null, exitPrice: null };
    const d = tradeDetail(result, open, {}, 5);
    expect(d.series.length).toBe(3);
    expect(d.series.every((s) => s.exit === null && s.exitText === '—')).toBe(true);
  });

  it('frames the trade with a margin of at least 10 bars', () => {
    const w = tradeWindow({ ...t, entryTime: 1000 * 3600, exitTime: 1001 * 3600 }, 3600, 0);
    expect(w.fromMs).toBe((1000 - 10) * 3600 * 1000);
    expect(w.toMs).toBe((1001 + 10) * 3600 * 1000);
  });
});

describe('trade times', () => {
  // A fill on Tuesday 6 Oct's daily bar, which opens on Monday at 21:00 UTC.
  const tuesdayOpen = Date.parse('2026-10-05T21:00:00Z') / 1000;

  it('name the bar by its trading date on 1D/1W/1M, as the chart does', () => {
    expect(tradeTimeLabel(tuesdayOpen, '1D')).toBe('Tue 6 Oct 2026');
    expect(tradeTimeLabel(tuesdayOpen, '1M')).toBe('Oct 2026');
  });

  it('print the instant in UTC elsewhere, and a dash when there is none', () => {
    expect(tradeTimeLabel(tuesdayOpen, '240')).toBe('2026-10-05 21:00 UTC');
    expect(tradeTimeLabel(tuesdayOpen)).toBe('2026-10-05 21:00 UTC');
    expect(tradeTimeLabel(null, '1D')).toBe('—');
  });

  it('carry into the trade detail card', () => {
    const result = toChartScriptResult(BOLLINGER_RUN as never);
    const t = { ...result.strategy!.trades[0], entryTime: tuesdayOpen };
    const entry = (r: string) =>
      tradeDetail(result, t, {}, 5, r).trade.find((row) => row.label === 'Entry')!.value;
    expect(entry('1D')).toMatch(/· Tue 6 Oct 2026$/);
    expect(entry('60')).toMatch(/· 2026-10-05 21:00 UTC$/);
  });
});
