import { describe, expect, it } from 'vitest';
import { TradingCalendar, nextSessionPeriod, tradingMsBetween } from './session-calendar';
import { tradingDayMs } from './session-bars';

/**
 * The trading days of the engine's two sessions: FX (`1700-1700:23456` in America/New_York — days
 * roll at 17:00 New York, 21:00 UTC on EDT and 22:00 UTC on EST, Monday to Friday) and crypto
 * (`0000-0000:1234567` in Etc/UTC — the UTC day).
 */
const at = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });
const UTC = new TradingCalendar({ session: '0000-0000:1234567', timeZone: 'Etc/UTC' });

describe('TradingCalendar — FX, 17:00 New York', () => {
  it('rolls the day at 21:00 UTC in summer (EDT)', () => {
    expect(FX.dayOf(at('2026-10-06T20:59:59Z'))).toBe(at('2026-10-06T00:00:00Z'));
    expect(FX.dayOf(at('2026-10-06T21:00:00Z'))).toBe(at('2026-10-07T00:00:00Z'));
    // Midnight UTC is the middle of a session, not a new day.
    expect(FX.dayOf(at('2026-10-07T00:00:00Z'))).toBe(at('2026-10-07T00:00:00Z'));
    expect(FX.sessionAt(at('2026-10-07T03:00:00Z'))).toEqual({
      day: at('2026-10-07T00:00:00Z'),
      start: at('2026-10-06T21:00:00Z'),
      end: at('2026-10-07T21:00:00Z'),
    });
  });

  it('rolls the day at 22:00 UTC in winter (EST)', () => {
    expect(FX.dayOf(at('2026-12-01T21:59:00Z'))).toBe(at('2026-12-01T00:00:00Z'));
    expect(FX.dayOf(at('2026-12-01T22:00:00Z'))).toBe(at('2026-12-02T00:00:00Z'));
    expect(FX.sessionAt(at('2026-12-02T10:00:00Z')).start).toBe(at('2026-12-01T22:00:00Z'));
  });

  it('opens the week on Sunday at 17:00 New York, as Monday’s session — across the clock change', () => {
    // EDT: Sunday 4 Oct 21:00 UTC trades Monday 5 Oct.
    expect(FX.dayOf(at('2026-10-04T21:00:00Z'))).toBe(at('2026-10-05T00:00:00Z'));
    // New York leaves EDT on Sunday 1 Nov 2026 at 02:00: that evening's session opens 22:00 UTC.
    const monday = FX.sessionAt(at('2026-11-01T22:30:00Z'));
    expect(monday).toEqual({
      day: at('2026-11-02T00:00:00Z'),
      start: at('2026-11-01T22:00:00Z'),
      end: at('2026-11-02T22:00:00Z'),
    });
    // The hour before it is the Sunday that does not trade.
    expect(FX.dayOf(at('2026-11-01T21:30:00Z'))).toBe(at('2026-11-01T00:00:00Z'));
  });

  it('trades Monday to Friday only', () => {
    const days = ['2026-10-04', '2026-10-05', '2026-10-09', '2026-10-10'].map((d) =>
      FX.isTradingDay(at(`${d}T00:00:00Z`)),
    );
    expect(days).toEqual([false, true, true, false]); // Sun, Mon, Fri, Sat
    // Friday after its close is Saturday's: no session.
    expect(FX.isTradingDay(FX.dayOf(at('2026-10-09T21:30:00Z')))).toBe(false);
  });

  it('dates a session the month it closes in: 30 September at 17:00 New York opens 1 October', () => {
    expect(FX.dayOf(at('2026-09-30T20:30:00Z'))).toBe(at('2026-09-30T00:00:00Z'));
    expect(FX.dayOf(at('2026-09-30T21:30:00Z'))).toBe(at('2026-10-01T00:00:00Z'));
    expect(FX.sessionOfDay(at('2026-10-01T00:00:00Z')).start).toBe(at('2026-09-30T21:00:00Z'));
  });

  it('agrees with the engine’s session-grid bars, whose day is read off their close', () => {
    // 4h blocks and the daily bar of Tuesday 6 Oct, as `scripting/chart-bars` lays them out.
    const blocks = [21, 25, 29, 33, 37, 41].map((h) => {
      const time = at('2026-10-05T00:00:00Z') + h * H;
      return { time, closeTime: time + 4 * H };
    });
    const daily = { time: at('2026-10-05T21:00:00Z'), closeTime: at('2026-10-06T21:00:00Z') };
    for (const b of [...blocks, daily]) expect(FX.dayOf(b.time)).toBe(tradingDayMs(b));
  });

  it('remembers what it worked out: the same answer, however often it is asked', () => {
    const t = at('2026-10-06T22:15:00Z');
    expect(FX.dayOf(t)).toBe(FX.dayOf(t));
    expect([at('2026-10-06T23:00:00Z'), t].map(FX.dayOf)).toEqual([
      at('2026-10-07T00:00:00Z'),
      at('2026-10-07T00:00:00Z'),
    ]);
  });
});

describe('TradingCalendar — a UTC session (crypto)', () => {
  it('is the UTC day, every day', () => {
    expect(UTC.dayOf(at('2026-10-06T23:59:59Z'))).toBe(at('2026-10-06T00:00:00Z'));
    expect(UTC.dayOf(at('2026-10-07T00:00:00Z'))).toBe(at('2026-10-07T00:00:00Z'));
    expect(UTC.isTradingDay(at('2026-10-10T00:00:00Z'))).toBe(true); // Saturday
    expect(UTC.sessionAt(at('2026-10-07T12:00:00Z'))).toEqual({
      day: at('2026-10-07T00:00:00Z'),
      start: at('2026-10-07T00:00:00Z'),
      end: at('2026-10-08T00:00:00Z'),
    });
  });
});

