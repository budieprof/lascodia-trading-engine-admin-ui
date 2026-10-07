import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { CandleFeedService, type Bar, type SessionBar } from '../datafeed/candle-feed.service';
import {
  SESSION_FETCHES,
  TechnicalsService,
  assembleFrames,
  minutesNeededSince,
} from './technicals.service';
import { pivotInputs, pivotPeriodBars } from './pivots';

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

/** Session-grid bars as the engine sends them: each with its close. */
function periods(start: number, step: number, n: number, first = 1.1): Bar[] {
  return bars(start, step, n, first).map((b) => ({ ...b, closeTime: b.time + step }));
}

// Wednesday 2026-09-30 14:20 UTC: the market is trading (New York on EDT: sessions roll at 21:00 UTC).
const NOW = Date.UTC(2026, 8, 30, 14, 20);
const TODAY = Date.UTC(2026, 8, 30);
/** Wednesday 30 Sep's session opened on Tuesday at 21:00 UTC. */
const SESSION_OPEN = Date.UTC(2026, 8, 29, 21);

/** M1 as `minuteBarsSince` returns it when asked from 13:00 (the forming H1's open). */
const fetchedFrom = (minutes: Bar[]) => ({ since: TODAY + 13 * HOUR, bars: minutes });

/** Stored history as the engine holds it at NOW (every bar CLOSED), and the session grid's bars. */
function fetched(): Partial<Record<string, Bar[]>> {
  return {
    '1': bars(NOW - 120 * MIN, MIN, 120),
    '5': bars(NOW - 25 * MIN - 60 * 5 * MIN, 5 * MIN, 60), // last bar 13:50, closed
    '15': bars(TODAY + 13 * HOUR + 45 * MIN - 59 * 15 * MIN, 15 * MIN, 60), // last 13:45
    '60': bars(TODAY + 13 * HOUR - 99 * HOUR, HOUR, 100), // last 13:00 — 14:00 not closed yet
    // The engine's 13:00–15:00 UTC 2h block and 13:00–17:00 4h block are forming.
    '120': periods(TODAY + 13 * HOUR - 79 * 2 * HOUR, 2 * HOUR, 80),
    '240': periods(TODAY + 13 * HOUR - 59 * 4 * HOUR, 4 * HOUR, 60),
    '1D': periods(SESSION_OPEN - 59 * DAY, DAY, 60), // the forming session last
    '1W': periods(Date.UTC(2026, 8, 27, 21) - 29 * 7 * DAY, 7 * DAY, 30),
    '1M': periods(Date.UTC(2026, 7, 31, 21) - 23 * 30 * DAY, 30 * DAY, 24),
  };
}

describe('assembleFrames', () => {
  it('folds 30m from M15, and passes the session-grid tabs through as the engine built them', () => {
    const f = fetched();
    const out = assembleFrames(f, null);
    expect(out['30'].length).toBeGreaterThan(25);
    expect(out['30'].every((b) => b.time % (30 * MIN) === 0)).toBe(true);
    for (const r of ['120', '240', '1D', '1W', '1M']) expect(out[r], r).toBe(f[r]);
    // The daily tab ends on the session forming now — opened yesterday 21:00 UTC, not at midnight.
    expect(out['1D'].at(-1)).toMatchObject({ time: SESSION_OPEN, closeTime: SESSION_OPEN + DAY });
  });

  it('adds the forming hour from M1', () => {
    const minutes = bars(TODAY + 14 * HOUR, MIN, 20, 1.3);
    const f = assembleFrames(fetched(), fetchedFrom(minutes));
    const last = f['60'][f['60'].length - 1];
    expect(last.time).toBe(TODAY + 14 * HOUR);
    expect(last.open).toBe(minutes[0].open);
  });

  it('never folds M1 into a session-grid tab: its forming bar is the engine’s', () => {
    const f = fetched();
    const out = assembleFrames(f, fetchedFrom(bars(TODAY + 14 * HOUR, MIN, 20, 1.3)));
    for (const r of ['120', '240', '1D', '1W', '1M']) expect(out[r], r).toEqual(f[r]);
  });

  it('does not fold minutes that start after a tab’s forming bucket opened', () => {
    // 14:10–14:19 would otherwise become an "H1 bar" opening at 14:10's price.
    const late = assembleFrames(fetched(), {
      since: TODAY + 14 * HOUR + 10 * MIN,
      bars: bars(TODAY + 14 * HOUR + 10 * MIN, MIN, 10, 1.3),
    });
    expect(late['60'].at(-1)?.time).toBe(TODAY + 13 * HOUR);
  });
});

