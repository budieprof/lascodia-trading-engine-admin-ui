import { describe, expect, it } from 'vitest';

import {
  alignRight,
  chartHeight,
  earliestAnnotation,
  indexAt,
  parsePriceChartSpec,
  pricePrecision,
  toPriceChartOption,
  windowFor,
  type PriceBar,
  type PriceChartSpec,
} from './price-annotations';

/**
 * The annotation layer's arithmetic and option shape.
 *
 * <p>Every case here is one of the ways an annotated chart is wrong while still looking right. A
 * marker one bar off, a panel series slid forward in time, a level clipped outside the y-bounds, a
 * crosshair that does not link the panels to the bar they describe — none of those produce a broken
 * chart, they produce a convincing one that says something else.</p>
 */

const H1 = 3_600_000;
const T0 = Date.UTC(2026, 8, 18, 8, 0, 0);

const bars = (n: number): PriceBar[] =>
  Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(T0 + i * H1).toISOString(),
    open: 1.146 + i * 0.0001,
    high: 1.1465 + i * 0.0001,
    low: 1.1455 + i * 0.0001,
    close: 1.1462 + i * 0.0001,
  }));

const spec = (over: Partial<PriceChartSpec>): PriceChartSpec => ({
  kind: 'price_chart',
  symbol: 'EURUSD',
  timeframe: 'H1',
  bars: 60,
  ...over,
});

const series = (o: unknown): any[] => (o as { series: any[] }).series;

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : [v]);

describe('parsePriceChartSpec', () => {
  it('accepts our own payload and rejects everything else', () => {
    expect(parsePriceChartSpec('{"kind":"price_chart","symbol":"EURUSD"}')?.symbol).toBe('EURUSD');
    expect(parsePriceChartSpec('{"kind":"chart","type":"bar"}')).toBeNull();
    expect(parsePriceChartSpec('{"error":"needs an annotation"}')).toBeNull();
    expect(parsePriceChartSpec(undefined)).toBeNull();
  });
});

describe('indexAt', () => {
  const rows = bars(5);

  it('lands an on-the-bar instant on that bar', () => {
    expect(indexAt(rows, rows[3].timestamp)).toBe(3);
  });

  it('interpolates between bars so a mid-bar anchor is drawn where it was anchored', () => {
    expect(indexAt(rows, new Date(T0 + 2 * H1 + H1 / 2).toISOString())).toBeCloseTo(2.5, 6);
  });

  it('clamps out-of-window instants to the edge rather than dropping the annotation', () => {
    // A vanished annotation reads as the analyst not having made the claim.
    expect(indexAt(rows, new Date(T0 - 50 * H1).toISOString())).toBe(0);
    expect(indexAt(rows, new Date(T0 + 50 * H1).toISOString())).toBe(4);
  });

  it('survives an unparseable instant and an empty window', () => {
    expect(indexAt(rows, 'sometime')).toBe(0);
    expect(indexAt([], rows[0].timestamp)).toBe(0);
  });
});