describe('nextSessionPeriod — the period a live price opens after the newest bar closed', () => {
  const block = (openIso: string, hours: number) => ({
    time: at(openIso),
    closeTime: at(openIso) + hours * H,
  });

  it('within the week, the next 4h block opens where the last one closed', () => {
    const last = block('2026-10-06T09:00:00Z', 4); // closes 13:00 UTC
    expect(nextSessionPeriod(FX, '240', last, at('2026-10-06T13:00:00Z'))).toEqual({
      time: at('2026-10-06T13:00:00Z'),
      closeTime: at('2026-10-06T17:00:00Z'),
    });
    // A first price ten minutes in still opens the block at its open, not at its own minute.
    expect(nextSessionPeriod(FX, '240', last, at('2026-10-06T13:10:00Z'))?.time).toBe(
      at('2026-10-06T13:00:00Z'),
    );
    // 2h blocks the same way.
    expect(
      nextSessionPeriod(FX, '120', block('2026-10-06T11:00:00Z', 2), at('2026-10-06T13:00:05Z')),
    ).toEqual({ time: at('2026-10-06T13:00:00Z'), closeTime: at('2026-10-06T15:00:00Z') });
  });

  it('a day opens with its session and closes with it', () => {
    const tuesday = block('2026-10-05T21:00:00Z', 24);
    expect(nextSessionPeriod(FX, '1D', tuesday, at('2026-10-06T21:00:02Z'))).toEqual({
      time: at('2026-10-06T21:00:00Z'),
      closeTime: at('2026-10-07T21:00:00Z'),
    });
  });

  it('after the weekend, every timeframe opens with Monday’s session on Sunday evening', () => {
    const friday4h = block('2026-10-09T17:00:00Z', 4); // the week's last block, to 21:00
    const sunday = at('2026-10-11T21:00:30Z');
    expect(nextSessionPeriod(FX, '240', friday4h, sunday)).toEqual({
      time: at('2026-10-11T21:00:00Z'),
      closeTime: at('2026-10-12T01:00:00Z'),
    });
    const fridayDaily = block('2026-10-08T21:00:00Z', 24);
    expect(nextSessionPeriod(FX, '1D', fridayDaily, sunday)).toEqual({
      time: at('2026-10-11T21:00:00Z'),
      closeTime: at('2026-10-12T21:00:00Z'),
    });
    // A week closes with its Friday's session.
    const week = { time: at('2026-10-04T21:00:00Z'), closeTime: at('2026-10-09T21:00:00Z') };
    expect(nextSessionPeriod(FX, '1W', week, sunday)).toEqual({
      time: at('2026-10-11T21:00:00Z'),
      closeTime: at('2026-10-16T21:00:00Z'),
    });
  });

  it('a month that turns over a weekend and a clock change: November from Sunday 1 Nov 22:00 UTC', () => {
    // October's last trading day is Friday 30 Oct (EDT); November's first session opens on Sunday
    // evening after New York left EDT, and November closes with Monday 30 Nov's session (EST).
    const october = { time: at('2026-09-30T21:00:00Z'), closeTime: at('2026-10-30T21:00:00Z') };
    expect(nextSessionPeriod(FX, '1M', october, at('2026-11-01T22:00:01Z'))).toEqual({
      time: at('2026-11-01T22:00:00Z'),
      closeTime: at('2026-11-30T22:00:00Z'),
    });
  });

  it('leaves it to the engine when it cannot tell the period', () => {
    const last = block('2026-10-06T09:00:00Z', 4);
    // No price for a whole block: which block this one is in, the engine knows.
    expect(nextSessionPeriod(FX, '240', last, at('2026-10-06T17:30:00Z'))).toBeNull();
    // A stray price on Saturday: no session at all.
    const friday4h = block('2026-10-09T17:00:00Z', 4);
    expect(nextSessionPeriod(FX, '240', friday4h, at('2026-10-10T12:00:00Z'))).toBeNull();
    // Before the close, or a bar without one.
    expect(nextSessionPeriod(FX, '240', last, at('2026-10-06T12:00:00Z'))).toBeNull();
    expect(
      nextSessionPeriod(FX, '240', { time: last.time }, at('2026-10-06T13:00:00Z')),
    ).toBeNull();
  });
});

describe('tradingMsBetween — the bars still to come open only while the market trades (CC-I2)', () => {
  it('counts nothing for the FX weekend', () => {
    // Friday 17:00 New York (EDT) to Monday 12:30 UTC: only Sunday 17:00 NY onwards trades.
    expect(tradingMsBetween(FX, at('2026-10-09T21:00:00Z'), at('2026-10-12T12:30:00Z'))).toBe(
      15.5 * H,
    );
  });

  it('is the plain span inside a trading week, and every hour on a 7-day session', () => {
    expect(tradingMsBetween(FX, at('2026-10-06T10:00:00Z'), at('2026-10-06T14:00:00Z'))).toBe(
      4 * H,
    );
    expect(tradingMsBetween(UTC, at('2026-10-09T21:00:00Z'), at('2026-10-12T12:30:00Z'))).toBe(
      63.5 * H,
    );
  });
});
