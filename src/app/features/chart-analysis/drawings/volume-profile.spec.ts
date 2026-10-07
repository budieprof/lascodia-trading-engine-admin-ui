import { describe, expect, it } from 'vitest';
import { volumeProfileSpan } from './advanced-painters';

/**
 * Regression guard for a bug that shipped and survived a browser check.
 *
 * The anchored profile asked `coordinateToTime(paneWidth)` for its upper
 * bound. Lightweight Charts returns null for any coordinate past the last bar,
 * and the pane always keeps a right-hand margin, so that call reliably returned
 * null and the painter bailed before drawing. The tool created its object and
 * drew its anchor line, so BOTH the object count and a canvas pixel-diff said
 * it had worked — it just never drew a histogram.
 */
describe('volumeProfileSpan', () => {
  // The real failure: the right edge has no time because it is past the data.
  const timeAt = (x: number): number | null => (x > 1000 ? null : 1_700_000_000_000 + x * 60_000);

  it('anchored: survives a right edge that has no time', () => {
    const span = volumeProfileSpan('anchored', 200, undefined, timeAt);
    expect(span, 'anchored profile produced no span — it would draw nothing').not.toBeNull();
    expect(span!.t0).toBe(timeAt(200));
    // Unbounded: the profile runs to the newest bar, whatever that is.
    expect(span!.t1).toBe(Infinity);
  });

  it('anchored: still fails closed when the ANCHOR itself is off-data', () => {
    expect(volumeProfileSpan('anchored', 1200, undefined, timeAt)).toBeNull();
  });

  it('fixed: spans the two clicks, in either drag direction', () => {
    const a = volumeProfileSpan('fixed', 200, 600, timeAt);
    const b = volumeProfileSpan('fixed', 600, 200, timeAt);
    expect(a).toEqual(b);
    expect(a!.t0).toBe(timeAt(200));
    expect(a!.t1).toBe(timeAt(600));
  });

  it('fixed: fails closed when either click is off-data', () => {
    expect(volumeProfileSpan('fixed', 200, 1200, timeAt)).toBeNull();
    expect(volumeProfileSpan('fixed', 1200, 200, timeAt)).toBeNull();
  });

  it('fixed: a single click collapses to a zero-width span, not a crash', () => {
    const span = volumeProfileSpan('fixed', 300, undefined, timeAt);
    expect(span!.t0).toBe(span!.t1);
  });
});

import { volumeProfile } from '../indicators/math';
import { periodProfiles, periodStart } from '../overlays/analysis-overlays';
import { TradingCalendar } from '../datafeed/session-calendar';

describe('volume profile up/down split', () => {
  it('attributes each bar to up or down by its own direction, and they sum to volume', () => {
    const bins = volumeProfile(
      [
        { time: 0, open: 1, high: 2, low: 1, close: 2, volume: 100 },
        { time: 1, open: 2, high: 2, low: 1, close: 1, volume: 40 },
      ],
      4,
    );
    const up = bins.reduce((a, b) => a + b.up, 0);
    const down = bins.reduce((a, b) => a + b.down, 0);
    expect(up).toBeCloseTo(100);
    expect(down).toBeCloseTo(40);
    for (const b of bins) expect(b.up + b.down).toBeCloseTo(b.volume);
  });
});

describe('periodProfiles', () => {
  const H = 3_600_000;
  // Mon 2026-09-28 00:00 UTC, 48 hourly bars → two sessions, one week.
  const t0 = Date.UTC(2026, 8, 28);
  const bars = Array.from({ length: 48 }, (_, i) => ({
    time: t0 + i * H,
    open: 1 + i * 0.001,
    high: 1.002 + i * 0.001,
    low: 0.999 + i * 0.001,
    close: 1.001 + i * 0.001,
    volume: 10,
  }));

  it('session: one profile per UTC day, bounded by that day', () => {
    const ps = periodProfiles(bars, 'session');
    expect(ps).toHaveLength(2);
    expect(ps[0].t0).toBe(t0);
    expect(ps[0].t1).toBe(t0 + 23 * H);
    expect(ps[1].t0).toBe(t0 + 24 * H);
  });

  it('week: both days fall in one profile', () => {
    expect(periodProfiles(bars, 'week')).toHaveLength(1);
  });

  it('week starts Monday; Sunday folds into the following week', () => {
    const sunday = Date.UTC(2026, 8, 27, 22);
    expect(periodStart(sunday, 'week')).toBe(t0);
    expect(periodStart(t0 + 5 * 24 * H, 'week')).toBe(t0);
  });
});

describe('periodProfiles on the symbol’s trading sessions', () => {
  const H = 3_600_000;
  const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });
  const hourly = (startMs: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      time: startMs + i * H,
      open: 1,
      high: 1.002,
      low: 0.999,
      close: 1.001,
      volume: 10,
    }));

  it('session: one profile per 17:00-New-York session — 21:00 UTC in summer, 22:00 in winter', () => {
    const summer = periodProfiles(hourly(Date.UTC(2026, 9, 6, 15), 12), 'session', {
      dayOf: FX.dayOf,
    });
    expect(summer.map((p) => p.t0)).toEqual([Date.UTC(2026, 9, 6, 15), Date.UTC(2026, 9, 6, 21)]);
    const winter = periodProfiles(hourly(Date.UTC(2026, 11, 1, 16), 12), 'session', {
      dayOf: FX.dayOf,
    });
    expect(winter.map((p) => p.t0)).toEqual([Date.UTC(2026, 11, 1, 16), Date.UTC(2026, 11, 1, 22)]);
  });

  it('week: Sunday evening’s session opens Monday’s week; month: 30 September’s opens October', () => {
    const sunday = hourly(Date.UTC(2026, 9, 11, 17), 8); // 17:00 … 00:00 UTC
    expect(periodProfiles(sunday, 'week', { dayOf: FX.dayOf }).map((p) => p.t0)).toEqual([
      Date.UTC(2026, 9, 11, 17),
      Date.UTC(2026, 9, 11, 21),
    ]);
    expect(periodStart(Date.UTC(2026, 8, 30, 21), 'month', FX.dayOf)).not.toBe(
      periodStart(Date.UTC(2026, 8, 30, 20), 'month', FX.dayOf),
    );
  });

  it('without a session, UTC days as before', () => {
    const ps = periodProfiles(hourly(Date.UTC(2026, 9, 6, 15), 12), 'session');
    expect(ps.map((p) => p.t0)).toEqual([Date.UTC(2026, 9, 6, 15), Date.UTC(2026, 9, 7, 0)]);
  });
});
