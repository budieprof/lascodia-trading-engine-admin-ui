import { describe, expect, it } from 'vitest';
import { buildColorTrack } from '../core/color';
import { DISPLAY_ALL } from '../core/display';
import { BlockMinMax } from '../core/range-minmax';
import type { BackgroundLayer, CandleLayer, FillLayer, PlotLayer } from '../render/render-model';
import { RecordingContext, pathPoints } from '../testing/recording-context';
import { columnWidth, paintBackground, paintCandles, paintFill, paintPlot } from './paint-series';
import { linearProjection } from './projection';

const RED = '#FF0000FF';
const BLUE = '#0000FFFF';
const CSS_RED = 'rgb(255, 0, 0)';
const CSS_BLUE = 'rgb(0, 0, 255)';

/** x = logical × 10, y = 100 − price. */
const proj = (extra: Partial<Parameters<typeof linearProjection>[0]> = {}) =>
  linearProjection({
    barSpacing: 10,
    y0: 100,
    pxPerUnit: -1,
    from: -1,
    to: 100,
    lastLogical: 100,
    ...extra,
  });

function plotLayer(
  values: (number | null)[],
  options: Omit<Partial<PlotLayer>, 'colors'> & { colors?: (string | null)[]; color?: string } = {},
): PlotLayer {
  const { colors: perBar, color, ...opts } = options;
  const v = Float64Array.from(values.map((x) => (x === null ? NaN : x)));
  const valid = Int32Array.from(values.flatMap((x, i) => (x === null ? [] : [i])));
  const colors = buildColorTrack(color ?? RED, perBar ?? null, values.length);
  return {
    type: 'plot',
    id: 0,
    key: 'plot:0',
    title: 'p',
    pane: 'main',
    display: DISPLAY_ALL,
    style: 'line',
    lineStyle: 'solid',
    lineWidth: 1,
    trackPrice: false,
    histBase: 0,
    join: false,
    start: 0,
    values: v,
    colors,
    valid,
    format: { format: 'price', precision: 2 },
    scale: new BlockMinMax(v),
    includeBaseInScale: false,
    last: valid.length
      ? { slot: valid[valid.length - 1], value: v[valid[valid.length - 1]], color: CSS_RED }
      : null,
    ...opts,
  } as PlotLayer;
}

describe('paintPlot — lines', () => {
  it('line bridges na values', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 2, null, 4]));
    const strokes = ctx.strokes(CSS_RED);
    expect(strokes.length).toBe(1);
    expect(pathPoints(strokes[0].path)).toEqual([
      [0, 99],
      [10, 98],
      [30, 96],
    ]);
  });

  it('linebr breaks at na and draws an isolated value as a short dash', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 2, null, 4, null], { style: 'linebr' }));
    const pts = ctx.strokes(CSS_RED).map((s) => pathPoints(s.path));
    expect(pts).toContainEqual([
      [0, 99],
      [10, 98],
    ]);
    // The isolated value at bar 3 becomes a horizontal dash centred on x = 30.
    const dash = pts.find((p) => p.length === 2 && p[0][1] === 96 && p[1][1] === 96);
    expect(dash).toBeDefined();
    expect((dash![0][0] + dash![1][0]) / 2).toBe(30);
    // No segment ever connects bar 1 to bar 3.
    expect(pts.some((p) => p.some(([xx]) => xx === 10) && p.some(([xx]) => xx === 30))).toBe(false);
  });

  it('colors a segment by the bar it goes into; na color hides that segment', () => {
    const ctx = new RecordingContext();
    paintPlot(
      ctx.asCtx(),
      proj(),
      plotLayer([1, 2, 3, 4], { colors: [RED, BLUE, null, RED], color: undefined }),
    );
    const blue = ctx.strokes(CSS_BLUE).map((s) => pathPoints(s.path));
    const red = ctx.strokes(CSS_RED).map((s) => pathPoints(s.path));
    expect(blue).toEqual([
      [
        [0, 99],
        [10, 98],
      ],
    ]);
    // Segment 1→2 goes into an na-colored bar: not drawn. Segment 2→3 is red.
    expect(red).toEqual([
      [
        [20, 97],
        [30, 96],
      ],
    ]);
  });

  it('uses the plot line style and width', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 2, 3], { lineStyle: 'dashed', lineWidth: 3 }));
    const s = ctx.strokes(CSS_RED)[0];
    expect(s.width).toBe(3);
    expect(s.dash.length).toBe(2);
  });

  it('draws nothing when the display excludes the pane', () => {
    const ctx = new RecordingContext();
    paintPlot(
      ctx.asCtx(),
      proj(),
      plotLayer([1, 2, 3], { display: { ...DISPLAY_ALL, pane: false } }),
    );
    expect(ctx.ops).toEqual([]);
  });

  it('only walks the visible window (plus a neighbour each side)', () => {
    const ctx = new RecordingContext();
    const values = Array.from({ length: 1000 }, (_, i) => i % 50);
    paintPlot(ctx.asCtx(), proj({ from: 500, to: 510 }), plotLayer(values));
    const xs = ctx.strokes(CSS_RED).flatMap((s) => pathPoints(s.path).map(([xx]) => xx));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4990);
    expect(Math.max(...xs)).toBeLessThanOrEqual(5110);
  });

  it('trackprice draws a dotted line at the last value across the pane', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj({ width: 400 }), plotLayer([1, 2, 5], { trackPrice: true }));
    const track = ctx.strokes(CSS_RED).find((s) => s.dash.length > 0)!;
    const pts = pathPoints(track.path);
    expect(pts[0][0]).toBe(0);
    expect(pts[1][0]).toBe(400);
    expect(pts[0][1]).toBeCloseTo(95.5);
  });
});

