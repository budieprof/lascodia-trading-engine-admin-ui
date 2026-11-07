import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import { compareSeriesPoints, comparePanes, type CompareSeriesSpec } from './compare-series';
import {
  SyntheticTicks,
  asOfJoin,
  parseSynthetic,
  syntheticBars,
  syntheticNotice,
  syntheticSymbol,
  syntheticTitle,
} from './synthetic';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 13);
const bar = (h: number, o: number, hi: number, lo: number, c: number): Bar => ({
  time: T0 + h * H,
  open: o,
  high: hi,
  low: lo,
  close: c,
  volume: 5,
});
const flat = (h: number, c: number) => bar(h, c, c, c, c);

describe('US04 synthetic symbols', () => {
  it('round-trips the symbol and refuses anything that is not a spread or ratio of two symbols', () => {
    const spec = { kind: 'spread' as const, a: 'EURUSD', b: 'GBPUSD', mult: 1.2 };
    expect(syntheticSymbol(spec)).toBe('SPREAD(EURUSD,GBPUSD,1.2)');
    expect(parseSynthetic('spread(eurusd,gbpusd,1.2)')).toEqual(spec);
    expect(parseSynthetic('RATIO(BTC-USD,ES1!)')).toEqual({ kind: 'ratio', a: 'BTC-USD', b: 'ES1!', mult: 1 });
    expect(syntheticSymbol({ kind: 'ratio', a: 'A', b: 'B', mult: 1 })).toBe('RATIO(A,B)');
    expect(syntheticTitle(spec)).toBe('EURUSD − 1.2 × GBPUSD');
    for (const bad of ['EURUSD', 'RATIO(A,A)', 'RATIO(A,B,2)', 'SPREAD(A,B,0)', 'SPREAD(A,B,x)', 'RATIO(A)'])
      expect(parseSynthetic(bad), bad).toBeNull();
  });

  it('as-of join: every time either leg has, from when both have started; a leg without a bar holds its last', () => {
    const a = [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }];
    const b = [{ time: 2 }, { time: 4 }];
    const rows = asOfJoin([a, b]);
    expect(rows.map((r) => [r.time, r.legs[1].time, r.carried[1]])).toEqual([
      [2, 2, false],
      [3, 2, true],
      [4, 4, false],
    ]);
    // Same times on both legs: exactly the exact-time join.
    expect(asOfJoin([a, a]).every((r) => !r.carried.some(Boolean))).toBe(true);
  });

  it('OHLC: open and close from the legs, high and low bound the bar; a carried leg is flat at its close', () => {
    const a = [bar(0, 2, 2.2, 1.8, 2.1), bar(1, 2.1, 2.4, 2.0, 2.3)];
    const b = [bar(0, 1, 1.1, 0.9, 1.05)]; // closed at h1: holds 1.05
    const spec = { kind: 'ratio' as const, a: 'A', b: 'B', mult: 1 };
    const built = syntheticBars(spec, a, b);
    expect(built.bars).toHaveLength(2);
    const [b0, b1] = built.bars;
    expect(b0.open).toBe(2);
    expect(b0.close).toBe(2.1 / 1.05);
    expect(b0.high).toBe(2.2 / 0.9);
    expect(b0.low).toBe(1.8 / 1.1);
    expect(b1.open).toBe(2.1 / 1.05);
    expect(b1.high).toBe(2.4 / 1.05);
    expect(b1.low).toBe(2.0 / 1.05);
    expect(b1.volume).toBe(0);
    expect(built).toMatchObject({ carriedA: 0, carriedB: 1, dropped: 0, lastA: 2.3, lastB: 1.05 });
    expect(syntheticNotice(spec, built)).toContain('B on 1 bar');
  });

  it('a spread: high = A high − m × B low, low = A low − m × B high', () => {
    const spec = { kind: 'spread' as const, a: 'A', b: 'B', mult: 2 };
    const [s] = syntheticBars(spec, [bar(0, 10, 11, 9, 10)], [bar(0, 3, 4, 2, 3)]).bars;
    expect(s).toMatchObject({ open: 4, close: 4, high: 11 - 2 * 2, low: 9 - 2 * 4 });
  });

  it('drops a ratio bar whose divisor reaches zero', () => {
    const spec = { kind: 'ratio' as const, a: 'A', b: 'B', mult: 1 };
    const built = syntheticBars(spec, [flat(0, 1)], [bar(0, 1, 1, -1, 1)]);
    expect(built.bars).toEqual([]);
    expect(built.dropped).toBe(1);
  });

  it('live: the price from both legs\' latest, seeded from their newest closes', () => {
    const t = new SyntheticTicks();
    t.reset({ kind: 'ratio', a: 'A', b: 'B', mult: 1 }, 2, 1);
    expect(t.isLeg('a')).toBe(true);
    expect(t.isLeg('C')).toBe(false);
    expect(t.price('A', 3)).toBe(3);
    expect(t.price('B', 2)).toBe(1.5);
    t.reset({ kind: 'spread', a: 'A', b: 'B', mult: 1 });
    expect(t.price('A', 3)).toBeNull();
  });

  it('compare panes: legs on the same calendar join exactly as before; on different hours, as of each bar', () => {
    const btc = [flat(0, 100), flat(1, 101), flat(2, 102), flat(3, 103)];
    const aapl = [flat(1, 10), flat(3, 11)];
    const spec: CompareSeriesSpec = { id: 'r', kind: 'ratio', symbols: ['BTC', 'AAPL'], color: '#000000' };
    const barsOf = (s: string) => (s === 'BTC' ? btc : aapl);
    // FX-style (no calendars / the same one): only shared times.
    expect(compareSeriesPoints(spec, barsOf).map((p) => p.time)).toEqual([T0 + H, T0 + 3 * H]);
    expect(compareSeriesPoints(spec, barsOf, () => 'fx').length).toBe(2);
    const cal = (s: string) => (s === 'BTC' ? '24x7' : 'nyse');
    expect(compareSeriesPoints(spec, barsOf, cal).map((p) => p.value)).toEqual([101 / 10, 102 / 10, 103 / 11]);
    const [pane] = comparePanes([spec], barsOf, () => 2, cal);
    expect(pane.note).toContain('as of each bar');
    expect(comparePanes([spec], barsOf, () => 2, () => 'fx')[0].note).toBeNull();
  });
});
