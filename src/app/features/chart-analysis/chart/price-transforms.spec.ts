import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import {
  averageTrueRange,
  boxBase,
  toKagi,
  toLineBreak,
  toPointAndFigure,
  toRangeBars,
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

  // CC-16: the reversal brick used to open at the last close (`anchor + brickSize * 0`), so every
  // reversal drew a brick over the previous brick's range plus a second one beside it.
  it('a reversal draws exactly one brick, starting where the last brick started', () => {
    // Up 3 bricks (100→103), then down to 101: two bricks against the trend = ONE reversal brick.
    const bricks = toRenko(series([100, 101, 102, 103, 101]), 1);
    expect(bricks.map((b) => [b.open, b.close])).toEqual([
      [100, 101],
      [101, 102],
      [102, 103],
      [102, 101],
    ]);
  });

  it('an up reversal after a down run also starts one brick back', () => {
    const bricks = toRenko(series([100, 99, 98, 100]), 1);
    expect(bricks.map((b) => [b.open, b.close])).toEqual([
      [100, 99],
      [99, 98],
      [99, 100],
    ]);
  });

  it('bricks never overlap the brick before them', () => {
    const bricks = toRenko(series([100, 103, 99, 104, 96, 101, 95, 102]), 1);
    for (let i = 1; i < bricks.length; i++) {
      const [a, b] = [bricks[i - 1], bricks[i]];
      const lo = Math.max(Math.min(a.open, a.close), Math.min(b.open, b.close));
      const hi = Math.min(Math.max(a.open, a.close), Math.max(b.open, b.close));
      expect(hi - lo, `bricks ${i - 1} and ${i} overlap`).toBeLessThanOrEqual(1e-9);
    }
  });

  it('wicks hang the furthest price traded against a brick before it formed', () => {
    const bars: Bar[] = [
      { time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      // Dips to 99.4 before closing at 100.5: still inside the first brick.
      { time: 3_600_000, open: 100, high: 100.6, low: 99.4, close: 100.5, volume: 1 },
      { time: 7_200_000, open: 100.5, high: 101.2, low: 100.4, close: 101.1, volume: 1 },
    ];
    const [plain] = toRenko(bars, 1);
    expect([plain.low, plain.high]).toEqual([100, 101]);
    const [wicked] = toRenko(bars, 1, { wicks: true });
    expect(wicked.low).toBe(99.4);
    expect(wicked.high).toBe(101);
  });
});

describe('boxBase — the ATR box size is fixed at load (CC-16)', () => {
  it('leaves the forming bar out, so a tick on it never moves the box', () => {
    const closed = series([100, 101, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 106, 108]);
    const forming = { ...closed[closed.length - 1], time: closed[closed.length - 1].time + 3_600_000 };
    const quiet = boxBase([...closed, { ...forming, high: 108.1, low: 107.9, close: 108 }], true);
    const spike = boxBase([...closed, { ...forming, high: 140, low: 80, close: 120 }], true);
    expect(spike).toBe(quiet);
    expect(quiet).toBe(boxBase(closed, false));
  });

  it('never returns zero for a flat series', () => {
    expect(boxBase(series([1.1, 1.1, 1.1, 1.1]), true)).toBeGreaterThan(0);
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

describe('toRangeBars', () => {
  const ohlc = (time: number, open: number, high: number, low: number, close: number): Bar => ({
    time,
    open,
    high,
    low,
    close,
    volume: 1,
  });

  it('returns nothing for empty input or a non-positive range', () => {
    expect(toRangeBars([], 1)).toEqual([]);
    expect(toRangeBars(series([1, 2]), 0)).toEqual([]);
  });

  it('every completed bar spans exactly the range size', () => {
    const bars = series([100, 103, 101, 106, 99, 104, 110, 102]);
    const out = toRangeBars(bars, 2);
    expect(out.length).toBeGreaterThan(3);
    for (const b of out.slice(0, -1)) {
      expect(b.high - b.low).toBeCloseTo(2, 9);
      expect(b.close === b.high || b.close === b.low).toBe(true);
    }
    assertStrictlyIncreasing(out);
  });

  it('chains each bar open to the previous close', () => {
    const out = toRangeBars(series([100, 105, 97, 108]), 1.5);
    for (let i = 1; i < out.length; i++) expect(out[i].open).toBeCloseTo(out[i - 1].close, 9);
  });

  it('walks an up candle open -> low -> high -> close', () => {
    // Dips 2 first, then rallies 6: the first bar must be a DOWN bar.
    const out = toRangeBars([ohlc(0, 100, 106, 98, 105)], 2);
    expect(out[0].close).toBeLessThan(out[0].open);
    expect(out[0].low).toBe(98);
    expect(out.slice(1, -1).every((b) => b.close > b.open)).toBe(true);
  });

  it('walks a down candle open -> high -> low -> close', () => {
    const out = toRangeBars([ohlc(0, 100, 102, 94, 95)], 2);
    expect(out[0].close).toBeGreaterThan(out[0].open);
    expect(out[0].high).toBe(102);
  });
});