describe('paintPlot — step lines', () => {
  it('stepline holds each value over its bar and steps halfway between bars', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj({ lastLogical: 2 }), plotLayer([1, 1, 3], { style: 'stepline' }));
    const pts = ctx.strokes(CSS_RED).flatMap((s) => pathPoints(s.path));
    // Bar 0 spans [-5, 5], bar 1 [5, 15], the step up at x = 15, and the last bar plots only halfway (to 20).
    expect(pts[0]).toEqual([-5, 99]);
    expect(pts).toContainEqual([15, 99]);
    expect(pts).toContainEqual([15, 97]);
    expect(pts[pts.length - 1]).toEqual([20, 97]);
  });

  it('steplinebr draws each value on its own bar width with no jump across na', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([2, null, null, 5], { style: 'steplinebr' }));
    const segs = ctx.strokes(CSS_RED).map((s) => pathPoints(s.path));
    expect(segs).toEqual([
      [
        [-5, 98],
        [5, 98],
      ],
      [
        [25, 95],
        [35, 95],
      ],
    ]);
  });

  it('stepline does not draw the jump into a bar after an na-colored bar', () => {
    const ctx = new RecordingContext();
    paintPlot(
      ctx.asCtx(),
      proj(),
      plotLayer([2, 2, 5], { style: 'stepline', colors: [RED, null, RED], color: undefined }),
    );
    const pts = ctx.strokes(CSS_RED).flatMap((s) => pathPoints(s.path));
    expect(pts.some(([xx, yy]) => xx === 15 && yy === 98)).toBe(false);
  });

  it('stepline_diamond marks each change of value with a diamond', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([2, 2, 5, 5, 7], { style: 'stepline_diamond' }));
    const diamonds = ctx.fills(CSS_RED);
    expect(diamonds.length).toBe(3); // bars 0, 2, 4
  });
});

