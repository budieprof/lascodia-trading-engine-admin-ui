import { describe, expect, it } from 'vitest';
import { trackColor } from '../core/color';
import { normalizeRunResult } from '../model/normalize';
import type { PineBar, PineRunResult, PineScriptOutputs } from '../model/pine-outputs.types';
import {
  PINE,
  cell,
  emptyOutputs,
  label,
  largeFixture,
  marker,
  overlayStrategyFixture,
  paneIndicatorFixture,
  plot,
  x,
} from '../testing/pine-fixtures';
import {
  buildRenderModel,
  MAX_FUTURE_SLOTS,
  TRADE_COLORS,
  type PineChartInput,
} from './build-render-model';
import type { MarkerLayer, PlotLayer } from './render-model';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 5);

function bars(n: number, start = T0): PineBar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: start + i * H,
    o: 10 + i,
    h: 11 + i,
    l: 9 + i,
    c: 10.5 + i,
    v: 100,
  }));
}

function input(outputs: PineScriptOutputs | null, b: PineBar[], overlay = true): PineChartInput {
  return {
    bars: b,
    outputs,
    report: null,
    declaration: {
      kind: 'indicator',
      title: 'Test',
      shortTitle: 'T',
      overlay,
      format: null,
      precision: null,
    },
  };
}

function fromRun(run: PineRunResult) {
  const r = normalizeRunResult(run)!;
  return buildRenderModel({
    bars: r.bars,
    outputs: r.outputs,
    report: r.report,
    declaration: r.compile?.declaration ?? null,
  });
}

const plotLayer = (
  m: ReturnType<typeof buildRenderModel>,
  id: number,
  pane: 'main' | 'script' = 'main',
) => (m.panes[pane]!.series.find((s) => s.id === id) as PlotLayer | undefined)!;

describe('buildRenderModel — timeline and bars', () => {
  it('aligns the chart bars to bar_index through the outputs window', () => {
    const b = bars(10);
    const out = emptyOutputs(
      b.slice(4).map((q) => q.t),
      104,
    );
    const m = buildRenderModel(input(out, b));
    // outputs.bars.times[0] is chart bar 4 → chart bar 0 is bar_index 100.
    expect(m.timeline.firstBarIndex).toBe(100);
    expect(m.timeline.logicalOfBarIndex(104)).toBe(4);
    expect(m.timeline.stepMs).toBe(H);
  });

  it('sorts and de-duplicates unordered bars instead of handing them to the library', () => {
    const b = bars(3);
    const m = buildRenderModel(input(null, [b[2], b[0], b[1], { ...b[1], c: 99 }]));
    expect(Array.from(m.bars.time)).toEqual([b[0].t, b[1].t, b[2].t]);
    expect(m.bars.close[1]).toBe(99);
  });

  it('keeps Renko-style bricks that share an open time and aligns outputs to them by position', () => {
    const t = T0;
    const bricks: PineBar[] = [t, t, t, t + H, t + 2 * H].map((tt, i) => ({
      t: tt,
      o: 1 + i,
      h: 2 + i,
      l: 1 + i,
      c: 2 + i,
      v: 0,
    }));
    const out = emptyOutputs(
      bricks.map((b) => b.t),
      50,
    );
    out.plots.push(plot({ id: 0, values: [10, 11, 12, 13, 14] }));
    const m = buildRenderModel(input(out, bricks));
    expect(m.bars.time.length).toBe(5);
    expect(m.timeline.firstBarIndex).toBe(50);
    expect(plotLayer(m, 0).values[2]).toBe(12);
  });

  it('infers the price precision from the bars and honours an override', () => {
    const b = bars(5).map((q) => ({ ...q, c: 1.08523 }));
    expect(buildRenderModel(input(null, b)).pricePrecision).toBe(5);
    expect(buildRenderModel(input(null, b), { pricePrecision: 2 }).pricePrecision).toBe(2);
  });
});

