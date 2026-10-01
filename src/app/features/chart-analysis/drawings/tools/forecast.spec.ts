import { describe, expect, it } from 'vitest';
import type { Drawing } from '../model';
import { BEHAVIORS, barsPatternCopy, measureLines, movePositionHandle, positionLevels } from './forecast';
import {
  anchoredVwap,
  barsBetween,
  dateRangeText,
  forecastOutcome,
  formatDuration,
  formatTicks,
  formatVolume,
  ghostCandles,
  positionOutcome,
  positionPnl,
  positionStats,
  priceRangeText,
  resolutionMs,
  volumeBetween,
  volumeProfileRows,
  type OhlcvBar,
} from './forecast-math';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): OhlcvBar => ({
  time: i * H,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('position maths', () => {
  const base = {
    accountSize: 1000,
    lotSize: 1,
    risk: 25,
    riskUnit: '%' as const,
    leverage: 1000,
    qtyPrecision: 2,
  };

  it('long: R:R, qty from risk, amounts', () => {
    const s = positionStats({ ...base, side: 'long', entry: 100, target: 106, stop: 96 });
    expect(s.rr).toBeCloseTo(1.5);
    expect(s.riskAmount).toBe(250);
    expect(s.qty).toBeCloseTo(62.5); // 250 / 4
    expect(s.targetAmount).toBeCloseTo(375);
    expect(s.stopAmount).toBeCloseTo(250);
    expect(s.targetPct).toBeCloseTo(6);
  });

  it('short mirrors long', () => {
    const s = positionStats({ ...base, side: 'short', entry: 100, target: 94, stop: 104 });
    expect(s.rr).toBeCloseTo(1.5);
    expect(s.qty).toBeCloseTo(62.5);
  });

  it('leverage caps the size; money risk unit', () => {
    const s = positionStats({ ...base, leverage: 1, side: 'long', entry: 100, target: 106, stop: 96 });
    expect(s.qty).toBe(10); // 1000*1/100 < 62.5
    const m = positionStats({ ...base, riskUnit: 'money', risk: 40, side: 'long', entry: 100, target: 106, stop: 96 });
    expect(m.qty).toBe(10);
  });

  it('P&L sign per side', () => {
    expect(positionPnl('long', 100, 103, 10, 1)).toBe(30);
    expect(positionPnl('short', 100, 103, 10, 1)).toBe(-30);
  });

  it('outcome walks bars: target, stop, open', () => {
    const bars = [bar(0, 100, 101, 99, 100), bar(1, 100, 104, 99.5, 103), bar(2, 103, 107, 102, 106)];
    expect(positionOutcome(bars, 'long', 100, 106, 96, 0, 10 * H)).toEqual({ state: 'target', time: 2 * H, price: 106 });
    expect(positionOutcome(bars, 'short', 100, 94, 104, 0, 10 * H).state).toBe('stop');
    expect(positionOutcome(bars, 'long', 100, 110, 90, 0, 10 * H)).toEqual({ state: 'open', time: 2 * H, price: 106 });
  });

  it('handles change only their own value', () => {
    const d = {
      kind: 'long-position',
      resolution: '60',
      points: [
        { time: 0, price: 100 },
        { time: 20 * H, price: 106 },
        { time: 20 * H, price: 96 },
      ],
    } as Drawing;
    expect(movePositionHandle(d, 'long', 1, { time: 5 * H, price: 110 })).toEqual([
      { time: 0, price: 100 },
      { time: 20 * H, price: 110 },
      { time: 20 * H, price: 96 },
    ]);
    // A target dragged below the entry is refused.
    expect(movePositionHandle(d, 'long', 1, { time: 5 * H, price: 90 })[1].price).toBe(106);
    expect(movePositionHandle(d, 'long', 2, { time: 5 * H, price: 95 })[2].price).toBe(95);
    expect(movePositionHandle(d, 'long', 3, { time: 30 * H, price: 1 })[1]).toEqual({ time: 30 * H, price: 106 });
  });

  it('one-click position derives a 1.5R default', () => {
    const d = { kind: 'short-position', resolution: '60', points: [{ time: 0, price: 1.1 }] } as Drawing;
    const l = positionLevels(d, 'short');
    expect(l.target).toBeLessThan(1.1);
    expect(l.stop).toBeGreaterThan(1.1);
    expect((1.1 - l.target) / (l.stop - 1.1)).toBeCloseTo(1.5);
    expect(l.end).toBe(20 * H);
  });
});

describe('range text', () => {
  it('price range: delta, percent, ticks / pips', () => {
    expect(priceRangeText(1.1, 1.105, 5)).toBe('0.00500 (0.45%) 50.0');
    expect(priceRangeText(200, 190, 2)).toBe('-10.00 (-5.00%) -1000');
    expect(formatTicks(0.005, 5)).toBe('50.0');
  });

  it('date range: bars and duration', () => {
    expect(formatDuration(51 * H)).toBe('2d 3h');
    expect(formatDuration(200 * 60_000)).toBe('3h 20m');
    expect(formatDuration(0)).toBe('0m');
    expect(dateRangeText(24, 24 * H)).toBe('24 bars, 1d');
    expect(dateRangeText(1, H)).toBe('1 bar, 1h');
  });

  it('bar counting inside and past the series', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1, 1, 1, 1));
    expect(barsBetween(bars, 2 * H, 7 * H, H)).toBe(5);
    expect(barsBetween(bars, 7 * H, 2 * H, H)).toBe(-5);
    expect(barsBetween(bars, 8 * H, 14 * H, H)).toBe(6); // extrapolated into the future
    // Weekend gap: index distance, not wall-clock hours.
    const gap = [bar(0, 1, 1, 1, 1), bar(1, 1, 1, 1, 1), { ...bar(50, 1, 1, 1, 1) }];
    expect(barsBetween(gap, 0, 50 * H, H)).toBe(2);
    expect(volumeBetween(bars, 2 * H, 4 * H)).toBe(300);
    expect(formatVolume(1_234_000)).toBe('1.23M');
    expect(resolutionMs('60')).toBe(H);
    expect(resolutionMs('D')).toBe(24 * H);
  });

  it('measure lines combine all three', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 1, 1, 1, 1, 10));
    expect(measureLines(bars, { time: 0, price: 100 }, { time: 3 * H, price: 101 }, 2, H)).toEqual([
      '1.00 (1.00%) 100',
      '3 bars, 3h',
      'Vol 40',
    ]);
  });
});

