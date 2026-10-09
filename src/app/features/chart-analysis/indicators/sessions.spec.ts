import { describe, expect, it } from 'vitest';
import { SESSION_WINDOWS, parseSessionWindow, sessionDayOf, sessionHighLow } from './sessions';
import { indicatorById } from './registry';

const H = 3_600_000;

describe('sessions on their own clocks (DR-18)', () => {
  it('London opens at 08:00 London: 07:00 UTC in summer, 08:00 UTC in winter', () => {
    const london = SESSION_WINDOWS.london;
    expect(sessionDayOf(Date.UTC(2026, 6, 15, 7), london)).not.toBeNull(); // Wed 15 Jul, BST
    expect(sessionDayOf(Date.UTC(2026, 6, 15, 6), london)).toBeNull();
    expect(sessionDayOf(Date.UTC(2026, 0, 14, 7), london)).toBeNull(); // Wed 14 Jan, GMT: 07:00 London
    expect(sessionDayOf(Date.UTC(2026, 0, 14, 8), london)).not.toBeNull();
    expect(sessionDayOf(Date.UTC(2026, 0, 14, 17), london)).toBeNull(); // closed at 17:00
  });

  it('New York is 12:00-21:00 UTC in summer and 13:00-22:00 UTC in winter', () => {
    const ny = SESSION_WINDOWS.newyork;
    expect(sessionDayOf(Date.UTC(2026, 6, 15, 12), ny)).not.toBeNull();
    expect(sessionDayOf(Date.UTC(2026, 0, 14, 12), ny)).toBeNull();
    expect(sessionDayOf(Date.UTC(2026, 0, 14, 21), ny)).not.toBeNull();
  });

  it('weekends do not trade; Tokyo has no DST', () => {
    const tokyo = SESSION_WINDOWS.asia;
    expect(sessionDayOf(Date.UTC(2026, 0, 17, 1), tokyo)).toBeNull(); // Saturday 10:00 Tokyo
    expect(sessionDayOf(Date.UTC(2026, 0, 16, 0), tokyo)).not.toBeNull(); // Friday 09:00 Tokyo
    expect(sessionDayOf(Date.UTC(2026, 6, 16, 0), tokyo)).not.toBeNull();
  });

  it('reads the real instant, not a bar shifted into the display zone', () => {
    // Two H1 bars at 07:00 and 08:00 UTC in winter, plotted on a New York axis (5 h earlier).
    const utc = [Date.UTC(2026, 0, 14, 7), Date.UTC(2026, 0, 14, 8)];
    const shifted = utc.map((t, i) => ({
      time: t - 5 * H,
      open: 1,
      high: 1 + i,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const r = sessionHighLow(shifted, SESSION_WINDOWS.london, utc);
    expect(r.high).toEqual([null, 2]); // only the 08:00 UTC bar is London's
  });

  it('a session string parses with or without the colon; junk is refused', () => {
    expect(parseSessionWindow('0800-1700', 'Europe/London')).toEqual({
      start: '0800',
      end: '1700',
      zone: 'Europe/London',
    });
    expect(parseSessionWindow('08:00 - 17:00', 'Etc/UTC')?.start).toBe('0800');
    expect(parseSessionWindow('8am-5pm', 'Etc/UTC')).toBeNull();
  });

  it('the indicator takes a session and a zone per market', () => {
    const def = indicatorById('sessions')!;
    expect(def.inputs.map((i) => i.key)).toEqual([
      'asiaSession',
      'asiaZone',
      'londonSession',
      'londonZone',
      'nySession',
      'nyZone',
    ]);
    const winter = Array.from({ length: 24 }, (_, i) => ({
      time: Date.UTC(2026, 0, 14, i),
      open: 1,
      high: 1 + i / 100,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const out = def.compute(winter, { londonSession: '0800-1700', londonZone: 'Europe/London' });
    expect(out['londonHigh'].findIndex((v) => v !== null)).toBe(8);
    const high = out['londonHigh'];
    let last = -1;
    for (let i = 0; i < high.length; i++) if (high[i] !== null) last = i;
    expect(last).toBe(16);
  });
});
