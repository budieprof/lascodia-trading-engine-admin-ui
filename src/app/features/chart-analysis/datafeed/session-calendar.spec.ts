import { describe, expect, it } from 'vitest';
import {
  TradingCalendar,
  nextSessionPeriod,
  parseSessionPeriods,
  tradingMsBetween,
} from './session-calendar';
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

/**
 * UD01: the engine's session string as it is — several periods (a NYSE CFD's pre, regular and post hours), the
 * maintenance hour CME leaves out, and the holidays / early closes / breaks chart-bars reports as `closures`.
 */
describe('TradingCalendar — the engine’s sessions with periods and closures (UD01)', () => {
  const NYSE_X = '0400-0930,0930-1600,1600-2000:23456';
  const aapl = new TradingCalendar({ session: NYSE_X, timeZone: 'America/New_York' });
  const block = (openIso: string, closeIso: string) => ({
    time: at(openIso),
    closeTime: at(closeIso),
  });

  it('reads every period and the trading days of a multi-period string', () => {
    expect(parseSessionPeriods(NYSE_X)).toEqual({
      periods: [
        { open: 240, length: 330 },
        { open: 570, length: 390 },
        { open: 960, length: 240 },
      ],
      days: '23456',
    });
    expect(parseSessionPeriods('1700-1700:23456').periods).toEqual([{ open: 1020, length: 1440 }]);
    expect(parseSessionPeriods('24x7')).toEqual({
      periods: [{ open: 0, length: 1440 }],
      days: null,
    });
  });

  it('trades only inside its periods: not at night, not on Saturday (days were lost before)', () => {
    // Tuesday 6 Oct 2026 (EDT): 04:00 New York = 08:00 UTC, 20:00 = 00:00 UTC.
    expect(aapl.periodAt(at('2026-10-06T07:59:00Z'))).toBeNull();
    expect(aapl.periodAt(at('2026-10-06T08:00:00Z'))).toMatchObject({
      open: at('2026-10-06T08:00:00Z'),
      close: at('2026-10-06T13:30:00Z'),
    });
    expect(aapl.periodAt(at('2026-10-07T00:30:00Z'))).toBeNull();
    expect(aapl.isTradingDay(at('2026-10-10T00:00:00Z'))).toBe(false);
    expect(aapl.isTradingDay(at('2026-10-06T00:00:00Z'))).toBe(true);
    // The trading day is the New York date, midnight to midnight.
    expect(aapl.dayOf(at('2026-10-06T23:00:00Z'))).toBe(at('2026-10-06T00:00:00Z'));
    expect(tradingMsBetween(aapl, at('2026-10-06T00:00:00Z'), at('2026-10-07T12:00:00Z'))).toBe(
      16 * H + 4 * H,
    );
  });

  it('lays 1h bars from each period’s open: 09:00 is cut at 09:30, the regular session starts at 09:30', () => {
    expect(
      nextSessionPeriod(
        aapl,
        '60',
        block('2026-10-06T12:00:00Z', '2026-10-06T13:00:00Z'),
        at('2026-10-06T13:05:00Z'),
      ),
    ).toEqual({ time: at('2026-10-06T13:00:00Z'), closeTime: at('2026-10-06T13:30:00Z') });
    expect(
      nextSessionPeriod(
        aapl,
        '60',
        block('2026-10-06T13:00:00Z', '2026-10-06T13:30:00Z'),
        at('2026-10-06T13:31:00Z'),
      ),
    ).toEqual({ time: at('2026-10-06T13:30:00Z'), closeTime: at('2026-10-06T14:30:00Z') });
    // After the night: the first bar of the pre-market, not the bar after yesterday's last.
    expect(
      nextSessionPeriod(
        aapl,
        '60',
        block('2026-10-06T23:00:00Z', '2026-10-07T00:00:00Z'),
        at('2026-10-07T08:00:10Z'),
      ),
    ).toEqual({ time: at('2026-10-07T08:00:00Z'), closeTime: at('2026-10-07T09:00:00Z') });
    // A price at night opens nothing.
    expect(
      nextSessionPeriod(
        aapl,
        '60',
        block('2026-10-06T23:00:00Z', '2026-10-07T00:00:00Z'),
        at('2026-10-07T03:00:00Z'),
      ),
    ).toBeNull();
    // The day: from the first open to the last close.
    expect(
      nextSessionPeriod(
        aapl,
        '1D',
        block('2026-10-05T08:00:00Z', '2026-10-06T00:00:00Z'),
        at('2026-10-06T08:00:05Z'),
      ),
    ).toEqual({ time: at('2026-10-06T08:00:00Z'), closeTime: at('2026-10-07T00:00:00Z') });
  });

  it('a holiday does not trade, an early close cuts the day short (C1 closures)', () => {
    const closures = [
      // Thanksgiving, Thursday 26 Nov 2026 (EST): the whole day.
      {
        fromMs: at('2026-11-26T05:00:00Z'),
        toMs: at('2026-11-27T05:00:00Z'),
        kind: 'Holiday',
        label: 'Thanksgiving',
      },
      // The Friday after: closes at 13:00 New York (18:00 UTC).
      {
        fromMs: at('2026-11-27T18:00:00Z'),
        toMs: at('2026-11-28T01:00:00Z'),
        kind: 'EarlyClose',
        label: 'Early close',
      },
    ];
    const cal = new TradingCalendar({ session: NYSE_X, timeZone: 'America/New_York', closures });
    expect(cal.isTradingDay(at('2026-11-26T00:00:00Z'))).toBe(false);
    expect(cal.isTradingDay(at('2026-11-27T00:00:00Z'))).toBe(true);
    expect(
      nextSessionPeriod(
        cal,
        '60',
        block('2026-11-25T23:00:00Z', '2026-11-26T01:00:00Z'),
        at('2026-11-26T15:00:00Z'),
      ),
    ).toBeNull();
    expect(cal.tradingBounds(cal.sessionAt(at('2026-11-27T15:00:00Z')))).toEqual({
      open: at('2026-11-27T09:00:00Z'),
      close: at('2026-11-27T18:00:00Z'),
    });
    expect(
      nextSessionPeriod(
        cal,
        '60',
        block('2026-11-27T16:30:00Z', '2026-11-27T17:30:00Z'),
        at('2026-11-27T17:31:00Z'),
      ),
    ).toEqual({ time: at('2026-11-27T17:30:00Z'), closeTime: at('2026-11-27T18:00:00Z') });
    expect(tradingMsBetween(cal, at('2026-11-26T05:00:00Z'), at('2026-11-27T05:00:00Z'))).toBe(0);
    // FX ignores nothing it was not told: no closures, every weekday trades.
    expect(FX.isTradingDay(at('2026-11-26T00:00:00Z'))).toBe(true);
  });

  it('CME’s 16:00-17:00 Chicago maintenance hour is not trading time', () => {
    const cme = new TradingCalendar({ session: '1700-1600:23456', timeZone: 'America/Chicago' });
    // Tuesday 6 Oct 2026 (CDT): 16:00 Chicago = 21:00 UTC.
    expect(cme.periodAt(at('2026-10-06T21:30:00Z'))).toBeNull();
    expect(cme.periodAt(at('2026-10-06T22:00:00Z'))?.open).toBe(at('2026-10-06T22:00:00Z'));
    expect(tradingMsBetween(cme, at('2026-10-06T22:00:00Z'), at('2026-10-07T22:00:00Z'))).toBe(
      23 * H,
    );
  });
});
