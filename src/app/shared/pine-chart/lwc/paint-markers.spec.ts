import { describe, expect, it } from 'vitest';
import { DISPLAY_ALL } from '../core/display';
import { TRADE_COLORS } from '../render/build-render-model';
import type { MarkerLayer, TradeDrawing } from '../render/render-model';
import { RecordingContext, pathPoints } from '../testing/recording-context';
import type { HitRegion } from './paint-drawings';
import { MarkerStacks, charSizePx, paintMarkers, shapeSizePx } from './paint-markers';
import { paintTrades, tradeMarkers } from './paint-trades';
import { linearProjection } from './projection';

const proj = () =>
  linearProjection({
    barSpacing: 10,
    y0: 200,
    pxPerUnit: -1,
    width: 400,
    height: 300,
    from: -1,
    to: 60,
    lastLogical: 50,
  });
/** Every bar: high 120 (y 80), low 100 (y 100). */
const bars = { high: () => 120, low: () => 100 };

function markerLayer(extra: Partial<MarkerLayer> = {}, logicals = [3]): MarkerLayer {
  const n = logicals.length;
  return {
    type: 'marker',
    id: 1,
    key: 'marker:1',
    title: 'm',
    pane: 'main',
    display: DISPLAY_ALL,
    kind: 'shape',
    shape: 'circle',
    char: '★',
    location: 'abovebar',
    size: 'small',
    text: '',
    minHeight: 5,
    maxHeight: 100,
    format: { format: 'price', precision: 2 },
    logicals: Float64Array.from(logicals),
    values: Float64Array.from(logicals.map(() => 1)),
    colors: logicals.map(() => 'rgb(255, 0, 0)'),
    textColors: logicals.map(() => null),
    up: new Uint8Array(n),
    ...extra,
  };
}

const circleCenters = (ctx: RecordingContext) =>
  ctx
    .fills()
    .flatMap((f) =>
      f.path.filter((c): c is { c: 'A'; x: number; y: number; r: number } => c.c === 'A'),
    );

describe('paintMarkers', () => {
  it('sizes shapes and chars by size.*', () => {
    expect([shapeSizePx('tiny', 10), shapeSizePx('huge', 10)]).toEqual([8, 38]);
    expect(shapeSizePx('auto', 100)).toBe(14);
    expect(charSizePx('normal', 10)).toBe(20);
  });

  it('places abovebar over the high, belowbar under the low', () => {
    const ctx = new RecordingContext();
    paintMarkers(ctx.asCtx(), proj(), markerLayer(), bars, new MarkerStacks());
    paintMarkers(
      ctx.asCtx(),
      proj(),
      markerLayer({ location: 'belowbar' }),
      bars,
      new MarkerStacks(),
    );
    const [above, below] = circleCenters(ctx);
    expect(above.y + 6).toBeLessThanOrEqual(80 - 4 + 0.001); // bottom edge 4 px above the high
    expect(below.y - 6).toBeGreaterThanOrEqual(100 + 4 - 0.001);
    expect(above.x).toBe(30);
  });

  it('stacks two markers on the same bar and location instead of overlapping them', () => {
    const ctx = new RecordingContext();
    const stacks = new MarkerStacks();
    paintMarkers(ctx.asCtx(), proj(), markerLayer(), bars, stacks);
    paintMarkers(ctx.asCtx(), proj(), markerLayer({ id: 2 }), bars, stacks);
    const [first, second] = circleCenters(ctx);
    expect(second.y).toBeLessThan(first.y - 10);
  });

  it('top/bottom hug the pane edges; absolute sits on the value', () => {
    const ctx = new RecordingContext();
    paintMarkers(ctx.asCtx(), proj(), markerLayer({ location: 'top' }), bars, new MarkerStacks());
    paintMarkers(
      ctx.asCtx(),
      proj(),
      markerLayer({ location: 'bottom' }),
      bars,
      new MarkerStacks(),
    );
    paintMarkers(
      ctx.asCtx(),
      proj(),
      markerLayer({ location: 'absolute', values: Float64Array.of(150) }),
      bars,
      new MarkerStacks(),
    );
    const [top, bottom, abs] = circleCenters(ctx);
    expect(top.y).toBe(4 + 6);
    expect(bottom.y).toBe(300 - 4 - 6);
    expect(abs.y).toBe(50);
  });

  it('falls back to the pane edges for above/below bar in a pane without price bars', () => {
    const ctx = new RecordingContext();
    paintMarkers(ctx.asCtx(), proj(), markerLayer(), null, new MarkerStacks());
    expect(circleCenters(ctx)[0].y).toBe(10);
  });

  it('writes plotshape text above an abovebar shape and inside a label shape', () => {
    const ctx = new RecordingContext();
    paintMarkers(ctx.asCtx(), proj(), markerLayer({ text: 'Buy' }), bars, new MarkerStacks());
    const t = ctx.texts()[0];
    expect(t.text).toBe('Buy');
    expect(t.y).toBeLessThan(circleCenters(ctx)[0].y);
    const bubble = new RecordingContext();
    paintMarkers(
      bubble.asCtx(),
      proj(),
      markerLayer({ shape: 'labeldown', text: 'Sell' }),
      bars,
      new MarkerStacks(),
    );
    expect(bubble.texts()[0].text).toBe('Sell');
    expect(bubble.fills('rgb(255, 0, 0)').length).toBe(2); // bubble + pointer
  });

  it('plotchar draws its character', () => {
    const ctx = new RecordingContext();
    paintMarkers(
      ctx.asCtx(),
      proj(),
      markerLayer({ kind: 'char', char: '▲' }),
      bars,
      new MarkerStacks(),
    );
    expect(ctx.texts()[0]).toMatchObject({ text: '▲', style: 'rgb(255, 0, 0)' });
  });

  it('plotarrow: up under the bar, down over it, length proportional to |value|', () => {
    const ctx = new RecordingContext();
    const layer = markerLayer(
      {
        kind: 'arrow',
        minHeight: 10,
        maxHeight: 50,
        values: Float64Array.of(2, -1),
        up: Uint8Array.of(1, 0),
        colors: ['rgb(0, 128, 0)', 'rgb(255, 0, 0)'],
      },
      [2, 4],
    );
    paintMarkers(ctx.asCtx(), proj(), layer, bars, new MarkerStacks());
    const up = pathPoints(ctx.fills('rgb(0, 128, 0)')[0].path);
    const down = pathPoints(ctx.fills('rgb(255, 0, 0)')[0].path);
    const span = (pts: Array<[number, number]>) =>
      Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    expect(Math.min(...up.map((p) => p[1]))).toBeGreaterThanOrEqual(104); // below the low (y 100)
    expect(Math.max(...down.map((p) => p[1]))).toBeLessThanOrEqual(76); // above the high (y 80)
    expect(span(up)).toBeCloseTo(50); // the largest |value| gets maxheight
    expect(span(down)).toBeCloseTo(30); // half of it: min + (max − min) / 2
  });

  it('skips markers with an na color and points outside the view', () => {
    const ctx = new RecordingContext();
    paintMarkers(ctx.asCtx(), proj(), markerLayer({ colors: [null] }), bars, new MarkerStacks());
    paintMarkers(ctx.asCtx(), proj(), markerLayer({}, [500]), bars, new MarkerStacks());
    expect(ctx.ops).toEqual([]);
  });
});

