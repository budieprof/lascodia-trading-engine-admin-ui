import { describe, expect, it } from 'vitest';
import { applyStoredTick, bucketStartFor, foldBars } from './aggregate';
import { TradingCalendar, nextSessionPeriod, tradingMsBetween } from './session-calendar';
import { liveTick } from './live-tick';

/**
 * FX golden (multi-asset chart program, ui-datafeed): what EURUSD's chart does today, pinned BEFORE the datafeed
 * learns sessions, venue grids and venue prices. Every later change to `datafeed/` must leave these green: FX bars are
 * on the UTC epoch grid up to an hour, on the 17:00 New York session above it, and a live price moves them the same way.
 */
const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });
const bar = (iso: string, o: number, h: number, l: number, c: number, v = 1) => ({
  time: at(iso),
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe('FX golden — EURUSD stored grid (1m … 1h)', () => {
  it('buckets 1m / 5m / 15m / 30m / 1h on the UTC epoch grid', () => {
    const t = at('2026-10-06T13:37:42.250Z');
    expect(bucketStartFor('1', t)).toBe(at('2026-10-06T13:37:00Z'));
    expect(bucketStartFor('5', t)).toBe(at('2026-10-06T13:35:00Z'));
    expect(bucketStartFor('15', t)).toBe(at('2026-10-06T13:30:00Z'));
    expect(bucketStartFor('30', t)).toBe(at('2026-10-06T13:30:00Z'));
    expect(bucketStartFor('60', t)).toBe(at('2026-10-06T13:00:00Z'));
    // Winter (EST) changes nothing on the epoch grid.
    expect(bucketStartFor('60', at('2026-12-01T22:59:59Z'))).toBe(at('2026-12-01T22:00:00Z'));
    // 4h and 1D are the engine's session grid: never bucketed here.
    expect(bucketStartFor('240', t)).toBeNull();
    expect(bucketStartFor('1D', t)).toBeNull();
  });

  it('folds the forming 1h bar from M1 with the true open, extremes and summed volume', () => {
    const minutes = [
      bar('2026-10-06T13:00:00Z', 1.1, 1.102, 1.099, 1.101, 3),
      bar('2026-10-06T13:01:00Z', 1.101, 1.105, 1.1, 1.104, 4),
      bar('2026-10-06T14:00:00Z', 1.104, 1.106, 1.103, 1.105, 2),
    ];
    expect(foldBars(minutes, '60')).toEqual([
      {
        time: at('2026-10-06T13:00:00Z'),
        open: 1.1,
        high: 1.105,
        low: 1.099,
        close: 1.104,
        volume: 7,
      },
      {
        time: at('2026-10-06T14:00:00Z'),
        open: 1.104,
        high: 1.106,
        low: 1.103,
        close: 1.105,
        volume: 2,
      },
    ]);
  });

  it('a live price moves the 1h bar until 14:00 and opens the next one at 14:00 sharp', () => {
    const bars = [bar('2026-10-06T13:00:00Z', 1.1, 1.102, 1.099, 1.101)];
    expect(applyStoredTick(bars, 1.103, at('2026-10-06T13:59:59.900Z'), '60')).toEqual([
      { ...bars[0], high: 1.103, close: 1.103 },
    ]);
    expect(applyStoredTick(bars, 1.104, at('2026-10-06T14:00:00Z'), '60')).toEqual([
      bars[0],
      {
        time: at('2026-10-06T14:00:00Z'),
        open: 1.104,
        high: 1.104,
        low: 1.104,
        close: 1.104,
        volume: 0,
      },
    ]);
    // A 1m chart the same way.
    const m = [bar('2026-10-06T13:37:00Z', 1.1, 1.1, 1.1, 1.1)];
    expect(applyStoredTick(m, 1.2, at('2026-10-06T13:38:00Z'), '1')?.[1].time).toBe(
      at('2026-10-06T13:38:00Z'),
    );
  });
});

describe('FX golden — EURUSD session grid (4h, 1D)', () => {
  const block = (iso: string, hours: number) => ({
    ...bar(iso, 1.1, 1.1, 1.1, 1.1),
    closeTime: at(iso) + hours * H,
  });

  it('4h blocks from 17:00 New York; the week ends Friday 17:00 and reopens Sunday 17:00', () => {
    expect(
      nextSessionPeriod(FX, '240', block('2026-10-06T09:00:00Z', 4), at('2026-10-06T13:00:05Z')),
    ).toEqual({
      time: at('2026-10-06T13:00:00Z'),
      closeTime: at('2026-10-06T17:00:00Z'),
    });
    expect(
      nextSessionPeriod(FX, '240', block('2026-10-06T17:00:00Z', 4), at('2026-10-06T21:00:05Z')),
    ).toEqual({
      time: at('2026-10-06T21:00:00Z'),
      closeTime: at('2026-10-07T01:00:00Z'),
    });
    expect(
      nextSessionPeriod(FX, '240', block('2026-10-09T17:00:00Z', 4), at('2026-10-10T12:00:00Z')),
    ).toBeNull();
    // Winter: 22:00 UTC.
    expect(
      nextSessionPeriod(FX, '240', block('2026-12-01T18:00:00Z', 4), at('2026-12-01T22:00:05Z')),
    ).toEqual({
      time: at('2026-12-01T22:00:00Z'),
      closeTime: at('2026-12-02T02:00:00Z'),
    });
  });

  it('1D: Tuesday’s bar is 21:00 → 21:00 UTC in summer, Monday’s opens on Sunday evening', () => {
    expect(
      nextSessionPeriod(FX, '1D', block('2026-10-05T21:00:00Z', 24), at('2026-10-06T21:00:01Z')),
    ).toEqual({
      time: at('2026-10-06T21:00:00Z'),
      closeTime: at('2026-10-07T21:00:00Z'),
    });
    expect(
      nextSessionPeriod(FX, '1D', block('2026-10-08T21:00:00Z', 24), at('2026-10-11T21:00:30Z')),
    ).toEqual({
      time: at('2026-10-11T21:00:00Z'),
      closeTime: at('2026-10-12T21:00:00Z'),
    });
  });

  it('trading days, the weekend and trading time are unchanged', () => {
    expect(FX.sessionAt(at('2026-10-07T03:00:00Z'))).toEqual({
      day: at('2026-10-07T00:00:00Z'),
      start: at('2026-10-06T21:00:00Z'),
      end: at('2026-10-07T21:00:00Z'),
    });
    expect(FX.isTradingDay(at('2026-10-10T00:00:00Z'))).toBe(false);
    expect(FX.isTradingDay(at('2026-10-12T00:00:00Z'))).toBe(true);
    expect(tradingMsBetween(FX, at('2026-10-09T21:00:00Z'), at('2026-10-12T12:30:00Z'))).toBe(
      15.5 * H,
    );
  });

  it('a split panel’s live price follows the same rules (liveTick)', () => {
    const bars = [block('2026-10-06T09:00:00Z', 4)];
    expect(liveTick(bars, 1.2, at('2026-10-06T12:00:00Z'), '240', FX)?.[0].close).toBe(1.2);
    expect(liveTick(bars, 1.2, at('2026-10-06T13:00:05Z'), '240', FX)?.[1]).toMatchObject({
      time: at('2026-10-06T13:00:00Z'),
      closeTime: at('2026-10-06T17:00:00Z'),
    });
    const stored = [bar('2026-10-06T13:00:00Z', 1.1, 1.1, 1.1, 1.1)];
    expect(liveTick(stored, 1.2, at('2026-10-06T14:00:00Z'), '60', FX)?.[1].time).toBe(
      at('2026-10-06T14:00:00Z'),
    );
  });
});