describe('alignRight', () => {
  it('pads a short panel series on the LEFT, so each reading keeps its own bar', () => {
    // Padding the right would slide a real dataset forward in time — the failure that still looks
    // like a working chart.
    expect(alignRight([1, 2, 3], 5)).toEqual([null, null, 1, 2, 3]);
  });

  it('keeps the newest values when the series is longer than the window', () => {
    expect(alignRight([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });

  it('is a no-op at exactly the window length', () => {
    expect(alignRight([1, 2], 2)).toEqual([1, 2]);
  });
});

describe('windowFor', () => {
  const now = T0 + 100 * H1;

  it('asks for the requested history when no annotation reaches further back', () => {
    const w = windowFor(spec({ bars: 60 }), now);
    expect(w.itemCount).toBe(62);
    expect(Date.parse(w.to)).toBe(now);
  });

  it('widens backwards to cover an older marker instead of clamping it to the left edge', () => {
    const w = windowFor(
      spec({
        bars: 60,
        markers: [
          {
            time: new Date(now - 90 * H1).toISOString(),
            price: 1.15,
            label: 'FOMC',
            kind: 'event',
          },
        ],
      }),
      now,
    );
    expect(w.itemCount).toBeGreaterThanOrEqual(93);
  });

  it('caps a very old anchor rather than asking for tens of thousands of bars', () => {
    const w = windowFor(
      spec({
        timeframe: 'M1',
        bars: 60,
        segments: [
          {
            from: { time: new Date(now - 400 * 24 * 60 * 60_000).toISOString(), price: 1.1 },
            to: { time: new Date(now).toISOString(), price: 1.1 },
          },
        ],
      }),
      now,
    );
    expect(w.itemCount).toBe(1000);
  });

  it('never asks for fewer bars than a chart can be read from', () => {
    expect(windowFor(spec({ bars: 1 }), now).itemCount).toBeGreaterThanOrEqual(20);
  });
});

describe('earliestAnnotation', () => {
  it('spans markers, trendlines, segments and the as-of instant', () => {
    const oldest = new Date(T0 - 10 * H1).toISOString();
    const got = earliestAnnotation(
      spec({
        asOfUtc: new Date(T0).toISOString(),
        markers: [{ time: oldest, price: 1.1, label: 'x', kind: 'event' }],
      }),
    );
    expect(got).toBe(Date.parse(oldest));
  });

  it('is null when nothing is time-anchored', () => {
    expect(
      earliestAnnotation(spec({ levels: [{ price: 1.1, label: 'L', kind: 'structure' }] })),
    ).toBeNull();
  });
});

describe('toPriceChartOption', () => {
  it('draws nothing without candles rather than an empty frame', () => {
    expect(toPriceChartOption(spec({}), [], 'light')).toBeNull();
  });

  it('includes every annotated price in the y-bounds, so nothing clips off the edge', () => {
    const opt = toPriceChartOption(
      spec({ levels: [{ price: 1.2, label: 'far above', kind: 'structure' }] }),
      bars(10),
      'light',
    )!;
    const y = asArray((opt as { yAxis: unknown }).yAxis)[0];
    expect(y.max).toBeGreaterThan(1.2);
  });

  it('gives each order-flow panel its own grid and links one crosshair across them all', () => {
    // A panel that is not read against the bar above it cannot show cumulative delta sloping down
    // under price sloping up, which is the only reason to draw one.
    const opt = toPriceChartOption(
      spec({
        panels: [
          { name: 'Δ', type: 'delta', data: [1, -2, 3] },
          { name: 'ΣΔ', type: 'cumulative', data: [1, -1, 2] },
        ],
      }),
      bars(10),
      'light',
    )!;
    expect(asArray((opt as { grid: unknown }).grid)).toHaveLength(3);
    const link = (opt as { axisPointer: { link: { xAxisIndex: number[] }[] } }).axisPointer.link[0];
    expect(link.xAxisIndex).toEqual([0, 1, 2]);
  });

  it('puts the volume profile in its own column on the price scale, not over the candles', () => {
    const opt = toPriceChartOption(
      spec({ volumeProfile: { poc: 1.1465, bins: [{ price: 1.1465, volume: 900 }] } }),
      bars(10),
      'light',
    )!;
    const grids = asArray((opt as { grid: unknown }).grid);
    expect(grids).toHaveLength(2);
    // The profile sits in the right gutter, sized by WIDTH against the right edge. Positioning it
    // by `left` instead spans the whole frame and lays the histogram across the candles — which
    // still renders, and still looks like a chart.
    expect(grids[1].width).toBeGreaterThan(0);
    expect(grids[1].left).toBeUndefined();
    expect(grids[1].right).toBeLessThan(grids[0].right);
    const profileY = asArray((opt as { yAxis: unknown }).yAxis)[1];
    const priceY = asArray((opt as { yAxis: unknown }).yAxis)[0];
    // Same scale exactly — a bin has to sit at the height of its own price.
    expect(profileY.min).toBe(priceY.min);
    expect(profileY.max).toBe(priceY.max);
    const bar = series(opt).find((s) => s.name === 'Volume profile');
    expect(bar.data).toEqual([[900, 1.1465]]);
  });

  it('shades the VWAP envelope as one band rather than two more levels', () => {
    const opt = toPriceChartOption(
      spec({ vwap: { value: 1.1465, upper: 1.147, lower: 1.146 } }),
      bars(10),
      'light',
    )!;
    const areas = series(opt)[0].markArea.data;
    expect(
      areas.some((a: { yAxis: number }[]) => a[0].yAxis === 1.146 && a[1].yAxis === 1.147),
    ).toBe(true);
    // One VWAP line, not three.
    expect(series(opt).filter((s) => s.name === 'VWAP')).toHaveLength(1);
  });

  it('colour-codes levels by TYPE — three kinds of claim must not read as one stack of lines', () => {
    const opt = toPriceChartOption(
      spec({
        levels: [
          { price: 1.1455, label: 'Swing low', kind: 'structure' },
          { price: 1.1468, label: 'POC', kind: 'value' },
          { price: 1.15, label: 'Round', kind: 'round' },
        ],
      }),
      bars(10),
      'light',
    )!;
    const colors = series(opt)
      .filter((s) => s.endLabel?.show && s.type === 'line')
      .map((s) => s.lineStyle.color);
    expect(new Set(colors).size).toBe(3);
  });

  it('names a segment its outcome as well as colouring it', () => {
    const rows = bars(10);
    const opt = toPriceChartOption(
      spec({
        segments: [
          {
            from: { time: rows[1].timestamp, price: 1.1465 },
            to: { time: rows[6].timestamp, price: 1.1455 },
            label: '#9331',
            outcome: 'win',
          },
        ],
      }),
      rows,
      'light',
    )!;
    const seg = series(opt).find((s) => s.name === '#9331');
    expect(seg.data).toEqual([
      [1, 1.1465],
      [6, 1.1455],
    ]);
    expect(seg.endLabel.formatter).toBe('#9331 · win');
  });

  it('draws a setup as shaded risk and reward bands, both anchored on the entry', () => {
    const opt = toPriceChartOption(
      spec({ setups: [{ label: 'Card A', action: 'Buy', entry: 1.146, sl: 1.145, tp: 1.148 }] }),
      bars(10),
      'light',
    )!;
    const areas = series(opt)[0].markArea.data as { yAxis: number }[][];
    expect(areas.some((a) => a[0].yAxis === 1.146 && a[1].yAxis === 1.148)).toBe(true);
    expect(areas.some((a) => a[0].yAxis === 1.146 && a[1].yAxis === 1.145)).toBe(true);
    expect(series(opt).filter((s) => String(s.name).startsWith('Card A'))).toHaveLength(3);
  });

  it('places a marker on the bar its timestamp belongs to', () => {
    const rows = bars(10);
    const opt = toPriceChartOption(
      spec({ markers: [{ time: rows[4].timestamp, price: 1.1465, label: 'FOMC', kind: 'event' }] }),
      rows,
      'light',
    )!;
    expect(series(opt)[0].markPoint.data[0].coord).toEqual([4, 1.1465]);
  });

  it('overlays a live price line only when one is streaming', () => {
    const rows = bars(10);
    expect(
      series(toPriceChartOption(spec({}), rows, 'light')!).some((s) => s.name === 'LIVE'),
    ).toBe(false);
    expect(
      series(toPriceChartOption(spec({}), rows, 'light', 1.1477)!).some((s) => s.name === 'LIVE'),
    ).toBe(true);
  });
});

describe('layout', () => {
  it('grows the frame by one band per order-flow panel', () => {
    const none = chartHeight(spec({}));
    const two = chartHeight(
      spec({
        panels: [
          { name: 'a', type: 'delta', data: [1] },
          { name: 'b', type: 'line', data: [1] },
        ],
      }),
    );
    expect(two).toBeGreaterThan(none);
  });

  it('reads JPY-style pairs to 3dp and majors to 5', () => {
    expect(pricePrecision(163.72)).toBe(3);
    expect(pricePrecision(1.1465)).toBe(5);
  });
});
