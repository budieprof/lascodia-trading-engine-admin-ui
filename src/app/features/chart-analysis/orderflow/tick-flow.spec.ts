import { describe, expect, it } from 'vitest';

import type { TickBarDto } from './orderflow.types';
import {
  barEnd,
  flowIndexes,
  footprintAllowed,
  footprintCells,
  footprintRowPoints,
  formatRowSize,
  medianBarRange,
  liquidityPulled,
  tickBarsByTime,
  tickBarsRequest,
} from './tick-flow';

const H = 3_600_000;
const T0 = Date.parse('2026-10-19T21:00:00Z');

describe('tick-bars request (OF-2)', () => {
  it('sends the chart’s own bar opens; the last bar ends at the next open', () => {
    const bars = [0, 1, 2, 3].map((i) => ({ time: T0 + i * H }));
    const req = tickBarsRequest('EURUSD', bars, { from: 1, to: 2 }, H, T0 + 10 * H, null)!;
    expect(req.barTimes).toEqual([
      new Date(T0 + H).toISOString(),
      new Date(T0 + 2 * H).toISOString(),
    ]);
    expect(req.endUtc).toBe(new Date(T0 + 3 * H).toISOString());
    expect(req.footprint).toBe(false);
    expect('footprintRowPoints' in req).toBe(false);
  });

  it('session grid: H4 bars on the 17:00 New York grid keep their own opens and closes', () => {
    // EDT: the trading day opens 21:00 UTC; H4 bars at 21:00, 01:00, 05:00 … and Friday's last closes at 21:00.
    const bars = [
      { time: T0, closeTime: T0 + 4 * H },
      { time: T0 + 4 * H, closeTime: T0 + 8 * H },
      { time: T0 + 8 * H, closeTime: T0 + 12 * H },
    ];
    const live = T0 + 9 * H;
    const req = tickBarsRequest('EURUSD', bars, { from: 0, to: 2 }, 4 * H, live, {
      rowPoints: 10,
    })!;
    expect(req.barTimes).toEqual(bars.map((b) => new Date(b.time).toISOString()));
    // The forming bar ends now, not at its session close.
    expect(req.endUtc).toBe(new Date(live).toISOString());
    expect(req.footprint).toBe(true);
    expect(req.footprintRowPoints).toBe(10);
  });

  it('the newest bar ends at its close, its width, or the cap — always after its open', () => {
    const bars = [{ time: T0 }];
    expect(barEnd(bars, 0, H, T0 + 5 * H)).toBe(T0 + H);
    expect(barEnd(bars, 0, H, T0 + 30 * 60_000)).toBe(T0 + 30 * 60_000);
    expect(barEnd(bars, 0, null, T0 + 2 * H)).toBe(T0 + 2 * H);
    expect(barEnd(bars, 0, H, T0 - 5)).toBe(T0 + 1);
    expect(barEnd([{ time: T0, closeTime: T0 + 2 * H }], 0, H, T0 + 9 * H)).toBe(T0 + 2 * H);
  });

  it('indexes: the visible bars, half again to the left, to the newest when it is on screen, capped', () => {
    expect(flowIndexes({ fromIndex: 100, toIndex: 199, rightEdgeInView: true }, 300, 2000)).toEqual(
      {
        from: 50,
        to: 299,
      },
    );
    expect(
      flowIndexes({ fromIndex: 100, toIndex: 199, rightEdgeInView: false }, 300, 2000),
    ).toEqual({
      from: 50,
      to: 224,
    });
    // Too many: the newest are kept.
    expect(flowIndexes({ fromIndex: 0, toIndex: 2999, rightEdgeInView: true }, 3000, 2000)).toEqual(
      {
        from: 1000,
        to: 2999,
      },
    );
    expect(flowIndexes({ fromIndex: 0, toIndex: 10, rightEdgeInView: true }, 0, 2000)).toBeNull();
  });

  it('footprint is allowed over ≤ 3 days and ≤ 500 bars only', () => {
    expect(footprintAllowed(30, T0, T0 + 30 * H)).toBe(true);
    expect(footprintAllowed(501, T0, T0 + H)).toBe(false);
    expect(footprintAllowed(30, T0, T0 + 73 * H)).toBe(false);
    expect(footprintAllowed(0, T0, T0)).toBe(false);
  });

  it('indexes the response by bar open', () => {
    const m = tickBarsByTime([
      bar({ t: '2026-10-19T21:00:00Z' }),
      bar({ t: '2026-10-19T22:00:00' }),
    ]);
    expect(m.has(T0)).toBe(true);
    expect(m.has(T0 + H)).toBe(true);
  });
});

