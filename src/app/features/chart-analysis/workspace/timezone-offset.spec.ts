import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROKER_SERVER_TIMEZONE,
  BROWSER_TIMEZONE,
  CHART_TIMEZONES,
  midnightOnClock,
  resolveTimezone,
  timezoneOffsetMinutes,
} from './layout-store.service';

const HOUR = 3_600_000;

/** The offset straight from Intl, as the chart computed it before offsets were remembered. */
function intlOffset(zone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - atMs) / 60000);
}

describe('timezoneOffsetMinutes — remembered per hour (CC-01)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks Intl at most twice for every instant inside one hour', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    // An hour no other test touches, so nothing is remembered yet.
    const hourStart = Date.UTC(2031, 4, 14, 9);
    for (let m = 0; m < 60; m++) timezoneOffsetMinutes('Asia/Tokyo', hourStart + m * 60_000);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    // …and not at all the second time round.
    spy.mockClear();
    for (let m = 0; m < 60; m++) timezoneOffsetMinutes('Asia/Tokyo', hourStart + m * 60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('agrees with Intl on every hour across both New York DST switches', () => {
    const from = Date.UTC(2026, 2, 7);
    const to = Date.UTC(2026, 2, 10);
    for (let t = from; t < to; t += 15 * 60_000)
      expect(timezoneOffsetMinutes('America/New_York', t)).toBe(intlOffset('America/New_York', t));
    const autumn = Date.UTC(2026, 10, 1);
    for (let t = autumn; t < autumn + 24 * HOUR; t += 15 * 60_000)
      expect(timezoneOffsetMinutes('America/New_York', t)).toBe(intlOffset('America/New_York', t));
  });

  it('is exact either side of a switch that falls on the half hour', () => {
    // Adelaide (UTC+10:30 → +9:30) leaves daylight time at 03:00 local = 16:30 UTC.
    const hour = Date.UTC(2026, 3, 4, 16);
    expect(timezoneOffsetMinutes('Australia/Adelaide', hour + 29 * 60_000)).toBe(630);
    expect(timezoneOffsetMinutes('Australia/Adelaide', hour + 31 * 60_000)).toBe(570);
  });

  it('keeps UTC at zero without asking Intl', () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    expect(timezoneOffsetMinutes('UTC', Date.UTC(2026, 0, 1))).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chart time zones — broker server and browser (CC-I9)', () => {
  it('offers the broker server clock on EU daylight-saving dates', () => {
    expect(CHART_TIMEZONES.some((z) => z.id === BROKER_SERVER_TIMEZONE)).toBe(true);
    // Winter UTC+2, summer UTC+3, switching on the EU's last Sunday of March.
    expect(timezoneOffsetMinutes(BROKER_SERVER_TIMEZONE, Date.UTC(2026, 0, 15))).toBe(120);
    expect(timezoneOffsetMinutes(BROKER_SERVER_TIMEZONE, Date.UTC(2026, 6, 15))).toBe(180);
    // 2026-03-15: New York is already on daylight time, the EU is not.
    expect(timezoneOffsetMinutes(BROKER_SERVER_TIMEZONE, Date.UTC(2026, 2, 15))).toBe(120);
  });

  it('resolves the browser choice to this browser’s own zone', () => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveTimezone(BROWSER_TIMEZONE)).toBe(own || 'UTC');
    expect(resolveTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    const at = Date.UTC(2026, 6, 1, 12);
    expect(timezoneOffsetMinutes(BROWSER_TIMEZONE, at)).toBe(
      timezoneOffsetMinutes(resolveTimezone(BROWSER_TIMEZONE), at),
    );
  });
});

describe("midnightOnClock — a date on the chart's clock (CC-15)", () => {
  it('is UTC midnight on UTC, and 04:00 UTC on New York in summer', () => {
    expect(midnightOnClock(2026, 9, 9, 'UTC')).toBe(Date.parse('2026-10-09T00:00:00Z'));
    expect(midnightOnClock(2026, 9, 9, 'America/New_York')).toBe(
      Date.parse('2026-10-09T04:00:00Z'),
    );
    expect(midnightOnClock(2026, 11, 1, 'America/New_York')).toBe(
      Date.parse('2026-12-01T05:00:00Z'),
    );
  });

  it('lands on the midnight of a day whose clock changes', () => {
    // London springs forward at 01:00 UTC on 29 Mar 2026: that day's midnight is still GMT.
    expect(midnightOnClock(2026, 2, 29, 'Europe/London')).toBe(Date.parse('2026-03-29T00:00:00Z'));
    expect(midnightOnClock(2026, 2, 30, 'Europe/London')).toBe(Date.parse('2026-03-29T23:00:00Z'));
  });
});