describe('buildRenderModel — plots', () => {
  const b = bars(20);
  const times = b.map((q) => q.t);
  const values = b.map((_, i) => (i === 5 ? null : i));

  it('keeps na as NaN and lists the valued slots', () => {
    const out = emptyOutputs(times);
    out.plots.push(plot({ id: 0, values }));
    const p = plotLayer(buildRenderModel(input(out, b)), 0);
    expect(Number.isNaN(p.values[5])).toBe(true);
    expect(p.valid.length).toBe(19);
    expect(p.valid).not.toContain(5);
    expect(p.last).toMatchObject({ slot: 19, value: 19 });
  });

  it('applies a positive offset: shifted into the future and the time scale is extended', () => {
    const out = emptyOutputs(times);
    out.plots.push(plot({ id: 0, values, offset: 3 }));
    const m = buildRenderModel(input(out, b));
    const p = plotLayer(m, 0);
    expect(p.start).toBe(3);
    expect(m.futureSlots).toBe(3);
  });

  it('applies a negative offset: points before the first bar are dropped', () => {
    const out = emptyOutputs(times);
    out.plots.push(plot({ id: 0, values, offset: -4 }));
    const p = plotLayer(buildRenderModel(input(out, b)), 0);
    expect(p.start).toBe(0);
    expect(p.values.length).toBe(16);
    expect(p.values[0]).toBe(4); // source bar 4 now draws at chart bar 0
  });

  it('applies show_last counting back from the last bar', () => {
    const out = emptyOutputs(times);
    out.plots.push(plot({ id: 0, values, showLast: 3 }));
    const p = plotLayer(buildRenderModel(input(out, b)), 0);
    expect(Array.from(p.valid)).toEqual([17, 18, 19]);
  });

  it('show_last = 1 with offset -99999 leaves only the track-price line', () => {
    const out = emptyOutputs(times);
    out.plots.push(
      plot({ id: 0, values: b.map(() => 200), showLast: 1, offset: -99999, trackPrice: true }),
    );
    const p = plotLayer(buildRenderModel(input(out, b)), 0);
    expect(p.valid.length).toBe(0);
  });

  it('parses display flags and keeps display.none plots (fills may need them) out of every location', () => {
    const out = emptyOutputs(times);
    out.plots.push(
      plot({ id: 0, values, display: ['none'] }),
      plot({ id: 1, values, display: ['data_window', 'status_line'] }),
    );
    const m = buildRenderModel(input(out, b));
    expect(plotLayer(m, 0).display).toEqual({
      pane: false,
      dataWindow: false,
      priceScale: false,
      statusLine: false,
    });
    expect(plotLayer(m, 1).display).toEqual({
      pane: false,
      dataWindow: true,
      priceScale: false,
      statusLine: true,
    });
  });

  it('turns uniform and per-bar colors into color tracks, and unknown styles into line', () => {
    const out = emptyOutputs(times);
    out.plots.push(
      plot({ id: 0, values, color: '#FF000080' }),
      plot({
        id: 1,
        values,
        color: null,
        colors: b.map((_, i) => (i % 2 ? PINE.red : null)),
        style: 'unheard-of',
      }),
    );
    const m = buildRenderModel(input(out, b));
    expect(trackColor(plotLayer(m, 0).colors, 7)).toBe('rgba(255, 0, 0, 0.502)');
    const p1 = plotLayer(m, 1);
    expect(p1.style).toBe('line');
    expect(trackColor(p1.colors, 1)).toBe('rgb(242, 54, 69)');
    expect(trackColor(p1.colors, 2)).toBeNull();
  });

  it('counts histbase in the scale for area, columns and histogram only', () => {
    const out = emptyOutputs(times);
    const styles = ['area', 'areabr', 'columns', 'histogram', 'line'];
    styles.forEach((style, id) => out.plots.push(plot({ id, values, style, histBase: -5 })));
    const m = buildRenderModel(input(out, b));
    expect(styles.map((_, id) => plotLayer(m, id).includeBaseInScale)).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });
});

