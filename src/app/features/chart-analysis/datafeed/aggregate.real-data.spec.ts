import { describe, expect, it } from 'vitest';
import type { CandleDto } from '@core/api/api.types';
import { aggregateCandles } from './aggregate';

/**
 * Aggregation checked against REAL engine data.
 *
 * Synthetic candles prove the reduction arithmetic but not the thing that
 * actually goes wrong: week alignment. These are verbatim EURUSD D1 rows pulled
 * from the live `Candle` table on 2026-09-19 — note 2026-08-30, 09-06 and 09-13
 * are Sundays and there are no Saturdays, which is what makes the trading week
 * Sunday→Friday. If someone "fixes" the bucketing to ISO weeks, these break.
 */
const EURUSD_D1: ReadonlyArray<[string, number, number, number, number, number]> = [
  ['2026-08-30T00:00:00Z', 1.15763, 1.16208, 1.15763, 1.16171, 126773], // Sun
  ['2026-08-31T00:00:00Z', 1.16171, 1.16245, 1.15849, 1.15926, 124570],
  ['2026-09-01T00:00:00Z', 1.15922, 1.16093, 1.15663, 1.15885, 162360],
  ['2026-09-02T00:00:00Z', 1.15882, 1.16413, 1.15835, 1.16258, 173510],
  ['2026-09-03T00:00:00Z', 1.16255, 1.16331, 1.15849, 1.16132, 174920],
  ['2026-09-04T00:00:00Z', 1.16279, 1.16331, 1.15849, 1.16136, 130899], // Fri
  ['2026-09-06T00:00:00Z', 1.16124, 1.16358, 1.1607, 1.16228, 100057], // Sun
  ['2026-09-07T00:00:00Z', 1.16232, 1.1636, 1.16079, 1.16237, 139752],
  ['2026-09-08T00:00:00Z', 1.16242, 1.16543, 1.16201, 1.16334, 149033],
  ['2026-09-09T00:00:00Z', 1.16334, 1.16419, 1.15921, 1.16117, 158081],
  ['2026-09-10T00:00:00Z', 1.16114, 1.16175, 1.15692, 1.15983, 195012],
  ['2026-09-11T00:00:00Z', 1.16111, 1.16175, 1.15692, 1.15985, 178825], // Fri
  ['2026-09-13T00:00:00Z', 1.1595, 1.15985, 1.15231, 1.15493, 169717], // Sun
  ['2026-09-14T00:00:00Z', 1.15493, 1.15521, 1.15271, 1.15424, 166697],
  ['2026-09-15T00:00:00Z', 1.15431, 1.15566, 1.14609, 1.14639, 168245],
  ['2026-09-16T00:00:00Z', 1.14642, 1.14979, 1.1456, 1.14752, 169402],
  ['2026-09-17T00:00:00Z', 1.14684, 1.14979, 1.1456, 1.14757, 133592],
  ['2026-09-18T00:00:00Z', 1.14757, 1.14919, 1.14548, 1.14856, 135986], // Fri
];

const candles: CandleDto[] = EURUSD_D1.map(([timestamp, open, high, low, close, volume]) => ({
  id: 0,
  symbol: 'EURUSD',
  timeframe: 'D1',
  open,
  high,
  low,
  close,
  volume,
  timestamp,
  isClosed: true,
}));

describe('aggregateCandles against real EURUSD daily bars', () => {
  const weekly = aggregateCandles(candles, '1W');

  it('produces one bar per Sunday→Friday trading week', () => {
    expect(weekly.map((b) => b.timestamp)).toEqual([
      '2026-08-30T00:00:00.000Z',
      '2026-09-06T00:00:00.000Z',
      '2026-09-13T00:00:00.000Z',
    ]);
  });

  it('takes the open from Sunday and the close from Friday', () => {
    // The Sunday bar is the short open session. Bucketing by ISO week would
    // take Monday's 1.16171 as the open here and lose the weekend gap entirely.
    expect(weekly[0].open).toBeCloseTo(1.15763, 5);
    expect(weekly[0].close).toBeCloseTo(1.16136, 5);
  });

  it('spans the true weekly high and low across all six sessions', () => {
    expect(weekly[0].high).toBeCloseTo(1.16413, 5); // Wed
    expect(weekly[0].low).toBeCloseTo(1.15663, 5); // Tue
  });

  it('sums the week volume', () => {
    expect(weekly[0].volume).toBeCloseTo(893032, 0);
  });

  it('carries the sell-off week down to its real low', () => {
    // Week of Sep 13: 1.1595 open → 1.14856 close, the run that matters.
    expect(weekly[2].open).toBeCloseTo(1.1595, 5);
    expect(weekly[2].close).toBeCloseTo(1.14856, 5);
    expect(weekly[2].low).toBeCloseTo(1.14548, 5);
  });

  it('rolls the same data into one monthly bar per calendar month', () => {
    const monthly = aggregateCandles(candles, '1M');
    expect(monthly.map((b) => b.timestamp)).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
    // September opens on the 1st, not on the 30 Aug Sunday.
    expect(monthly[1].open).toBeCloseTo(1.15922, 5);
    expect(monthly[1].close).toBeCloseTo(1.14856, 5);
    expect(monthly[1].high).toBeCloseTo(1.16543, 5);
    expect(monthly[1].low).toBeCloseTo(1.14548, 5);
  });
});
