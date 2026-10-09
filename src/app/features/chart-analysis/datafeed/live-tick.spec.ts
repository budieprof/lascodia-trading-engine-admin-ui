import { describe, expect, it } from 'vitest';
import type { Bar } from './candle-feed.service';
import { liveTick } from './live-tick';
import { TradingCalendar } from './session-calendar';

const H = 3_600_000;
const DAY = 24 * H;
const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });

describe('liveTick — a live price on a compare series or a split panel (CC-12, CC-13)', () => {
  const t0 = Date.parse('2026-10-07T13:00:00Z');
  const hourly: Bar[] = [
    { time: t0 - H, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 3 },
    { time: t0, open: 1.1, high: 1.15, low: 1.05, close: 1.12, volume: 2 },
  ];

  it('moves the forming bar on the stored grid', () => {
    const next = liveTick(hourly, 1.2, t0 + 10 * 60_000, '60', null)!;
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ close: 1.2, high: 1.2 });
    expect(next[0]).toBe(hourly[0]);
  });

  it('opens the next bar when the hour turns', () => {
    const next = liveTick(hourly, 1.3, t0 + H + 5_000, '60', null)!;
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ time: t0 + H, open: 1.3, close: 1.3 });
  });

  it('moves the session-grid forming bar while its period lasts', () => {
    const open = Date.parse('2026-10-06T21:00:00Z');
    const daily: Bar[] = [
      { time: open, closeTime: open + DAY, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    ];
    expect(liveTick(daily, 1.01, open + 2 * H, '1D', FX)?.[0]).toMatchObject({
      close: 1.01,
      high: 1.01,
    });
  });

  it('changes nothing for a price that does not count', () => {
    expect(liveTick([], 1, t0, '60', null)).toBeNull();
    expect(liveTick(hourly, Number.NaN, t0, '60', null)).toBeNull();
  });
});
