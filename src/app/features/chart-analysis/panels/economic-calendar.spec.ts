import { describe, expect, it } from 'vitest';

import {
  currencyFlag,
  eventCountdown,
  groupByDay,
  impactDots,
  isEventPast,
  SOON_MS,
} from './economic-calendar';
import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';

const ev = (id: number, iso: string, actual: string | null = null): UpcomingEconomicEvent => ({
  id,
  title: 'CPI',
  currency: 'EUR',
  impact: 'High',
  scheduledAt: iso,
  forecast: '0.3%',
  previous: '0.2%',
  actual,
  forecastProvenance: 'PreRelease',
});

describe('economic calendar helpers', () => {
  it('groups by the viewer’s local day in time order', () => {
    const d1 = new Date(2026, 9, 6, 9, 0).toISOString();
    const d1b = new Date(2026, 9, 6, 14, 30).toISOString();
    const d2 = new Date(2026, 9, 7, 8, 0).toISOString();
    const days = groupByDay([ev(3, d2), ev(1, d1b), ev(2, d1)]);
    expect(days.map((d) => d.key)).toEqual(['2026-10-06', '2026-10-07']);
    expect(days[0].events.map((e) => e.id)).toEqual([2, 1]);
  });

  it('counts down only soon, unreleased events; "due" just after its time; nothing once released', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    expect(eventCountdown(ev(1, '2026-10-06T12:12:34Z'), now)).toBe('in 12:34');
    expect(eventCountdown(ev(1, '2026-10-06T13:05:00Z'), now)).toBe('in 1h 05m');
    expect(eventCountdown(ev(1, new Date(now + SOON_MS + 1000).toISOString()), now)).toBeNull();
    expect(eventCountdown(ev(1, '2026-10-06T11:50:00Z'), now)).toBe('due');
    expect(eventCountdown(ev(1, '2026-10-06T09:00:00Z'), now)).toBeNull();
    expect(eventCountdown(ev(1, '2026-10-06T12:10:00Z', '0.4%'), now)).toBeNull();
  });

  it('importance dots and flags', () => {
    expect([impactDots('High'), impactDots('medium'), impactDots('Low')]).toEqual([3, 2, 1]);
    expect(currencyFlag('eur')).toBe('🇪🇺');
    expect(currencyFlag('XYZ')).toBe('');
  });

  it("an event is past two minutes after its time (the engine's post-event grace)", () => {
    const at = '2026-10-06T12:40:00Z';
    expect(isEventPast({ scheduledAt: at }, Date.parse(at) + 60_000)).toBe(false);
    expect(isEventPast({ scheduledAt: at }, Date.parse(at) + 120_000)).toBe(true);
  });
});