describe('strategy trades', () => {
  const trade = (extra: Partial<TradeDrawing> = {}): TradeDrawing => ({
    number: 1,
    direction: 'long',
    isOpen: false,
    entryX: 5,
    entryPrice: 110,
    entrySignal: 'Long',
    exitX: 12,
    exitPrice: 115,
    exitSignal: 'TP',
    qty: 2,
    profit: 10,
    profitPercent: 4.5,
    lineColor: TRADE_COLORS.profit,
    ...extra,
  });

  it('a long trade buys in (blue, up, +qty) and sells out (purple, down, −qty)', () => {
    const [entry, exit] = tradeMarkers(trade());
    expect(entry).toMatchObject({
      side: 'buy',
      kind: 'entry',
      color: TRADE_COLORS.longEntry,
      text: 'Long\n+2 units',
      logical: 5,
      price: 110,
    });
    expect(exit).toMatchObject({
      side: 'sell',
      kind: 'exit',
      color: TRADE_COLORS.exit,
      text: 'TP\n-2 units',
      logical: 12,
    });
    expect(exit.tooltip).toContain('P/L +10.00');
  });

  it('labels quantities as Pine units, in the marker and its tooltip', () => {
    const [entry, exit] = tradeMarkers(trade({ qty: 100_000 }));
    expect(entry.text).toBe('Long\n+100,000 units');
    expect(entry.tooltip).toContain('Long entry "Long" · 100,000 units @ 110');
    expect(exit.text).toBe('TP\n-100,000 units');
    expect(exit.tooltip).toContain('100,000 units @ 115');
    expect(tradeMarkers(trade({ qty: 1 }))[0].text).toBe('Long\n+1 unit');
    expect(tradeMarkers(trade({ qty: 2500.25 }))[0].text).toBe('Long\n+2,500.25 units');
  });

  it('a short trade sells in (red) and buys out', () => {
    const [entry, exit] = tradeMarkers(trade({ direction: 'short', entrySignal: 'Short' }));
    expect(entry).toMatchObject({
      side: 'sell',
      color: TRADE_COLORS.shortEntry,
      text: 'Short\n-2 units',
    });
    expect(exit.side).toBe('buy');
  });

  it('an open trade has only its entry', () => {
    expect(tradeMarkers(trade({ isOpen: true, exitX: null, exitPrice: null }))).toHaveLength(1);
  });

  it('draws the dashed entry→exit line in the profit color, arrows and hit regions', () => {
    const ctx = new RecordingContext();
    const hits: HitRegion[] = [];
    paintTrades(
      ctx.asCtx(),
      proj(),
      [
        trade(),
        trade({ number: 2, entryX: 20, exitX: 25, profit: -3, lineColor: TRADE_COLORS.loss }),
      ],
      bars,
      118,
      new MarkerStacks(),
      hits,
    );
    const green = ctx.strokes(TRADE_COLORS.profit);
    expect(green).toHaveLength(1);
    expect(green[0].dash).toEqual([4, 3]);
    expect(pathPoints(green[0].path)).toEqual([
      [50, 90],
      [120, 85],
    ]);
    expect(ctx.strokes(TRADE_COLORS.loss)).toHaveLength(1);
    expect(ctx.texts().map((t) => t.text)).toEqual(
      expect.arrayContaining(['Long', '+2 units', 'TP', '-2 units']),
    );
    expect(hits).toHaveLength(4);
  });

  it('an open trade is drawn to the last bar at the last close', () => {
    const ctx = new RecordingContext();
    paintTrades(
      ctx.asCtx(),
      proj(),
      [trade({ isOpen: true, exitX: null, exitPrice: null })],
      bars,
      118,
      new MarkerStacks(),
      [],
    );
    expect(pathPoints(ctx.strokes(TRADE_COLORS.profit)[0].path)).toEqual([
      [50, 90],
      [500, 82],
    ]);
  });
});
