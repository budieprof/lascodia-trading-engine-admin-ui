import { describe, expect, it } from 'vitest';
import { TradingCalendar } from '../datafeed/session-calendar';
import { aheadTimes } from './ahead-times';

const fx = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });
const H = 3_600_000;

describe('aheadTimes', () => {
  it('steps one bar width at a time inside a session', () => {
    const last = Date.parse('2026-09-23T10:00:00Z'); // a Wednesday
    expect(aheadTimes({ time: last }, H, 3, fx)).toEqual([last + H, last + 2 * H, last + 3 * H]);
  });

  it("jumps a shut market: the bar after Friday's 17:00 New York close opens Sunday 17:00 New York", () => {
    // Friday 2026-09-25 16:00 New York (EDT) = 20:00 UTC is the last H1 bar of the week.
    const last = Date.parse('2026-09-25T20:00:00Z');
    const [first, second] = aheadTimes({ time: last }, H, 2, fx);
    expect(new Date(first).toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(second - first).toBe(H);
  });

  it("starts at the session grid's own close when the bar carries it", () => {
    const open = Date.parse('2026-09-23T21:00:00Z');
    const close = Date.parse('2026-09-24T21:00:00Z');
    const times = aheadTimes({ time: open, closeTime: close }, 24 * H, 3, fx);
    // Thursday's close opens Friday's session; Friday's close jumps the weekend to Sunday 17:00 New York.
    expect(times[0]).toBe(close);
    expect(new Date(times[1]).toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(times[2] - times[1]).toBe(24 * H);
  });

  it('counts every hour without a calendar (a market that never closes)', () => {
    const last = Date.parse('2026-09-25T20:00:00Z');
    expect(aheadTimes({ time: last }, H, 2, null)).toEqual([last + H, last + 2 * H]);
  });

  it('steps months on the calendar', () => {
    const last = Date.UTC(2026, 0, 1);
    const times = aheadTimes({ time: last }, 30 * 24 * H, 3, fx);
    expect(times.map((t) => new Date(t).getUTCMonth())).toEqual([1, 2, 3]);
  });
});
