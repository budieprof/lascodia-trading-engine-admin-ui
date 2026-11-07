import { describe, expect, it } from 'vitest';
import type { TradingCalendarDto } from '@core/instruments/instrument.types';
import {
  dayDigitsOf,
  exchangeSessionsNote,
  exchangeSessionsOf,
  kindHighLow,
} from './exchange-sessions';
import { indicatorById } from './registry';
import { sessionStartOf } from '../profiles/profile-math';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const nyse: TradingCalendarDto = {
  code: 'nyse',
  timeZone: 'America/New_York',
  is24x7: false,
  holidays: [],
  sessions: DAYS.flatMap((day) => [
    { day, open: '04:00', close: '09:30', kind: 'Pre' as const },
    { day, open: '09:30', close: '16:00', kind: 'Regular' as const },
    { day, open: '16:00', close: '20:00', kind: 'Post' as const },
  ]),
};
const globex: TradingCalendarDto = {
  code: 'cme-globex',
  timeZone: 'America/Chicago',
  is24x7: false,
  holidays: [],
  sessions: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].flatMap((day) => [
    { day, open: '17:00', close: '16:00', kind: 'Regular' as const },
    { day, open: '16:00', close: '17:00', kind: 'Maintenance' as const },
  ]),
};

const M = 60_000;
/** Hourly bars over Tue 3 Nov 2026 (UTC); New York is UTC−5 then. */
const bars = Array.from({ length: 24 }, (_, h) => {
  const time = Date.parse('2026-11-03T00:00:00Z') + h * 60 * M;
  return { time, open: h, high: h + 1, low: h - 1, close: h, volume: 1 };
});

describe('exchange sessions (UA02)', () => {
  it('reads the calendar into Pre / Regular / Post windows with their weekdays', () => {
    const s = exchangeSessionsOf(nyse);
    expect(s.windows.Regular).toEqual([
      { start: '0930', end: '1600', zone: 'America/New_York', days: '23456' },
    ]);
    expect(s.windows.Pre[0].start).toBe('0400');
    const g = exchangeSessionsOf(globex);
    expect(g.windows.Regular).toEqual([
      { start: '1700', end: '1600', zone: 'America/Chicago', days: '12345' },
    ]);
    expect(g.windows.Pre).toEqual([]);
  });

  it('RTH high/low runs 09:30–16:00 New York (14:30–21:00 UTC) only', () => {
    const s = exchangeSessionsOf(nyse);
    const r = kindHighLow(bars, s.windows.Regular);
    const inSession = r.high
      .map((v, i) => (v === null ? null : new Date(bars[i].time).getUTCHours()))
      .filter((h) => h !== null);
    expect(inSession).toEqual([15, 16, 17, 18, 19, 20]);
    expect(
      kindHighLow(bars, s.windows.Regular, undefined, '17').high.every((v) => v === null),
    ).toBe(true);
  });

  it('the study draws the three sessions; nothing without a calendar or on 24/7', () => {
    const def = indicatorById('exchange-sessions')!;
    const out = def.compute(
      bars,
      { days: 'Auto', show: 'All sessions' },
      { exchangeSessions: exchangeSessionsOf(nyse) },
    );
    expect(out['rthHigh'].filter((v) => v !== null)).toHaveLength(6);
    expect(out['preHigh'].filter((v) => v !== null).length).toBeGreaterThan(0);
    const reg = def.compute(
      bars,
      { days: 'Auto', show: 'Regular only' },
      { exchangeSessions: exchangeSessionsOf(nyse) },
    );
    expect(reg['preHigh'].every((v) => v === null)).toBe(true);
    expect(def.compute(bars, {}, {})['rthHigh'].every((v) => v === null)).toBe(true);
    expect(exchangeSessionsNote(null, 'aapl')).toBe('No exchange calendar reported for AAPL yet.');
    expect(
      exchangeSessionsNote(
        {
          code: 'crypto-24x7',
          zone: 'Etc/UTC',
          is24x7: true,
          windows: { Pre: [], Regular: [], Post: [] },
        },
        'btc-usd',
      ),
    ).toContain('24/7');
  });

  it('Sessions study: FX unchanged on Auto, every day on a 24/7 market, explicit days win', () => {
    const def = indicatorById('sessions')!;
    // Saturday 7 Nov 2026, 09:00–10:00 London.
    const sat = [
      { time: Date.parse('2026-11-07T09:00:00Z'), open: 1, high: 2, low: 0, close: 1, volume: 1 },
    ];
    expect(def.compute(sat, {}, {})['londonHigh'][0]).toBeNull();
    expect(def.compute(sat, { days: 'Auto' }, { everyDay: false })['londonHigh'][0]).toBeNull();
    expect(def.compute(sat, { days: 'Auto' }, { everyDay: true })['londonHigh'][0]).toBe(2);
    expect(def.compute(sat, { days: 'Mon–Fri' }, { everyDay: true })['londonHigh'][0]).toBeNull();
    expect(dayDigitsOf('Every day')).toBe('1234567');
  });

  it('session profiles: regular from the calendar, Asia/London/NY all week on 24/7', () => {
    const ex = exchangeSessionsOf(nyse);
    const t = Date.parse('2026-11-03T16:00:00Z');
    expect(sessionStartOf(t, 'regular', 0, undefined, { exchange: ex })).toBe(
      Date.parse('2026-11-03T14:30:00Z'),
    );
    expect(sessionStartOf(t, 'regular', 0, undefined, {})).toBeNull();
    const sat = Date.parse('2026-11-07T09:30:00Z');
    expect(sessionStartOf(sat, 'london')).toBeNull();
    expect(sessionStartOf(sat, 'london', 0, undefined, { everyDay: true })).toBe(
      Date.parse('2026-11-07T08:00:00Z'),
    );
  });
});
