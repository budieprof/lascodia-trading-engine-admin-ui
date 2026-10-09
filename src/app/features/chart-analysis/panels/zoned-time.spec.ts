import { describe, expect, it } from 'vitest';

import { formatZoned, zonedDayKey, zoneLabel } from './zoned-time';

describe('chart-zone times (SP-09)', () => {
  // Friday 2026-10-09 12:30 UTC — NFP-time.
  const at = Date.parse('2026-10-09T12:30:00Z');

  it('formats in the chart zone, DST-correct', () => {
    expect(formatZoned(at, 'UTC', 'time')).toBe('12:30');
    expect(formatZoned(at, 'America/New_York', 'time')).toBe('08:30'); // EDT
    expect(formatZoned('2026-12-04T13:30:00Z', 'America/New_York', 'time')).toBe('08:30'); // EST
    expect(formatZoned(at, 'Asia/Tokyo', 'dateTime')).toBe('Oct 9 21:30');
    expect(formatZoned(at, 'UTC', 'day')).toBe('Fri 9 Oct');
    expect(formatZoned('not a date', 'UTC', 'time')).toBe('');
  });

  it('keys the day in the zone: 23:30 UTC is already tomorrow in Tokyo', () => {
    const late = Date.parse('2026-10-09T23:30:00Z');
    expect(zonedDayKey(late, 'UTC')).toBe('2026-10-09');
    expect(zonedDayKey(late, 'Asia/Tokyo')).toBe('2026-10-10');
    expect(zonedDayKey(late, 'America/New_York')).toBe('2026-10-09');
  });

  it('names the zone for headings', () => {
    expect(zoneLabel('America/New_York')).toBe('New York');
    expect(zoneLabel('UTC')).toBe('UTC');
    expect(zoneLabel(null)).toBe('your time');
  });
});