describe('paintPlot — areas, bars, points', () => {
  it('area fills between the values and histbase', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 3, 2], { style: 'area', histBase: 0 }));
    const fill = ctx.fills(CSS_RED)[0];
    const pts = pathPoints(fill.path);
    expect(pts[0]).toEqual([0, 100]); // down to histbase 0 → y 100
    expect(pts[pts.length - 1]).toEqual([20, 100]);
    expect(ctx.strokes(CSS_RED).length).toBe(1);
  });

  it('areabr leaves a gap at na values', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 2, null, 3, 4], { style: 'areabr' }));
    expect(ctx.fills(CSS_RED).length).toBe(2);
  });

  it('histogram bars are linewidth px wide and start at histbase', () => {
    const ctx = new RecordingContext();
    paintPlot(
      ctx.asCtx(),
      proj(),
      plotLayer([5, -5], { style: 'histogram', lineWidth: 4, histBase: 0 }),
    );
    const rects = ctx.rects(CSS_RED);
    expect(rects.map((r) => r.w)).toEqual([4, 4]);
    expect(rects[0]).toMatchObject({ y: 95, h: 5 }); // from 5 down to 0
    expect(rects[1]).toMatchObject({ y: 100, h: 5 }); // negative values hang below the base
  });

  it('columns fill most of the bar spacing', () => {
    expect(columnWidth(10)).toBe(8);
    expect(columnWidth(1.5)).toBe(2);
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([3], { style: 'columns' }));
    expect(ctx.rects(CSS_RED)[0].w).toBe(8);
  });

  it('circles draw one point per value, joined by a 1px line with join = true', () => {
    const ctx = new RecordingContext();
    paintPlot(
      ctx.asCtx(),
      proj(),
      plotLayer([1, null, 3], { style: 'circles', join: true, lineWidth: 2 }),
    );
    const joins = ctx.strokes(CSS_RED);
    expect(joins.length).toBe(1);
    expect(joins[0].width).toBe(1);
    const circles = ctx.fills(CSS_RED)[0].path.filter((c) => c.c === 'A');
    expect(circles.length).toBe(2);
  });

  it('cross draws plus signs', () => {
    const ctx = new RecordingContext();
    paintPlot(ctx.asCtx(), proj(), plotLayer([1, 2], { style: 'cross', lineWidth: 1 }));
    const pts = pathPoints(ctx.strokes(CSS_RED)[0].path);
    expect(pts.length).toBe(8); // two crosses × two strokes × two points
  });
});

describe('paintCandles', () => {
  const layer = (style: 'candle' | 'bar', wick: string | null = null): CandleLayer => ({
    type: 'candle',
    id: 0,
    key: 'candle:0',
    title: 'c',
    pane: 'main',
    display: DISPLAY_ALL,
    style,
    start: 0,
    open: Float64Array.of(10),
    high: Float64Array.of(15),
    low: Float64Array.of(5),
    close: Float64Array.of(12),
    colors: buildColorTrack(RED, null, 1),
    wickColors: wick ? buildColorTrack(null, [wick], 1) : null,
    borderColors: null,
    format: { format: 'price', precision: 2 },
    scale: new BlockMinMax(Float64Array.of(5), Float64Array.of(15)),
  });

  it('draws a wick and a body in the body color', () => {
    const ctx = new RecordingContext();
    paintCandles(ctx.asCtx(), proj(), layer('candle'));
    const rects = ctx.rects(CSS_RED);
    expect(rects.length).toBe(2);
    expect(rects[0]).toMatchObject({ y: 85, h: 10 }); // wick 15 → 5
    expect(rects[1]).toMatchObject({ y: 88, h: 2 }); // body 12 → 10
  });

  it('uses the wick color when given', () => {
    const ctx = new RecordingContext();
    paintCandles(ctx.asCtx(), proj(), layer('candle', BLUE));
    expect(ctx.rects(CSS_BLUE).length).toBe(1);
  });

  it('plotbar draws a range line and open/close ticks', () => {
    const ctx = new RecordingContext();
    paintCandles(ctx.asCtx(), proj(), layer('bar'));
    expect(ctx.rects(CSS_RED).length).toBe(3);
  });
});

describe('paintBackground', () => {
  it('merges consecutive bars of one color into one band', () => {
    const ctx = new RecordingContext();
    const bg: BackgroundLayer = {
      type: 'background',
      id: 0,
      key: 'bg:0',
      title: 'bg',
      pane: 'main',
      display: DISPLAY_ALL,
      start: 0,
      colors: buildColorTrack(null, [RED, RED, null, BLUE], 4),
    };
    paintBackground(ctx.asCtx(), proj({ height: 300 }), bg);
    const red = ctx.rects(CSS_RED);
    expect(red.length).toBe(1);
    expect(red[0]).toMatchObject({ x: -5, w: 20, y: 0, h: 300 });
    expect(ctx.rects(CSS_BLUE)[0]).toMatchObject({ x: 25, w: 10 });
  });
});

