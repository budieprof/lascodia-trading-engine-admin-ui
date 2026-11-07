import { describe, expect, it } from 'vitest';
import { applyStoredTick, bucketStartFor, EPOCH_GRID, foldBars, type BarGrid } from './aggregate';
import { TradingCalendar } from './session-calendar';
import { liveTick } from './live-tick';

/**
 * UD02: a venue stock's stored bars are built on its exchange calendar (engine `InstrumentCandleAggregator`: intraday
 * bars from each regular session's open), so its 1h bars open at 09:30 New York — the client buckets its forming bar
 * and live price there too, instead of on the UTC hour (two overlapping bars an hour). FX stays on the epoch grid.
 */
const at = (iso: string) => Date.parse(iso);
const NYSE: BarGrid = {
  kind: 'session',
  calendar: new TradingCalendar({ session: '0930-1600:23456', timeZone: 'America/New_York' }),
};
const bar = (iso: string, p: number, v = 1) => ({
  time: at(iso),
  open: p,
  high: p,
  low: p,
  close: p,
  volume: v,
});

describe('BarGrid — a venue stock on the NYSE calendar', () => {
  it('buckets 1h from 09:30 New York, the last bar cut at 16:00; nothing outside the session', () => {
    // Tuesday 6 Oct 2026 (EDT): 09:30 = 13:30 UTC.
    expect(bucketStartFor('60', at('2026-10-06T14:10:00Z'), NYSE)).toBe(at('2026-10-06T13:30:00Z'));
    expect(bucketStartFor('60', at('2026-10-06T14:30:00Z'), NYSE)).toBe(at('2026-10-06T14:30:00Z'));
    expect(bucketStartFor('60', at('2026-10-06T19:45:00Z'), NYSE)).toBe(at('2026-10-06T19:30:00Z'));
    expect(bucketStartFor('60', at('2026-10-06T12:00:00Z'), NYSE)).toBeNull();
    expect(bucketStartFor('60', at('2026-10-06T20:00:00Z'), NYSE)).toBeNull();
    // The same instant on the epoch grid (FX, MT5 CFDs): the UTC hour.
    expect(bucketStartFor('60', at('2026-10-06T14:10:00Z'), EPOCH_GRID)).toBe(
      at('2026-10-06T14:00:00Z'),
    );
    // Winter (EST): 09:30 = 14:30 UTC, still on the half hour.
    expect(bucketStartFor('60', at('2026-12-01T15:00:00Z'), NYSE)).toBe(at('2026-12-01T14:30:00Z'));
  });

  it('folds the forming 1h bar from M1 on the session grid — no bar overlapping the stored 13:30 one', () => {
    const minutes = [
      bar('2026-10-06T14:28:00Z', 10),
      bar('2026-10-06T14:29:00Z', 11),
      bar('2026-10-06T14:30:00Z', 12),
      bar('2026-10-06T14:31:00Z', 13),
    ];
    expect(foldBars(minutes, '60', NYSE).map((b) => [b.time, b.open, b.close])).toEqual([
      [at('2026-10-06T13:30:00Z'), 10, 11],
      [at('2026-10-06T14:30:00Z'), 12, 13],
    ]);
  });

  it('a live price moves the 13:30 bar until 14:30 and opens the 14:30 bar there', () => {
    const bars = [bar('2026-10-06T13:30:00Z', 10)];
    expect(applyStoredTick(bars, 11, at('2026-10-06T14:20:00Z'), '60', NYSE)).toHaveLength(1);
    const opened = applyStoredTick(bars, 12, at('2026-10-06T14:30:01Z'), '60', NYSE);
    expect(opened?.[1].time).toBe(at('2026-10-06T14:30:00Z'));
    // After the close a stray print opens nothing.
    expect(applyStoredTick(bars, 12, at('2026-10-06T21:00:00Z'), '60', NYSE)).toBeNull();
    expect(liveTick(bars, 12, at('2026-10-06T14:30:01Z'), '60', null, NYSE)?.[1].time).toBe(
      at('2026-10-06T14:30:00Z'),
    );
  });
});