describe('anchored VWAP', () => {
  it('cumulative from the anchor with stdev', () => {
    const bars = [bar(0, 9, 9, 9, 9, 50), bar(1, 10, 10, 10, 10, 100), bar(2, 13, 13, 13, 13, 100), bar(3, 16, 16, 16, 16, 200)];
    const v = anchoredVwap(bars, H);
    expect(v.map((x) => x.time)).toEqual([H, 2 * H, 3 * H]);
    expect(v[0].vwap).toBe(10);
    expect(v[1].vwap).toBeCloseTo(11.5);
    expect(v[1].stdev).toBeCloseTo(1.5);
    expect(v[2].vwap).toBeCloseTo((1000 + 1300 + 3200) / 400);
  });
});

describe('volume profile rows', () => {
  it('spreads volume by overlap, splits up/down, finds POC and value area', () => {
    const bars = [
      bar(0, 0, 4, 0, 4, 400), // up, spans rows 0..3 → 100 each
      bar(1, 2, 2, 1, 1, 100), // down, row 1 only
      bar(2, 1, 2, 1, 2, 50), // up, row 1 only
    ];
    const p = volumeProfileRows(bars, 4, 70)!;
    expect(p.rows.map((r) => r.total)).toEqual([100, 250, 100, 100]);
    expect(p.rows[1].up).toBe(150);
    expect(p.rows[1].down).toBe(100);
    expect(p.poc).toBe(1);
    // 70% of 550 = 385: POC 250 + above 100 = 350, + next (row 2 100 vs row 0 100 → above) = 450.
    expect([p.vaLow, p.vaHigh]).toEqual([1, 3]);
  });

  it('respects the row count and is empty without volume', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 1 + i * 0.01, 1.02 + i * 0.01, 0.99 + i * 0.01, 1.01 + i * 0.01));
    expect(volumeProfileRows(bars, 24)!.rows).toHaveLength(24);
    expect(volumeProfileRows([bar(0, 1, 2, 0, 1, 0)], 24)).toBeNull();
  });
});

describe('forecast / bars pattern / ghost feed', () => {
  const bars = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 10, 11), bar(2, 11, 15, 11, 14), bar(3, 14, 14, 13, 13)];
  it('forecast success / failure / pending', () => {
    expect(forecastOutcome(bars, { time: 0, price: 10 }, { time: 3 * H, price: 15 })).toBe('success');
    expect(forecastOutcome(bars, { time: 0, price: 10 }, { time: 2 * H, price: 20 })).toBe('failure');
    expect(forecastOutcome(bars, { time: 0, price: 10 }, { time: 9 * H, price: 20 })).toBe('pending');
    expect(forecastOutcome(bars, { time: 0, price: 10 }, { time: 3 * H, price: 9.5 })).toBe('failure');
  });

  it('bars pattern copies the shape re-based, mirrored and flipped', () => {
    const c = barsPatternCopy(bars, 100, false, false);
    expect(c[0]).toEqual({ index: 0, open: 100, high: 101, low: 99, close: 100 });
    expect(c[2].high).toBe(105);
    const f = barsPatternCopy(bars, 100, false, true);
    expect(f[2].low).toBe(95);
    const m = barsPatternCopy(bars, 100, true, false);
    expect(m[0].open).toBe(100); // starts at the last bar's close
    expect(m[3].close).toBe(97); // ends at the first bar's open, re-based
  });

  it('ghost candles follow the path and are deterministic', () => {
    const path = [
      { index: 0, price: 1 },
      { index: 5, price: 1.005 },
    ];
    const a = ghostCandles(path, 20, 50, 0.00001, 'x');
    expect(a).toHaveLength(5);
    expect(a[4].close).toBeCloseTo(1.005);
    expect(a[1].open).toBe(a[0].close);
    expect(ghostCandles(path, 20, 50, 0.00001, 'x')).toEqual(a);
    for (const c of a) expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
  });
});

describe('registry', () => {
  it('covers every tool in the family', () => {
    for (const k of [
      'long-position',
      'short-position',
      'forecast',
      'bars-pattern',
      'ghost-feed',
      'projection',
      'anchored-vwap',
      'fixed-range-volume-profile',
      'anchored-volume-profile',
      'price-range',
      'date-range',
      'measure',
      'ruler',
    ] as const) {
      expect(BEHAVIORS[k]?.paint).toBeTypeOf('function');
    }
    expect(BEHAVIORS['long-position']!.points).toBe(1);
  });
});
