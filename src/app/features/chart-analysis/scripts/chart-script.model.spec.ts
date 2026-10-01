import { describe, expect, it } from 'vitest';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import {
  detectScriptKind,
  isGap,
  runTimeframeFor,
  toChartScriptResult,
  toChartSeconds,
} from './chart-script.model';
import { EXAMPLE_STRATEGIES } from './example-strategies';

describe('toChartSeconds', () => {
  it('converts engine ms to lightweight-charts UTC seconds (floored, like chart-host asTime)', () => {
    expect(toChartSeconds(1_790_254_800_000)).toBe(1_790_254_800);
    expect(toChartSeconds(1_790_254_800_999)).toBe(1_790_254_800);
  });
});

describe('runTimeframeFor', () => {
  it('passes chart resolutions through (the run endpoint takes Pine timeframes)', () => {
    for (const r of ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M']) expect(runTimeframeFor(r)).toBe(r);
  });
  it('keeps engine spellings and falls back to H1 otherwise', () => {
    expect(runTimeframeFor('H4')).toBe('H4');
    expect(runTimeframeFor('weird')).toBe('H1');
  });
});

describe('toChartScriptResult — real Bollinger backtest run', () => {
  const r = toChartScriptResult(BOLLINGER_RUN);
  const raw = BOLLINGER_RUN as { bars: { t: number }[]; report: { trades: any[]; performance: any } };

  it('reads the declaration', () => {
    expect(r.kind).toBe('strategy');
    expect(r.overlay).toBe(true);
    expect(r.title).toBe('Bollinger Bands Strategy');
    expect(r.error).toBeNull();
    expect(r.inputs.map((i) => i.id)).toEqual(['Length', 'StdDev']);
  });

  it('maps plots to overlay series in UTC seconds, na leading values dropped', () => {
    expect(r.plots.map((p) => p.title)).toEqual(['Basis', 'Upper', 'Lower']);
    for (const p of r.plots) {
      expect(p.pane).toBe('overlay');
      expect(p.style).toBe('line');
      const pts = p.data.filter((d) => !isGap(d));
      // SMA(20): the first 19 bars are na.
      expect(pts.length).toBe(60 - 19);
      expect((pts[0] as { time: number }).time).toBe(raw.bars[19].t / 1000);
      expect(p.color).toMatch(/^(#|rgba?\()/);
    }
  });

  it('times strictly increase', () => {
    for (const p of r.plots) {
      for (let i = 1; i < p.data.length; i++) expect(p.data[i].time).toBeGreaterThan(p.data[i - 1].time);
    }
  });

  it('maps strategy trades, metrics and equity without rescaling', () => {
    const s = r.strategy!;
    expect(s).not.toBeNull();
    expect(s.trades).toHaveLength(1);
    const t = s.trades[0];
    const rt = raw.report.trades[0];
    expect(t.side).toBe('long');
    expect(t.entryTime).toBe(rt.entryTime / 1000);
    expect(t.exitTime).toBe(rt.exitTime / 1000);
    expect(t.entryPrice).toBe(rt.entryPrice);
    expect(t.profit).toBeCloseTo(rt.profit);
    expect(t.entrySignal).toBe('BBandLE');
    // Percent fields arrive as percentages and pass through unchanged.
    expect(s.metrics.winRatePercent).toBe(raw.report.performance.all.percentProfitable);
    expect(s.metrics.currency).toBe('USD');
    expect(s.equity.length).toBe(60);
    expect(s.equity[0].time).toBe(raw.bars[0].t / 1000);
    expect(s.equity[0].value).toBe(100000);
  });

  it('keeps the shared-normalised run for the renderer', () => {
    expect(r.run?.bars.length).toBe(60);
    expect(r.run?.outputs?.fills.length).toBe(1);
  });
});

describe('toChartScriptResult — failures and indicators', () => {
  it('reports a compile error as one line', () => {
    const r = toChartScriptResult({
      compile: {
        success: false,
        diagnostics: [{ code: 'PS1001', severity: 'error', message: 'Unexpected token', line: 3, column: 1, endLine: 3, endColumn: 2 }],
        declaration: null,
        inputs: [],
      },
    });
    expect(r.error).toBe('Line 3: Unexpected token');
    expect(r.plots).toEqual([]);
    expect(r.strategy).toBeNull();
  });

  it('puts a non-overlay indicator in a separate pane, honours force_overlay, breaks linebr, and maps markers', () => {
    const times = [0, 1, 2, 3].map((i) => 1_700_000_000_000 + i * 3_600_000);
    const r = toChartScriptResult({
      compile: { success: true, diagnostics: [], declaration: { kind: 'Indicator', title: 'Osc', overlay: false }, inputs: [] },
      bars: times.map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 })),
      outputs: {
        schemaVersion: 1,
        bars: { firstIndex: 0, times, timeframe: '60' },
        plots: [
          { id: 0, plotNumber: 0, title: 'osc', style: 'linebr', lineStyle: 'solid', lineWidth: 2, offset: 0, display: ['all'], forceOverlay: false, color: '#FF0000FF', values: [1, null, 3, 4] },
          { id: 1, plotNumber: 1, title: 'ov', style: 'columns', lineStyle: 'solid', lineWidth: 1, offset: 0, display: ['all'], forceOverlay: true, color: '#00FF00FF', values: [1, 2, 3, 4] },
          { id: 2, plotNumber: 2, title: 'hidden', style: 'line', lineStyle: 'solid', lineWidth: 1, offset: 0, display: ['none'], forceOverlay: false, color: '#00FF00FF', values: [1, 2, 3, 4] },
        ],
        markers: [
          { id: 3, plotNumber: 3, kind: 'shape', shape: 'triangleup', location: 'belowbar', text: 'B', offset: 0, display: ['all'], forceOverlay: false, points: [{ barIndex: 2, time: times[2], color: '#0000FFFF' }] },
        ],
        hlines: [{ id: 0, price: 50, title: 'mid', color: '#787B86FF', lineStyle: 'dashed', lineWidth: 1, display: ['all'] }],
      },
    });
    expect(r.kind).toBe('indicator');
    expect(r.plots.map((p) => [p.title, p.pane, p.style])).toEqual([
      ['osc', 'separate', 'line'],
      ['ov', 'overlay', 'histogram'],
    ]);
    expect(r.plots[0].data.map((d) => (isGap(d) ? null : d.value))).toEqual([1, null, 3, 4]);
    expect(r.markers).toEqual([
      { time: times[2] / 1000, position: 'belowBar', shape: 'arrowUp', color: expect.any(String), text: 'B', pane: 'separate' },
    ]);
    expect(r.hlines[0]).toMatchObject({ price: 50, lineStyle: 'dashed', pane: 'separate' });
  });
});

describe('examples', () => {
  it('are all strategies with unique ids', () => {
    expect(new Set(EXAMPLE_STRATEGIES.map((e) => e.id)).size).toBe(EXAMPLE_STRATEGIES.length);
    for (const e of EXAMPLE_STRATEGIES) {
      expect(e.source.startsWith('//@version=6')).toBe(true);
      expect(detectScriptKind(e.source)).toBe('strategy');
    }
    expect(detectScriptKind('//@version=6\nindicator("x")\nplot(close)')).toBe('indicator');
  });
});