function bar(over: Partial<TickBarDto> = {}): TickBarDto {
  return {
    t: '2026-10-19T21:00:00Z',
    source: 'ticks',
    ticks: 100,
    upTicks: 50,
    downTicks: 50,
    delta: 0,
    cumDelta: 0,
    spreadMinPoints: 1,
    spreadAvgPoints: 2,
    spreadMaxPoints: 3,
    ticksPerMinute: 10,
    ...over,
  };
}

describe('liquidity pulled (OF-4)', () => {
  const calm = Array.from({ length: 20 }, () => bar());

  it('flags a bar whose spread is ≥ 2× its median AND whose tick rate spikes', () => {
    const flags = liquidityPulled([...calm, bar({ spreadAvgPoints: 4, ticksPerMinute: 20 })]);
    expect(flags.at(-1)).toBe(true);
    expect(flags.slice(0, 20).some(Boolean)).toBe(false);
  });

  it('wide spread alone, or a tick burst alone, is not “pulled”', () => {
    expect(liquidityPulled([...calm, bar({ spreadAvgPoints: 6, ticksPerMinute: 12 })]).at(-1)).toBe(
      false,
    );
    expect(
      liquidityPulled([...calm, bar({ spreadAvgPoints: 2.5, ticksPerMinute: 60 })]).at(-1),
    ).toBe(false);
  });

  it('candle-filled bars and short histories are never judged', () => {
    const candle = bar({ source: 'candle', spreadAvgPoints: 9, ticksPerMinute: null });
    expect(liquidityPulled([...calm, candle]).at(-1)).toBe(false);
    expect(
      liquidityPulled([bar(), bar(), bar({ spreadAvgPoints: 9, ticksPerMinute: 90 })]).at(-1),
    ).toBe(false);
  });

  it('a candle bar’s spread counts toward the spread median but not the tick-rate median', () => {
    const mixed = [
      ...Array.from({ length: 10 }, () =>
        bar({ source: 'candle', spreadAvgPoints: 2, ticksPerMinute: null }),
      ),
      ...Array.from({ length: 5 }, () => bar()),
      bar({ spreadAvgPoints: 4, ticksPerMinute: 20 }),
    ];
    expect(liquidityPulled(mixed).at(-1)).toBe(true);
  });
});

