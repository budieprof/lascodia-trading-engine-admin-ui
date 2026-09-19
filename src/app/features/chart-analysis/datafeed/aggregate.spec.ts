import { describe, expect, it } from 'vitest';
import type { CandleDto } from '@core/api/api.types';
import { aggregateCandles, monthStartMs, weekStartMs } from './aggregate';

function candle(iso: string, o: number, h: number, l: number, c: number, v = 1): CandleDto {
  return {
    id: 0,
    symbol: 'EURUSD',
    timeframe: 'D1',
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    timestamp: iso,
    isClosed: true,
  };
}

describe('weekStartMs', () => {
  // The engine's D1 bars include Sunday rows and no Saturdays, so the trading
  // week is Sunday→Friday. ISO weeks would put Sunday in the previous bucket.
  it('anchors the week to Sunday, not Monday', () => {
    const sunday = Date.parse('2026-09-13T00:00:00Z');
    expect(weekStartMs(Date.parse('2026-09-13T00:00:00Z'))).toBe(sunday); // Sun
    expect(weekStartMs(Date.parse('2026-09-14T00:00:00Z'))).toBe(sunday); // Mon
    expect(weekStartMs(Date.parse('2026-09-18T23:59:59Z'))).toBe(sunday); // Fri
  });

  it('starts a new week on the following Sunday', () => {
    expect(weekStartMs(Date.parse('2026-09-20T00:00:00Z'))).toBe(
      Date.parse('2026-09-20T00:00:00Z'),
    );
  });
});

describe('monthStartMs', () => {
  it('anchors to the 1st at 00:00 UTC', () => {
    expect(monthStartMs(Date.parse('2026-09-18T14:33:00Z'))).toBe(
      Date.parse('2026-09-01T00:00:00Z'),
    );
  });
});

describe('aggregateCandles', () => {
  it('passes stored resolutions through untouched', () => {
    const input = [candle('2026-09-14T00:00:00Z', 1, 2, 0.5, 1.5)];
    expect(aggregateCandles(input, '1D')).toBe(input);
  });

  it('folds a Sunday→Friday week into one bar with the Sunday open', () => {
    const week = [
      candle('2026-09-13T00:00:00Z', 1.1, 1.15, 1.05, 1.12, 10), // Sun — the open
      candle('2026-09-14T00:00:00Z', 1.12, 1.2, 1.11, 1.18, 20), // Mon
      candle('2026-09-15T00:00:00Z', 1.18, 1.25, 1.0, 1.05, 30), // Tue — the low
      candle('2026-09-18T00:00:00Z', 1.05, 1.3, 1.04, 1.28, 40), // Fri — high + close
    ];
    const [bar, ...rest] = aggregateCandles(week, '1W');
    expect(rest).toHaveLength(0);
    expect(bar.timestamp).toBe('2026-09-13T00:00:00.000Z');
    expect(bar.open).toBe(1.1);
    expect(bar.close).toBe(1.28);
    expect(bar.high).toBe(1.3);
    expect(bar.low).toBe(1.0);
    expect(bar.volume).toBe(100);
  });

  it('splits bars either side of a Sunday boundary into separate weeks', () => {
    const bars = aggregateCandles(
      [
        candle('2026-09-18T00:00:00Z', 1, 1, 1, 1), // Fri, week of Sep 13
        candle('2026-09-20T00:00:00Z', 2, 2, 2, 2), // Sun, week of Sep 20
      ],
      '1W',
    );
    expect(bars).toHaveLength(2);
    expect(bars[0].timestamp).toBe('2026-09-13T00:00:00.000Z');
    expect(bars[1].timestamp).toBe('2026-09-20T00:00:00.000Z');
  });

  it('folds M15 pairs into M30 on the :00/:30 grid', () => {
    const src: CandleDto[] = [
      { ...candle('2026-09-18T10:00:00Z', 1, 3, 1, 2, 5), timeframe: 'M15' },
      { ...candle('2026-09-18T10:15:00Z', 2, 4, 0.5, 3, 7), timeframe: 'M15' },
      { ...candle('2026-09-18T10:30:00Z', 3, 3, 3, 3, 9), timeframe: 'M15' },
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

  it('groups by calendar month across a month boundary', () => {
    const bars = aggregateCandles(
      [
        candle('2026-08-31T00:00:00Z', 1, 1, 1, 1),
        candle('2026-09-01T00:00:00Z', 2, 2, 2, 2),
        candle('2026-09-30T00:00:00Z', 3, 3, 3, 3),
      ],
      '1M',
    );
    expect(bars.map((b) => b.timestamp)).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
    expect(bars[1].open).toBe(2);
    expect(bars[1].close).toBe(3);
  });

  it('leaves the newest bucket open — a week in progress is indistinguishable', () => {
    const bars = aggregateCandles(
      [candle('2026-09-13T00:00:00Z', 1, 1, 1, 1), candle('2026-09-20T00:00:00Z', 2, 2, 2, 2)],
      '1W',
    );
    expect(bars[0].isClosed).toBe(true);
    expect(bars[bars.length - 1].isClosed).toBe(false);
  });

  it('marks a bucket unclosed when any source bar is still forming', () => {
    const bars = aggregateCandles(
      [
        { ...candle('2026-09-13T00:00:00Z', 1, 1, 1, 1), isClosed: false },
        candle('2026-09-14T00:00:00Z', 2, 2, 2, 2),
        candle('2026-09-20T00:00:00Z', 3, 3, 3, 3),
      ],
      '1W',
    );
    expect(bars[0].isClosed).toBe(false);
  });

  it('returns nothing for an unsupported resolution rather than guessing', () => {
    expect(aggregateCandles([candle('2026-09-13T00:00:00Z', 1, 1, 1, 1)], '3')).toEqual([]);
  });

  it('skips unparseable timestamps instead of emitting NaN-timed bars', () => {
    const bars = aggregateCandles(
      [candle('not-a-date', 1, 1, 1, 1), candle('2026-09-14T00:00:00Z', 2, 2, 2, 2)],
      '1W',
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].open).toBe(2);
  });
});