describe('paintFill', () => {
  const a = plotLayer([5, 6, null, 8]);
  const b = plotLayer([1, 2, 3, 4]);
  const fill = (extra: Partial<FillLayer> = {}): FillLayer => ({
    type: 'fill',
    id: 0,
    key: 'fill:0',
    title: 'f',
    pane: 'main',
    display: DISPLAY_ALL,
    kind: 'plots',
    fillGaps: false,
    upper: { kind: 'plot', layer: a },
    lower: { kind: 'plot', layer: b },
    colorStart: 0,
    colors: buildColorTrack(BLUE, null, 4),
    gradient: null,
    visibleFrom: -Infinity,
    ...extra,
  });

  it('fills between two plots only where both have values', () => {
    const ctx = new RecordingContext();
    paintFill(ctx.asCtx(), proj(), fill());
    const polys = ctx.fills(CSS_BLUE).map((f) => pathPoints(f.path));
    expect(polys.length).toBe(1);
    expect(polys[0]).toEqual([
      [0, 95],
      [10, 94],
      [10, 98],
      [0, 99],
    ]);
  });

  it('bridges the gap with fillgaps', () => {
    const ctx = new RecordingContext();
    paintFill(ctx.asCtx(), proj(), fill({ fillGaps: true }));
    const polys = ctx.fills(CSS_BLUE).map((f) => pathPoints(f.path));
    expect(polys.length).toBe(1);
    expect(polys[0][2]).toEqual([20, 93]); // bar 2 interpolated between 6 and 8
  });

  it('fills between hlines across the whole pane', () => {
    const ctx = new RecordingContext();
    paintFill(
      ctx.asCtx(),
      proj({ width: 500 }),
      fill({
        kind: 'hlines',
        upper: { kind: 'price', price: 70 },
        lower: { kind: 'price', price: 30 },
      }),
    );
    expect(ctx.rects(CSS_BLUE)[0]).toMatchObject({ x: 0, w: 500, y: 30, h: 40 });
  });

  it('gradient fills each segment with a vertical gradient between top and bottom values', () => {
    const ctx = new RecordingContext();
    const top = buildColorTrack(null, [RED, RED, RED, RED], 4);
    const bottom = buildColorTrack(null, [BLUE, BLUE, BLUE, BLUE], 4);
    paintFill(
      ctx.asCtx(),
      proj(),
      fill({
        kind: 'gradient',
        upper: { kind: 'plot', layer: b },
        lower: { kind: 'plot', layer: plotLayer([0, 0, 0, 0]) },
        gradient: {
          start: 0,
          topValues: Float64Array.of(4, 4, 4, 4),
          bottomValues: Float64Array.of(0, 0, 0, 0),
          topColors: top,
          bottomColors: bottom,
        },
      }),
    );
    const fills = ctx.fills();
    expect(fills.length).toBe(3);
    const g = fills[0].style as {
      kind: string;
      stops: Array<[number, string]>;
      y0: number;
      y1: number;
    };
    expect(g.kind).toBe('gradient');
    expect(g.stops).toEqual([
      [0, CSS_RED],
      [1, CSS_BLUE],
    ]);
    expect([g.y0, g.y1]).toEqual([96, 100]);
  });

  it('respects show_last through visibleFrom', () => {
    const ctx = new RecordingContext();
    paintFill(
      ctx.asCtx(),
      proj(),
      fill({ upper: { kind: 'plot', layer: plotLayer([5, 6, 7, 8]) }, visibleFrom: 2 }),
    );
    const xs = ctx.fills(CSS_BLUE).flatMap((f) => pathPoints(f.path).map(([xx]) => xx));
    expect(Math.min(...xs)).toBe(10);
  });
});
