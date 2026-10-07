import { describe, expect, it } from 'vitest';
import type { CandleDto } from '@core/api/api.types';
import { aggregateCandles, bucketStartFor, foldBars } from './aggregate';

function candle(iso: string, o: number, h: number, l: number, c: number, v = 1): CandleDto {
  return {
    id: 0,
    symbol: 'EURUSD',
    timeframe: 'M15',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    timestamp: iso,
    isClosed: true,
  };
}

describe('bucketStartFor', () => {
  it('floors to the UTC epoch grid on the stored resolutions', () => {
    const t = Date.parse('2026-09-18T10:47:12Z');
    expect(bucketStartFor('1', t)).toBe(Date.parse('2026-09-18T10:47:00Z'));
    expect(bucketStartFor('30', t)).toBe(Date.parse('2026-09-18T10:30:00Z'));
    expect(bucketStartFor('60', t)).toBe(Date.parse('2026-09-18T10:00:00Z'));
  });

  it('has no bucket on the session grid — the engine lays those periods out, not the client', () => {
    // 4h opens 21/01/05… UTC in summer and 22/02/06… in winter; a day rolls at 17:00 New York.
    // Flooring to the epoch would put every one of them on the wrong grid.
    const t = Date.parse('2026-09-18T10:47:12Z');
    for (const r of ['120', '240', '1D', '1W', '1M']) expect(bucketStartFor(r, t), r).toBeNull();
  });
});

describe('aggregateCandles', () => {
  it('passes stored resolutions through untouched', () => {
    const input = [candle('2026-09-14T10:00:00Z', 1, 2, 0.5, 1.5)];
    expect(aggregateCandles(input, '15')).toBe(input);
  });

  it('folds M15 pairs into M30 on the :00/:30 grid', () => {
    const src: CandleDto[] = [
      candle('2026-09-18T10:00:00Z', 1, 3, 1, 2, 5),
      candle('2026-09-18T10:15:00Z', 2, 4, 0.5, 3, 7),
      candle('2026-09-18T10:30:00Z', 3, 3, 3, 3, 9),
    ];
    const bars = aggregateCandles(src, '30');
    expect(bars).toHaveLength(2);
    expect(bars[0].timestamp).toBe('2026-09-18T10:00:00.000Z');
    expect(bars[0].open).toBe(1);
    expect(bars[0].close).toBe(3);
    expect(bars[0].high).toBe(4);
    expect(bars[0].low).toBe(0.5);
    expect(bars[0].volume).toBe(12);
    expect(bars[1].timestamp).toBe('2026-09-18T10:30:00.000Z');
  });

  it('leaves the newest bucket open — a bucket in progress is indistinguishable', () => {
    const bars = aggregateCandles(
      [candle('2026-09-18T10:00:00Z', 1, 1, 1, 1), candle('2026-09-18T10:30:00Z', 2, 2, 2, 2)],
      '30',
    );
    expect(bars[0].isClosed).toBe(true);
    expect(bars[bars.length - 1].isClosed).toBe(false);
  });

  it('marks a bucket unclosed when any source bar is still forming', () => {
    const bars = aggregateCandles(
      [
        { ...candle('2026-09-18T10:00:00Z', 1, 1, 1, 1), isClosed: false },
        candle('2026-09-18T10:15:00Z', 2, 2, 2, 2),
        candle('2026-09-18T10:30:00Z', 3, 3, 3, 3),
      ],
      '30',
    );
    expect(bars[0].isClosed).toBe(false);
  });

  it('returns nothing for an unsupported resolution rather than guessing', () => {
    expect(aggregateCandles([candle('2026-09-13T00:00:00Z', 1, 1, 1, 1)], '3')).toEqual([]);
  });

  it('builds nothing for the session grid, which the engine serves already built', () => {
    expect(aggregateCandles([candle('2026-09-13T00:00:00Z', 1, 1, 1, 1)], '1W')).toEqual([]);
    expect(foldBars([{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }], '240')).toEqual(
      [],
    );
  });

  it('skips unparseable timestamps instead of emitting NaN-timed bars', () => {
    const bars = aggregateCandles(
      [candle('not-a-date', 1, 1, 1, 1), candle('2026-09-14T10:15:00Z', 2, 2, 2, 2)],
      '30',
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].open).toBe(2);
  });
});
