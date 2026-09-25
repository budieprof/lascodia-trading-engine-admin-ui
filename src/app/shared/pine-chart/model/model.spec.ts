import { describe, expect, it } from 'vitest';
import { overlayStrategyFixture, paneIndicatorFixture } from '../testing/pine-fixtures';
import { sliceOutputs } from '../testing/fixture-replay-api';
import { toPineChartData } from './chart-data';
import { mergeOutputs } from './merge-outputs';
import {
  normalizeBars,
  normalizeOutputs,
  normalizeReplayStart,
  normalizeRunResult,
} from './normalize';
import type { PineScriptOutputs } from './pine-outputs.types';

describe('normalize', () => {
  it('fills Pine defaults for everything the engine leaves out', () => {
    const out = normalizeOutputs({
      bars: { firstIndex: 3, times: [1, 2] },
      plots: [{ id: 1, values: [1, null] }],
      labels: [{ id: 9, x: { barIndex: 4 } }],
    })!;
    expect(out.plots[0]).toMatchObject({
      style: 'line',
      lineStyle: 'solid',
      lineWidth: 1,
      display: ['all'],
      offset: 0,
      forceOverlay: false,
    });
    expect(out.labels[0]).toMatchObject({
      style: 'label_down',
      yloc: 'price',
      xloc: 'bar_index',
      x: { barIndex: 4, time: null },
    });
    expect(out.markers).toEqual([]);
    expect(out.tables).toEqual([]);
    expect(out.bars).toEqual({ firstIndex: 3, times: [1, 2], timeframe: '' });
  });

  it('keeps large per-bar arrays by reference', () => {
    const values = [1, 2, 3];
    const out = normalizeOutputs({ bars: { times: [1, 2, 3] }, plots: [{ id: 0, values }] })!;
    expect(out.plots[0].values).toBe(values);
  });

  it('unwraps a ResponseData envelope and sorts the trace', () => {
    const run = normalizeRunResult({
      status: true,
      data: {
        compile: { success: true, diagnostics: [], declaration: { title: 'X', overlay: true } },
        bars: [],
        trace: [
          { bar: 5, items: [] },
          { bar: 2, items: [{ line: 1, value: null }] },
        ],
      },
    })!;
    expect(run.compile?.declaration?.title).toBe('X');
    expect(run.trace.map((t) => t.bar)).toEqual([2, 5]);
    expect(run.trace[0].items[0].value).toBe('na');
    expect(run.outputs).toBeNull();
    expect(run.profile).toEqual([]);
  });

  it('accepts bars in either shape', () => {
    expect(normalizeBars([{ t: 1, o: 1, h: 2, l: 0, c: 1.5, v: 3 }])).toHaveLength(1);
    expect(normalizeBars([{ time: 1, open: 1, high: 2, low: 0, close: 1.5 }])).toEqual([
      { t: 1, o: 1, h: 2, l: 0, c: 1.5, v: 0 },
    ]);
    expect(normalizeBars('nope')).toEqual([]);
  });

  it('reads replay starts with numeric or string session ids', () => {
    expect(
      normalizeReplayStart({ sessionId: 42, frame: { barIndex: 10, bars: [] } })?.sessionId,
    ).toBe('42');
    expect(normalizeReplayStart({ frame: {} })).toBeNull();
  });

  it('toPineChartData takes a run result or chart data', () => {
    const run = overlayStrategyFixture(100);
    const a = toPineChartData(run)!;
    expect(a.declaration?.overlay).toBe(true);
    expect(a.bars).toHaveLength(100);
    const b = toPineChartData({
      bars: run.bars,
      outputs: run.outputs,
      report: null,
      declaration: { title: 'D', overlay: false },
    })!;
    expect(b.declaration?.overlay).toBe(false);
    expect(toPineChartData(null)).toBeNull();
  });
});

describe('mergeOutputs (Bar Replay)', () => {
  const perBarOf = (o: PineScriptOutputs) => ({
    times: o.bars.times,
    plots: o.plots.map((p) => ({
      id: p.id,
      values: p.values,
      colors: p.colors ?? o.bars.times.map(() => p.color ?? null),
    })),
    candles: o.candles.map((c) => ({ id: c.id, close: c.close })),
    backgrounds: o.backgrounds.map((b) => b.colors),
    barColors: o.barColors.map((b) => b.colors),
    markers: o.markers.map((m) => m.points.map((p) => p.barIndex)),
    fills: o.fills.map((f) => ({
      top: f.topValues,
      colors: f.colors ?? o.bars.times.map(() => f.color ?? null),
    })),
  });

  for (const [name, make] of [
    ['overlay strategy', () => overlayStrategyFixture(240)],
    ['pane indicator', () => paneIndicatorFixture(240)],
  ] as const) {
    it(`folding successive windows rebuilds the whole run — ${name}`, () => {
      const full = normalizeOutputs(make().outputs)!;
      let acc = normalizeOutputs(sliceOutputs(full, 0, 99));
      for (const [a, b] of [
        [100, 100],
        [101, 105],
        [106, 125],
        [126, 239],
      ]) {
        acc = mergeOutputs(acc, normalizeOutputs(sliceOutputs(full, a, b)));
      }
      expect(perBarOf(acc!)).toEqual(perBarOf(full));
      expect(acc!.labels).toEqual(full.labels);
      expect(acc!.logs).toEqual(full.logs);
    });
  }

  it('a re-sent bar replaces the held copy', () => {
    const full = normalizeOutputs(overlayStrategyFixture(50).outputs)!;
    const head = sliceOutputs(full, 0, 29);
    const again = sliceOutputs(full, 29, 35);
    again.plots[0].values = again.plots[0].values.map((v) => (v === null ? null : v + 1));
    const merged = mergeOutputs(head, again)!;
    expect(merged.bars.times).toHaveLength(36);
    expect(merged.plots[0].values[29]).toBe((full.plots[0].values[29] as number) + 1);
    expect(merged.plots[0].values[28]).toBe(full.plots[0].values[28]);
  });

  it('keeps a uniform color uniform and expands it only when colors diverge', () => {
    const base = normalizeOutputs({
      bars: { firstIndex: 0, times: [1, 2] },
      plots: [{ id: 0, values: [1, 2], color: '#FF0000FF' }],
    })!;
    const same = normalizeOutputs({
      bars: { firstIndex: 2, times: [3] },
      plots: [{ id: 0, values: [3], color: '#FF0000FF' }],
    })!;
    const other = normalizeOutputs({
      bars: { firstIndex: 2, times: [3] },
      plots: [{ id: 0, values: [3], color: '#0000FFFF' }],
    })!;
    expect(mergeOutputs(base, same)!.plots[0]).toMatchObject({
      color: '#FF0000FF',
      colors: null,
      values: [1, 2, 3],
    });
    expect(mergeOutputs(base, other)!.plots[0].colors).toEqual([
      '#FF0000FF',
      '#FF0000FF',
      '#0000FFFF',
    ]);
  });

  it('adds an output that first appears in a later frame, padded with na', () => {
    const base = normalizeOutputs({ bars: { firstIndex: 0, times: [1, 2] }, plots: [] })!;
    const delta = normalizeOutputs({
      bars: { firstIndex: 2, times: [3] },
      plots: [{ id: 4, values: [7] }],
    })!;
    expect(mergeOutputs(base, delta)!.plots[0].values).toEqual([null, null, 7]);
  });
});
