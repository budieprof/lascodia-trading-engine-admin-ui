import { describe, expect, it } from 'vitest';
import type { Bar } from '../datafeed/candle-feed.service';
import { assembleFrames, minutesNeededSince } from './technicals.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function bars(start: number, step: number, n: number, first = 1.1): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * step,
    open: first + i * 0.001,
    high: first + i * 0.001 + 0.0005,
    low: first + i * 0.001 - 0.0005,
    close: first + i * 0.001 + 0.0002,
    volume: 1,
  }));
}

// Wednesday 2026-09-30 14:20 UTC: the market is trading.
const NOW = Date.UTC(2026, 8, 30, 14, 20);
const TODAY = Date.UTC(2026, 8, 30);

/** M1 as `minuteBarsSince` returns it when asked from 13:00 (the forming H1's open). */
const fetchedFrom = (minutes: Bar[]) => ({ since: TODAY + 13 * HOUR, bars: minutes });

/** Stored history as the engine holds it at NOW: every bar CLOSED, none forming. */
function stored(): Partial<Record<string, Bar[]>> {
  return {
    '1': bars(NOW - 120 * MIN, MIN, 120),
    '5': bars(NOW - 25 * MIN - 60 * 5 * MIN, 5 * MIN, 60), // last bar 13:50, closed
    '15': bars(TODAY + 13 * HOUR + 45 * MIN - 59 * 15 * MIN, 15 * MIN, 60), // last 13:45
    '60': bars(TODAY + 13 * HOUR - 99 * HOUR, HOUR, 100), // last 13:00 — 14:00 not closed yet
    '240': bars(TODAY + 8 * HOUR - 49 * 4 * HOUR, 4 * HOUR, 50), // last 08:00
    '1D': bars(TODAY - 60 * DAY, DAY, 60), // last = yesterday
  };
}

describe('assembleFrames', () => {
  it('folds 2-hour bars from H1 and weeks / months from D1 without refetching', () => {
    const f = assembleFrames(stored(), null);
    expect(f['120'].length).toBeGreaterThan(40);
    expect(f['120'].every((b) => b.time % (2 * HOUR) === 0)).toBe(true);
    expect(f['1W'].length).toBeGreaterThan(5);
    expect(f['1M'].length).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds today's forming daily bar from closed H1 bars plus the current hour's minutes", () => {
    const fetched = stored();
    const minutes = bars(TODAY + 14 * HOUR, MIN, 20, 1.3); // 14:00–14:19
    const f = assembleFrames(fetched, fetchedFrom(minutes));
    const today = f['1D'][f['1D'].length - 1];
    expect(today.time).toBe(TODAY);
    const h1Today = fetched['60']!.filter((b) => b.time >= TODAY);
    expect(today.open).toBe(h1Today[0].open);
    expect(today.close).toBe(minutes[minutes.length - 1].close);
    // And the stored history before it is untouched.
    expect(f['1D'].slice(0, -1)).toEqual(fetched['1D']);
  });

  it('adds the forming hour from M1', () => {
    const minutes = bars(TODAY + 14 * HOUR, MIN, 20, 1.3);
    const f = assembleFrames(stored(), fetchedFrom(minutes));
    const last = f['60'][f['60'].length - 1];
    expect(last.time).toBe(TODAY + 14 * HOUR);
    expect(last.open).toBe(minutes[0].open);
  });

  it('leaves a forming bucket alone when its source does not reach back to the bucket start', () => {
    // H1 here starts on 26 Sep, so September cannot be rebuilt from it: the month stays as D1 built it.
    const fetched = stored();
    const f = assembleFrames(fetched, fetchedFrom(bars(TODAY + 14 * HOUR, MIN, 20, 1.3)));
    const fromD1 = assembleFrames(fetched, null)['1M'];
    expect(f['1M']).toEqual(fromD1);
    // Minutes that start after a tab's forming bucket opened are not folded into it either.
    // 14:10–14:19 would otherwise become an "H1 bar" opening at 14:10's price.
    const late = assembleFrames(fetched, {
      since: TODAY + 14 * HOUR + 10 * MIN,
      bars: bars(TODAY + 14 * HOUR + 10 * MIN, MIN, 10, 1.3),
    });
    expect(late['60'].at(-1)?.time).toBe(TODAY + 13 * HOUR);
  });

  it("closes a forming week at the LATEST price, not the last stored day's close", () => {
    // mergeForming() would keep the D1-built partial week's close (yesterday's) here.
    const minutes = bars(TODAY + 14 * HOUR, MIN, 20, 1.3);
    const f = assembleFrames(stored(), fetchedFrom(minutes));
    const week = f['1W'][f['1W'].length - 1];
    expect(week.close).toBe(minutes[minutes.length - 1].close);
  });
});

describe('minutesNeededSince', () => {
  it('asks only for the current hour-ish of M1 while the market trades', () => {
    const since = minutesNeededSince(stored(), NOW);
    expect(since).not.toBeNull();
    expect(NOW - since!).toBeLessThanOrEqual(2 * HOUR);
  });

  it('asks for nothing at the weekend', () => {
    const sunday = Date.UTC(2026, 9, 4, 11);
    const fridayClose = Date.UTC(2026, 9, 2, 21);
    const weekend = {
      '5': bars(fridayClose - 60 * 5 * MIN, 5 * MIN, 60),
      '60': bars(fridayClose - 100 * HOUR, HOUR, 100),
      '1D': bars(Date.UTC(2026, 9, 2) - 60 * DAY, DAY, 61),
    };
    expect(minutesNeededSince(weekend, sunday)).toBeNull();
  });
});