describe('footprint maths (OF-3)', () => {
  const row = 0.0001;

  it('rows highest first; the busiest row is marked', () => {
    const cells = footprintCells(
      [
        { price: 1.1, up: 5, down: 4 },
        { price: 1.1001, up: 20, down: 2 },
        { price: 1.1002, up: 1, down: 1 },
      ],
      row,
    );
    expect(cells.map((c) => c.price)).toEqual(
      [1.1002, 1.1001, 1.1].map((p) => expect.closeTo(p, 10)),
    );
    expect(cells.find((c) => c.maxActivity)?.up).toBe(20);
    expect(cells.filter((c) => c.maxActivity)).toHaveLength(1);
  });

  it('diagonal 3:1 — up-ticks against the row below, down-ticks against the row above', () => {
    const cells = footprintCells(
      [
        { price: 1.1, up: 0, down: 4 },
        { price: 1.1001, up: 12, down: 0 },
        { price: 1.1002, up: 1, down: 9 },
      ],
      row,
    );
    const at = (p: number) => cells.find((c) => Math.abs(c.price - p) < 1e-9)!;
    // 12 up at 1.1001 vs 4 down at 1.1000: exactly 3 : 1.
    expect(at(1.1001).buyImbalance).toBe(true);
    // 9 down at 1.1002 vs 0 up above it (counts as 1): imbalance.
    expect(at(1.1002).sellImbalance).toBe(true);
    // 4 down at 1.1000 vs 12 up above: no.
    expect(at(1.1).sellImbalance).toBe(false);
    // 1 up at 1.1002 vs 0 down below: one tick against nothing is not an imbalance.
    expect(at(1.1002).buyImbalance).toBe(false);
  });

  it('just under 3:1 is not an imbalance', () => {
    const cells = footprintCells(
      [
        { price: 1.1, up: 0, down: 5 },
        { price: 1.1001, up: 14, down: 0 },
      ],
      row,
    );
    expect(cells[0].buyImbalance).toBe(false);
  });

  it('merges rows that share a key and ignores bad input', () => {
    expect(footprintCells([], row)).toEqual([]);
    expect(footprintCells([{ price: 1.1, up: 1, down: 1 }], 0)).toEqual([]);
    const merged = footprintCells(
      [
        { price: 1.1, up: 1, down: 2 },
        { price: 1.100000001, up: 3, down: 4 },
      ],
      row,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ up: 4, down: 6 });
  });

  it('row height: about ten rows across the median bar, snapped to nice points, never under one point', () => {
    const P = 0.00001; // 5-digit EURUSD point; a pip is 10 points
    // An EURUSD 1m bar of ~2 pips (20 points): rows of 2 points (0.2 pip) give 10 rows — not 1 pip (2 rows).
    expect(footprintRowPoints(0.0002, P)).toBe(2);
    // ~1 pip: 1 point (10 rows).
    expect(footprintRowPoints(0.0001, P)).toBe(1);
    // A 1h bar of ~15 pips: 2 points gives 75 rows, 20 points gives 7.5, 10 points 15 — 20 is nearest ten (log).
    expect(footprintRowPoints(0.0015, P)).toBe(20);
    // ~50 pips on 4h: 50 points (5 pips) = 10 rows.
    expect(footprintRowPoints(0.005, P)).toBe(50);
    // Tiny bars never go below one point; no range keeps what is held (or one point).
    expect(footprintRowPoints(0.00001, P)).toBe(1);
    expect(footprintRowPoints(0, P)).toBe(1);
    expect(footprintRowPoints(0, P, 5)).toBe(5);
    // 3-digit USDJPY: point 0.001; a 20-pip (0.2) bar → 20 points (2 pips) = 10 rows.
    expect(footprintRowPoints(0.2, 0.001)).toBe(20);
  });

  it('keeps a held row size while a typical bar still has 6–16 rows (no flapping), re-picks beyond', () => {
    const P = 0.00001;
    expect(footprintRowPoints(0.00025, P, 2)).toBe(2); // 12.5 rows: kept
    expect(footprintRowPoints(0.00013, P, 2)).toBe(2); // 6.5 rows: kept
    expect(footprintRowPoints(0.0004, P, 2)).toBe(5); // 20 rows: re-picked (8 at 5 points)
    expect(footprintRowPoints(0.0001, P, 2)).toBe(1); // 5 rows: re-picked
  });

  it('median visible bar range, and the row size in words', () => {
    const bars = [
      { high: 1.1003, low: 1.1 },
      { high: 1.1001, low: 1.1 },
      { high: 1.1, low: 1.1 },
      { high: 1.1002, low: 1.1 },
    ];
    expect(medianBarRange(bars, 0, 3)).toBeCloseTo(0.0002, 10);
    expect(medianBarRange(bars, 1, 1)).toBeCloseTo(0.0001, 10);
    expect(medianBarRange([], 0, 3)).toBe(0);
    expect(formatRowSize(2, 0.00001, 0.0001)).toBe('0.2 pip');
    expect(formatRowSize(10, 0.00001, 0.0001)).toBe('1 pip');
    expect(formatRowSize(50, 0.00001, 0.0001)).toBe('5 pips');
    expect(formatRowSize(20, 0.001, 0.01)).toBe('2 pips');
  });
});
