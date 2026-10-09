import { describe, expect, it } from 'vitest';
import { BOLLINGER_RUN } from './__fixtures__/bollinger-run';
import {
  detectScriptKind,
  runTimeframeFor,
  scriptBasisOf,
  toChartScriptResult,
  toChartSeconds,
} from './chart-script.model';
import { EXAMPLE_STRATEGIES } from './example-strategies';
import { scriptRenderModel } from './script-model-cache';
import { normalizeStrategyReport } from '@features/scripting/report/strategy-report.model';
import type { PlotLayer } from '@shared/pine-chart/render/render-model';

describe('toChartSeconds', () => {
  it('converts engine ms to lightweight-charts UTC seconds (floored, like chart-host asTime)', () => {
    expect(toChartSeconds(1_790_254_800_000)).toBe(1_790_254_800);
    expect(toChartSeconds(1_790_254_800_999)).toBe(1_790_254_800);
  });
});

describe('runTimeframeFor', () => {
  it('passes chart resolutions through (the run endpoint takes Pine timeframes)', () => {
    for (const r of ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'])
      expect(runTimeframeFor(r)).toBe(r);
  });
  it('keeps engine spellings and falls back to H1 otherwise', () => {
    expect(runTimeframeFor('H4')).toBe('H4');
    expect(runTimeframeFor('weird')).toBe('H1');
  });
});

describe('toChartScriptResult — real Bollinger backtest run', () => {
  const r = toChartScriptResult(BOLLINGER_RUN);
  const raw = BOLLINGER_RUN as {
    bars: { t: number }[];
    report: { trades: any[]; performance: any };
  };

  it('reads the declaration', () => {
    expect(r.kind).toBe('strategy');
    expect(r.overlay).toBe(true);
    expect(r.title).toBe('Bollinger Bands Strategy');
    expect(r.error).toBeNull();
    expect(r.errorAt).toBeNull();
    expect(r.inputs.map((i) => i.id)).toEqual(['Length', 'StdDev']);
  });

  it('holds the outputs once — the shared-normalised run, which the render model reads', () => {
    expect(r.run?.bars.length).toBe(60);
    expect(r.run?.outputs?.plots.map((p) => p.title)).toEqual(['Basis', 'Upper', 'Lower']);
    expect(r.run?.outputs?.fills.length).toBe(1);
    // No flattened second copy of the outputs any more (PC-15).
    for (const gone of ['plots', 'hlines', 'markers', 'lines', 'boxes', 'labels', 'backgrounds'])
      expect(r).not.toHaveProperty(gone);
  });

  it('draws the plots on the price pane from the render model, na leading values as gaps', () => {
    const model = scriptRenderModel(r, 5)!;
    expect(model.panes.script).toBeNull();
    const plots = model.panes.main.series as PlotLayer[];
    expect(plots.map((p) => p.title)).toEqual(['Basis', 'Upper', 'Lower']);
    for (const p of plots) {
      // SMA(20): the first 19 bars are na.
      expect(p.valid.length).toBe(60 - 19);
      expect(model.bars.time[p.start + p.valid[0]]).toBe(raw.bars[19].t);
    }
    expect(model.panes.main.fills).toHaveLength(1);
  });

  it('builds one render model per result and precision, shared by every reader', () => {
    expect(scriptRenderModel(r, 5)).toBe(scriptRenderModel(r, 5));
    expect(scriptRenderModel(r, 3)).not.toBe(scriptRenderModel(r, 5));
    expect(scriptRenderModel(r, 3)!.pricePrecision).toBe(3);
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

  it('keeps the report as the strategy report reads it — reading it again changes nothing (PC-I5)', () => {
    // The Strategy Tester hands this report to app-strategy-report, which normalises what it gets.
    const report = r.strategy!.report;
    expect(normalizeStrategyReport(report)).toEqual(report);
  });
});

describe('toChartScriptResult — failures and indicators', () => {
  it('reports a compile error as one line, with where it is', () => {
    const r = toChartScriptResult({
      compile: {
        success: false,
        diagnostics: [
          {
            code: 'PS1001',
            severity: 'error',
            message: 'Unexpected token',
            line: 3,
            column: 7,
            endLine: 3,
            endColumn: 8,
          },
        ],
        declaration: null,
        inputs: [],
      },
    });
    expect(r.error).toBe('Line 3: Unexpected token');
    expect(r.errorAt).toEqual({ line: 3, column: 7 });
    expect(scriptRenderModel(r)).toBeNull();
    expect(r.strategy).toBeNull();
  });

  it('reports a runtime error with its line, and keeps the bars it ran on', () => {
    const times = [0, 1, 2].map((i) => 1_700_000_000_000 + i * 3_600_000);
    const r = toChartScriptResult({
      compile: {
        success: true,
        diagnostics: [],
        declaration: { kind: 'Indicator', title: 'Boom', overlay: true },
        inputs: [],
      },
      bars: times.map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 })),
      runtimeError: { code: 'PS5011', message: 'Stopped by runtime.error()', line: 12, column: 5 },
    });
    expect(r.error).toBe('Stopped by runtime.error() (line 12)');
    expect(r.errorAt).toEqual({ line: 12, column: 5 });
  });

  it('a failure without a position has no place to open', () => {
    const r = toChartScriptResult(null);
    expect(r.error).toBe('The engine did not return a run result.');
    expect(r.errorAt).toBeNull();
  });

  it('puts a non-overlay indicator in a separate pane, honours force_overlay and display.none, breaks linebr', () => {
    const times = [0, 1, 2, 3].map((i) => 1_700_000_000_000 + i * 3_600_000);
    const r = toChartScriptResult({
      compile: {
        success: true,
        diagnostics: [],
        declaration: { kind: 'Indicator', title: 'Osc', overlay: false },
        inputs: [],
      },
      bars: times.map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 0 })),
      outputs: {
        schemaVersion: 1,
        bars: { firstIndex: 0, times, timeframe: '60' },
        plots: [
          {
            id: 0,
            plotNumber: 0,
            title: 'osc',
            style: 'linebr',
            lineStyle: 'solid',
            lineWidth: 2,
            offset: 0,
            display: ['all'],
            forceOverlay: false,
            color: '#FF0000FF',
            values: [1, null, 3, 4],
          },
          {
            id: 1,
            plotNumber: 1,
            title: 'ov',
            style: 'columns',
            lineStyle: 'solid',
            lineWidth: 1,
            offset: 0,
            display: ['all'],
            forceOverlay: true,
            color: '#00FF00FF',
            values: [1, 2, 3, 4],
          },
          {
            id: 2,
            plotNumber: 2,
            title: 'hidden',
            style: 'line',
            lineStyle: 'solid',
            lineWidth: 1,
            offset: 0,
            display: ['none'],
            forceOverlay: false,
            color: '#00FF00FF',
            values: [1, 2, 3, 4],
          },
        ],
        markers: [
          {
            id: 3,
            plotNumber: 3,
            kind: 'shape',
            shape: 'triangleup',
            location: 'belowbar',
            text: 'B',
            offset: 0,
            display: ['all'],
            forceOverlay: false,
            points: [{ barIndex: 2, time: times[2], color: '#0000FFFF' }],
          },
        ],
        hlines: [
          {
            id: 0,
            price: 50,
            title: 'mid',
            color: '#787B86FF',
            lineStyle: 'dashed',
            lineWidth: 1,
            display: ['all'],
          },
        ],
      },
    });
    expect(r.kind).toBe('indicator');
    expect(r.overlay).toBe(false);
    const model = scriptRenderModel(r)!;
    const script = model.panes.script!;
    expect(script.series.map((s) => [s.title, s.display.pane])).toEqual([
      ['osc', true],
      ['hidden', false],
    ]);
    const osc = script.series[0] as PlotLayer;
    expect(Array.from(osc.values).map((v) => (Number.isNaN(v) ? null : v))).toEqual([
      1,
      null,
      3,
      4,
    ]);
    expect(model.panes.main.series.map((s) => [s.title, (s as PlotLayer).style])).toEqual([
      ['ov', 'columns'],
    ]);
    expect(script.markers.map((m) => [m.title, m.location, Array.from(m.logicals)])).toEqual([
      ['Plot 3', 'belowbar', [2]],
    ]);
    expect(script.hlines.map((h) => [h.price, h.lineStyle])).toEqual([[50, 'dashed']]);
  });
});

describe('scriptBasisOf (PC-09, PC-I8)', () => {
  it('runs on the Heikin-Ashi bars under Heikin-Ashi candles, the standard bars under any other time style', () => {
    expect(scriptBasisOf('heikin-ashi')).toBe('heikinashi');
    for (const s of ['candles', 'hollow', 'bars', 'line', 'area', 'baseline', 'column', 'hlc-area'])
      expect(scriptBasisOf(s)).toBe('standard');
  });

  it('cannot place a run on bricks built from price movement', () => {
    for (const s of ['renko', 'kagi', 'pnf', 'line-break', 'range']) expect(scriptBasisOf(s)).toBeNull();
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
