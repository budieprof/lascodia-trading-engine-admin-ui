import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  averageTrueRange,
  toKagi,
  toLineBreak,
  toPointAndFigure,
  toRenko,
} from './price-transforms';

/** A rising then falling series, one bar per hour. */
function series(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    time: Date.parse('2026-09-01T00:00:00Z') + i * 3_600_000,
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]),
    low: Math.min(c, i === 0 ? c : closes[i - 1]),
    close: c,
    volume: 10,
  }));
}

/** Bar times must be strictly increasing or the library rejects the series. */
function assertStrictlyIncreasing(bars: Bar[]): void {
  for (let i = 1; i < bars.length; i++) {
    expect(bars[i].time, `bar ${i} must be after bar ${i - 1}`).toBeGreaterThan(bars[i - 1].time);
  }
}

describe('averageTrueRange', () => {
  it('is zero for a flat series', () => {
    expect(averageTrueRange(series([10, 10, 10, 10]))).toBe(0);
  });

  it('is positive when price moves', () => {
    expect(averageTrueRange(series([10, 12, 14, 16]))).toBeGreaterThan(0);
  });
});

describe('toRenko', () => {
  it('emits one brick per full brick-size move', () => {
    const bricks = toRenko(series([100, 101, 102, 103]), 1);
    expect(bricks.length).toBe(3);
    expect(bricks[0].close - bricks[0].open).toBeCloseTo(1, 8);
  });

  it('emits nothing while price stays inside a brick', () => {
    // The whole point of Renko: small moves produce no bars at all.
    expect(toRenko(series([100, 100.2, 100.1, 100.3]), 1)).toHaveLength(0);
  });

  it('requires a larger move to reverse than to continue', () => {
    // Up to 103, then back to 102.5: less than two bricks, so no reversal.
    const bricks = toRenko(series([100, 101, 102, 103, 102.5]), 1);
    expect(bricks.every((b) => b.close > b.open)).toBe(true);
  });

  it('reverses once price moves two bricks against the trend', () => {
    const bricks = toRenko(series([100, 101, 102, 103, 101]), 1);
    expect(bricks.some((b) => b.close < b.open)).toBe(true);
  });

  it('keeps bar times strictly increasing even when many bricks share a bar', () => {
    // A single 10-unit jump makes ten bricks from one source bar; without
    // resequencing they would all carry the same timestamp and be rejected.
    const bricks = toRenko(series([100, 110]), 1);
    expect(bricks.length).toBeGreaterThan(5);
    assertStrictlyIncreasing(bricks);
  });

  it('refuses a non-positive brick size rather than looping forever', () => {
    expect(toRenko(series([100, 110]), 0)).toEqual([]);
  });
});

describe('toLineBreak', () => {
  it('extends on a break of the recent range', () => {
    const blocks = toLineBreak(series([100, 101, 102, 103]), 3);
    expect(blocks.length).toBeGreaterThan(1);
    assertStrictlyIncreasing(blocks);
  });

  it('ignores moves that do not break the last N blocks', () => {
    const blocks = toLineBreak(series([100, 101, 102, 101.5, 101.8]), 3);
    // The pullback never breaks below the 3-block low, so no new block.
    expect(blocks.every((b) => b.close >= 100)).toBe(true);
  });
});

describe('toPointAndFigure', () => {
  it('builds columns and keeps times legal', () => {
    const cols = toPointAndFigure(series([100, 101, 102, 103, 100, 99, 103]), 1, 3);
    expect(cols.length).toBeGreaterThan(0);
    assertStrictlyIncreasing(cols);
  });

  it('returns nothing for a non-positive box size', () => {
    expect(toPointAndFigure(series([100, 110]), 0, 3)).toEqual([]);
  });
});

describe('toKagi', () => {
  it('turns only on a move of at least the reversal', () => {
    const line = toKagi(series([100, 105, 104.5, 110, 100]), 3);
    expect(line.length).toBeGreaterThan(0);
    assertStrictlyIncreasing(line);
  });

  it('returns nothing for a non-positive reversal', () => {
    expect(toKagi(series([100, 110]), 0)).toEqual([]);
  });
});

describe('empty input', () => {
  it('every transform tolerates an empty series', () => {
    expect(toRenko([], 1)).toEqual([]);
    expect(toLineBreak([], 3)).toEqual([]);
    expect(toPointAndFigure([], 1, 3)).toEqual([]);
    expect(toKagi([], 1)).toEqual([]);
    expect(averageTrueRange([])).toBe(0);
  });
});