describe('buildRenderModel — panes', () => {
  it('puts everything of an overlay script on the price pane', () => {
    const m = fromRun(overlayStrategyFixture(300));
    expect(m.overlay).toBe(true);
    expect(m.panes.script).toBeNull();
    expect(m.panes.main.series.length).toBeGreaterThan(10);
  });

  it('gives a non-overlay script its own pane, and force_overlay outputs the price pane', () => {
    const m = fromRun(paneIndicatorFixture(300));
    const script = m.panes.script!;
    expect(script).not.toBeNull();
    expect(script.series.map((s) => s.title)).toContain('RSI');
    expect(script.hlines.map((h) => h.price)).toEqual([70, 30, 50]);
    const main = m.panes.main;
    expect(main.series.map((s) => s.title)).toEqual(
      expect.arrayContaining(['SMA 50', 'Heikin-Ashi']),
    );
    expect(main.drawings.labels.map((l) => l.text)).toContain('force_overlay');
    expect(main.tables.map((t) => t.position)).toEqual(['top_center']);
    expect(script.tables.map((t) => t.position)).toEqual(['middle_right']);
  });

  it('draws plots and plotcandles in declaration (id) order', () => {
    const m = fromRun(paneIndicatorFixture(200));
    const ids = m.panes.script!.series.map((s) => s.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe('buildRenderModel — per-bar outputs', () => {
  const b = bars(12);
  const times = b.map((q) => q.t);

  it('barcolor: later outputs win on a bar, offsets shift, na keeps the default colors', () => {
    const out = emptyOutputs(times);
    out.barColors.push(
      {
        id: 0,
        title: null,
        offset: 0,
        showLast: null,
        display: ['all'],
        forceOverlay: false,
        colors: times.map((_, i) => (i < 6 ? PINE.red : null)),
      },
      {
        id: 1,
        title: null,
        offset: 2,
        showLast: null,
        display: ['all'],
        forceOverlay: false,
        colors: times.map((_, i) => (i === 1 ? PINE.blue : null)),
      },
    );
    const m = buildRenderModel(input(out, b));
    expect(m.bars.colors![0]).toBe('rgb(242, 54, 69)');
    expect(m.bars.colors![3]).toBe('rgb(41, 98, 255)'); // bar 1 shifted by 2
    expect(m.bars.colors![8]).toBeNull();
  });

  it('bgcolor honours offset and show_last and skips display.none', () => {
    const out = emptyOutputs(times);
    out.backgrounds.push(
      {
        id: 0,
        title: 'bg',
        offset: 1,
        showLast: 4,
        display: ['all'],
        forceOverlay: false,
        colors: times.map(() => PINE.teal),
      },
      {
        id: 1,
        title: 'hidden',
        offset: 0,
        showLast: null,
        display: ['none'],
        forceOverlay: false,
        colors: times.map(() => PINE.red),
      },
    );
    const m = buildRenderModel(input(out, b));
    expect(m.panes.main.backgrounds.length).toBe(1);
    const bg = m.panes.main.backgrounds[0];
    expect(bg.start).toBe(1);
    // Only source bars 8..11 survive show_last; they draw at logical 9..12.
    expect(trackColor(bg.colors, 7)).toBeNull();
    expect(trackColor(bg.colors, 8)).not.toBeNull();
    expect(m.futureSlots).toBe(1);
  });

  it('markers: offset, show_last and sort by logical; arrows record their direction', () => {
    const out = emptyOutputs(times);
    out.markers.push(
      marker({
        id: 0,
        offset: 2,
        showLast: 5,
        points: [9, 2, 11, 7].map((i) => ({
          barIndex: i,
          time: times[i],
          value: 1,
          color: PINE.red,
        })),
      }),
      marker({
        id: 1,
        kind: 'arrow',
        points: [
          { barIndex: 3, time: times[3], value: -2, color: PINE.red, direction: 'down' },
          { barIndex: 4, time: times[4], value: 5, color: PINE.teal, direction: 'up' },
        ],
      }),
    );
    const m = buildRenderModel(input(out, b));
    const [shapes, arrows] = m.panes.main.markers as MarkerLayer[];
    expect(Array.from(shapes.logicals)).toEqual([9, 11, 13]); // 2 dropped by show_last, sorted, +2
    expect(Array.from(arrows.up)).toEqual([0, 1]);
    expect(arrows.kind).toBe('arrow');
  });

  it('plotcandle: a bar with any na OHLC is skipped; high/low normalised', () => {
    const out = emptyOutputs(times);
    out.candles.push({
      id: 0,
      title: 'c',
      offset: 0,
      showLast: null,
      display: ['all'],
      forceOverlay: false,
      plotNumber: 0,
      kind: 'candle',
      format: null,
      precision: null,
      open: times.map((_, i) => (i === 2 ? null : 5)),
      high: times.map(() => 4),
      low: times.map(() => 6),
      close: times.map(() => 5.5),
      color: PINE.teal,
      colors: null,
      wickColors: null,
      borderColors: null,
    });
    const c = buildRenderModel(input(out, b)).panes.main.series[0];
    expect(c.type).toBe('candle');
    if (c.type !== 'candle') return;
    expect(Number.isNaN(c.close[2])).toBe(true);
    expect(c.high[0]).toBe(6);
    expect(c.low[0]).toBe(4);
  });
});

describe('buildRenderModel — hlines and fills', () => {
  it('resolves fill edges to plot layers or hline prices and keeps fills of hidden plots', () => {
    const m = fromRun(overlayStrategyFixture(200));
    const fills = m.panes.main.fills;
    expect(fills.map((f) => f.kind)).toEqual(['plots', 'gradient']);
    expect(fills[0].upper.kind).toBe('plot');
    expect(fills[1].gradient?.topValues.length).toBe(200);
    const pane = fromRun(paneIndicatorFixture(200)).panes.script!;
    expect(pane.fills[0]).toMatchObject({
      kind: 'hlines',
      upper: { kind: 'price', price: 70 },
      lower: { kind: 'price', price: 30 },
    });
  });

  it('drops a fill that references a missing output', () => {
    const b = bars(5);
    const out = emptyOutputs(b.map((q) => q.t));
    out.plots.push(plot({ id: 0, values: [1, 2, 3, 4, 5] }));
    out.fills.push({
      id: 0,
      kind: 'plots',
      from: 0,
      to: 9,
      fillGaps: false,
      display: ['all'],
      color: PINE.red,
    });
    expect(buildRenderModel(input(out, b)).panes.main.fills).toEqual([]);
  });
});

describe('buildRenderModel — drawings', () => {
  const b = bars(30);
  const times = b.map((q) => q.t);

  it('positions labels by bar index or (fractionally) by time, and skips na coordinates', () => {
    const out = emptyOutputs(times);
    out.labels.push(
      label({ id: 1, x: x(10, times, H), y: 12 }),
      label({
        id: 2,
        x: { value: times[4] + H / 2, barIndex: 4, time: times[4] + H / 2 },
        xloc: 'bar_time',
        y: 12,
      }),
      label({ id: 3, x: { value: null, barIndex: null, time: null }, y: 12 }),
      label({ id: 4, x: x(5, times, H), y: null }), // yloc.price needs a y
      label({ id: 5, x: x(6, times, H), y: null, yloc: 'abovebar' }),
    );
    const labels = buildRenderModel(input(out, b)).panes.main.drawings.labels;
    expect(labels.map((l) => l.id)).toEqual([1, 2, 5]);
    expect(labels[1].x).toBeCloseTo(4.5);
    expect(labels[2].yloc).toBe('abovebar');
  });

  it('extends the time scale for future drawings (capped at 500 bars)', () => {
    const out = emptyOutputs(times);
    out.labels.push(
      label({ id: 1, x: x(29 + 25, times, H), y: 1 }),
      label({ id: 2, x: x(29 + 5000, times, H), y: 1 }),
    );
    expect(buildRenderModel(input(out, b)).futureSlots).toBe(MAX_FUTURE_SLOTS);
  });

  it('normalises boxes (top/bottom and left/right order) and maps text sizes', () => {
    const out = emptyOutputs(times);
    out.boxes.push({
      id: 1,
      left: x(20, times, H),
      right: x(10, times, H),
      top: 5,
      bottom: 9,
      xloc: 'bar_index',
      borderColor: PINE.blue,
      borderWidth: 2,
      borderStyle: 'dashed',
      extend: 'right',
      bgColor: null,
      text: 'hi',
      textSize: 'large',
      textSizePoints: 0,
      textColor: PINE.black,
      textHAlign: 'left',
      textVAlign: 'top',
      textWrap: 'auto',
      fontFamily: 'monospace',
      bold: true,
      italic: false,
      forceOverlay: false,
      createdBar: 0,
    });
    const box = buildRenderModel(input(out, b)).panes.main.drawings.boxes[0];
    expect(box).toMatchObject({
      left: 10,
      right: 20,
      top: 9,
      bottom: 5,
      fontSize: 20,
      wrap: true,
      extend: 'right',
      borderStyle: 'dashed',
    });
    expect(box.fontFamily).toContain('monospace');
  });

  it('links linefills to their lines and drops those whose lines are gone', () => {
    const m = fromRun(overlayStrategyFixture(300));
    const d = m.panes.main.drawings;
    expect(d.linefills.length).toBe(1);
    expect(d.lines).toContain(d.linefills[0].line1);
    expect(d.polylines.map((p) => p.curved)).toEqual([false, true]);
  });

  it('covers every label style in the fixture', () => {
    const labels = fromRun(overlayStrategyFixture(400)).panes.main.drawings.labels;
    expect(new Set(labels.map((l) => l.style)).size).toBe(21);
  });
});

describe('buildRenderModel — tables', () => {
  it('drops cells outside the grid, clamps spans and ignores cells a merge covers', () => {
    const b = bars(3);
    const out = emptyOutputs(b.map((q) => q.t));
    out.tables.push({
      id: 7,
      position: 'bottom_center',
      columns: 3,
      rows: 2,
      bgColor: PINE.white,
      frameColor: null,
      frameWidth: 0,
      borderColor: null,
      borderWidth: 0,
      forceOverlay: false,
      cells: [
        cell({ column: 0, row: 0, columnSpan: 9, text: 'header' }),
        cell({ column: 1, row: 0, text: 'covered' }),
        cell({ column: 5, row: 0, text: 'outside' }),
        cell({ column: 2, row: 1, text: 'x', width: 150, textSizePoints: 0, textSize: 'huge' }),
      ],
    });
    const t = buildRenderModel(input(out, b)).panes.main.tables[0];
    expect(t.position).toBe('bottom_center');
    expect(t.cells.map((c) => c.text)).toEqual(['header', 'x']);
    expect(t.cells[0].columnSpan).toBe(3);
    expect(t.cells[1]).toMatchObject({ widthPct: 100, fontSize: 36 });
  });
});

describe('buildRenderModel — strategy trades', () => {
  it('maps trades by bar index, colors the line by profit, and keeps open trades open', () => {
    const run = overlayStrategyFixture(400);
    const m = fromRun(run);
    const trades = m.panes.main.trades;
    expect(trades.length).toBe(run.report!.trades.length);
    const closed = trades.filter((t) => !t.isOpen);
    for (const t of closed) {
      expect(t.lineColor).toBe(
        t.profit > 0 ? TRADE_COLORS.profit : t.profit < 0 ? TRADE_COLORS.loss : TRADE_COLORS.even,
      );
      expect(t.exitX).not.toBeNull();
    }
    const open = trades.filter((t) => t.isOpen);
    expect(open.length).toBe(1);
    expect(open[0].exitX).toBeNull();
  });

  it('can leave trades off', () => {
    const run = normalizeRunResult(overlayStrategyFixture(200))!;
    const m = buildRenderModel(
      {
        bars: run.bars,
        outputs: run.outputs,
        report: run.report,
        declaration: run.compile!.declaration,
      },
      { trades: false },
    );
    expect(m.panes.main.trades).toEqual([]);
  });
});

describe('buildRenderModel — fixtures', () => {
  it('the overlay fixture exercises every plot style and shape', () => {
    const m = fromRun(overlayStrategyFixture(400));
    const plots = m.panes.main.series.filter((s): s is PlotLayer => s.type === 'plot');
    expect(new Set(plots.map((p) => p.style))).toEqual(
      new Set(['line', 'linebr', 'stepline', 'stepline_diamond', 'steplinebr', 'circles', 'cross']),
    );
    const pane = fromRun(paneIndicatorFixture(300)).panes.script!;
    const paneStyles = pane.series
      .filter((s): s is PlotLayer => s.type === 'plot')
      .map((p) => p.style);
    expect(paneStyles).toEqual(expect.arrayContaining(['histogram', 'columns', 'area', 'areabr']));
    const shapes = m.panes.main.markers.filter((mk) => mk.kind === 'shape').map((mk) => mk.shape);
    expect(new Set(shapes).size).toBe(12);
    expect(m.panes.main.markers.some((mk) => mk.kind === 'char')).toBe(true);
    expect(m.panes.main.markers.some((mk) => mk.kind === 'arrow')).toBe(true);
  });

  it('builds 20,000 bars × 40 plots quickly', () => {
    const run = normalizeRunResult(largeFixture(20_000, 40))!;
    const t0 = performance.now();
    const m = buildRenderModel({
      bars: run.bars,
      outputs: run.outputs,
      report: null,
      declaration: run.compile!.declaration,
    });
    const ms = performance.now() - t0;
    expect(m.panes.main.series.length).toBe(40);
    expect(m.timeline.length).toBe(20_000);
    expect(ms).toBeLessThan(3000);
  });
});
