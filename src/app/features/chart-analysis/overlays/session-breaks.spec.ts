import { describe, expect, it } from 'vitest';
import { TradingCalendar } from '../datafeed/session-calendar';
import { sessionBreakIndexes, utcDay } from './session-breaks';

const H = 3_600_000;
const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });

describe('session breaks (CC-I9)', () => {
  // Hourly bars from Tue 18:00 to Wed 23:00 UTC (EDT: the day rolls at 21:00 UTC).
  const start = Date.parse('2026-10-06T18:00:00Z');
  const hours = Array.from({ length: 30 }, (_, i) => start + i * H);

  it('breaks where the FX day rolls — 17:00 New York, 21:00 UTC in summer', () => {
    const breaks = sessionBreakIndexes(hours, FX.dayOf);
    expect(breaks.map((i) => new Date(hours[i]).toISOString())).toEqual([
      '2026-10-06T21:00:00.000Z',
      '2026-10-07T21:00:00.000Z',
    ]);
  });

  it('breaks at UTC midnight when the session is unknown', () => {
    const breaks = sessionBreakIndexes(hours, utcDay);
    expect(breaks.map((i) => new Date(hours[i]).toISOString())).toEqual([
      '2026-10-07T00:00:00.000Z',
    ]);
  });

  it('has nothing to break on one bar or none', () => {
    expect(sessionBreakIndexes([start], utcDay)).toEqual([]);
    expect(sessionBreakIndexes([], utcDay)).toEqual([]);
  });
});