describe('minutesNeededSince', () => {
  it('asks only for the current hour-ish of M1 while the market trades', () => {
    const since = minutesNeededSince(fetched(), NOW);
    expect(since).not.toBeNull();
    expect(NOW - since!).toBeLessThanOrEqual(2 * HOUR);
  });

  it('asks for nothing at the weekend', () => {
    const sunday = Date.UTC(2026, 9, 4, 11);
    const fridayClose = Date.UTC(2026, 9, 2, 21);
    const weekend = {
      '5': bars(fridayClose - 60 * 5 * MIN, 5 * MIN, 60),
      '60': bars(fridayClose - 100 * HOUR, HOUR, 100),
      '1D': periods(Date.UTC(2026, 9, 1, 21) - 60 * DAY, DAY, 61),
    };
    expect(minutesNeededSince(weekend, sunday)).toBeNull();
  });
});

describe('TechnicalsService — where each tab’s bars come from', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    const data = fetched();
    const feed = {
      getBars: vi.fn(async (_s: string, r: string, _f: number, _t: number, count: number) => ({
        bars: (data[r] ?? []).slice(-count),
        noData: false,
      })),
      sessionTail: vi.fn(
        async (_s: string, r: string, since: number): Promise<SessionBar[] | null> =>
          (data[r] ?? [])
            .filter((b) => b.time >= since)
            .map((b) => ({ ...b, close: b.close + 0.01, forming: true })),
      ),
      minuteBarsSince: vi.fn(async () => [] as Bar[]),
    };
    const injector = Injector.create({
      providers: [
        { provide: CandleFeedService, useValue: feed },
        { provide: TechnicalsService, useClass: TechnicalsService },
      ],
    });
    const svc = runInInjectionContext(injector, () => injector.get(TechnicalsService));
    return { svc, feed, data };
  }

  it('asks the session grid for 2h, 4h, 1D, 1W and 1M, and takes the pivots’ periods from them', async () => {
    const { svc, feed, data } = make();
    const t = await svc.load('EURUSD');
    const asked = feed.getBars.mock.calls.map((c) => [c[1], c[4]]);
    for (const f of SESSION_FETCHES) expect(asked).toContainEqual([f.resolution, f.count]);
    // 30m is folded from M15, never fetched.
    expect(asked.map((a) => a[0])).not.toContain('30');
    expect(t.daily).toEqual(data['1D']);
    expect(t.weekly).toEqual(data['1W']);
    expect(t.monthly).toEqual(data['1M']);
    expect(t.frames['1D'].lastTime).toBe(SESSION_OPEN);
    expect(t.frames['240'].lastTime).toBe(TODAY + 13 * HOUR);
    // Daily pivots for the 15m tab: yesterday's session, the engine's 17:00 New York day.
    const r = pivotInputs(pivotPeriodBars('day', t), t.frames['15'].lastTime!);
    expect(r?.prev.start).toBe(SESSION_OPEN - DAY);
    expect(r?.currentOpen).toBe(data['1D']!.at(-1)!.open);
  });

  it('refreshes the session tabs from their newest bars alone, then whole again after 15 minutes', async () => {
    const { svc, feed, data } = make();
    await svc.load('EURUSD');
    feed.getBars.mockClear();

    vi.setSystemTime(NOW + 60_000);
    const t = await svc.load('EURUSD');
    const sessionTabs = SESSION_FETCHES.map((f) => f.resolution);
    expect(feed.getBars.mock.calls.map((c) => c[1]).filter((r) => sessionTabs.includes(r))).toEqual(
      [],
    );
    expect(feed.sessionTail.mock.calls.map((c) => [c[1], c[2]])).toContainEqual([
      '1D',
      SESSION_OPEN,
    ]);
    // The newest session's re-read close, over the history held.
    expect(t.daily.length).toBe(data['1D']!.length);
    expect(t.daily.at(-1)?.close).toBeCloseTo(data['1D']!.at(-1)!.close + 0.01, 10);
    expect(t.daily.at(-2)).toEqual(data['1D']!.at(-2));

    feed.getBars.mockClear();
    vi.setSystemTime(NOW + 16 * 60_000);
    await svc.load('EURUSD');
    expect(feed.getBars.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(sessionTabs));
  });

  it('falls back to the whole history when the newest bars do not come', async () => {
    const { svc, feed } = make();
    await svc.load('EURUSD');
    feed.getBars.mockClear();
    feed.sessionTail.mockResolvedValue(null);
    vi.setSystemTime(NOW + 60_000);
    await svc.load('EURUSD');
    expect(feed.getBars.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(SESSION_FETCHES.map((f) => f.resolution)),
    );
  });
});
