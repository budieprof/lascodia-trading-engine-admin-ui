import { describe, expect, it } from 'vitest';
import { foldRegularDays, regularPeriodBars, regularSessionDays } from './pivots-rth';
import { pivotInputs } from './pivots';

const M15 = 15 * 60_000;
const rth = [{ start: '0930', end: '1600', zone: 'America/New_York', days: '23456' }];

/** 15-minute bars 08:00–21:00 UTC (03:00–16:00 New York) on Mon 2 and Tue 3 Nov 2026. */
function day(date: string, base: number) {
  const out = [];
  const t0 = Date.parse(`${date}T08:00:00Z`);
  for (let i = 0; i < 52; i++) {
    const time = t0 + i * M15;
    const inRth = time >= Date.parse(`${date}T14:30:00Z`) && time < Date.parse(`${date}T21:00:00Z`);
    // Extended-hours bars spike far outside the regular range.
    out.push({
      time,
      open: base,
      high: inRth ? base + 2 : base + 50,
      low: inRth ? base - 2 : base - 50,
      close: base + i / 100,
      volume: 1,
    });
  }
  return out;
}

describe('pivots on the regular session only (UA06)', () => {
  it('builds one bar per regular session, leaving extended hours out', () => {
    const bars = [...day('2026-11-02', 100), ...day('2026-11-03', 110)];
    const days = regularSessionDays(bars, rth, M15);
    expect(days).toHaveLength(2);
    expect(days[0].time).toBe(Date.parse('2026-11-02T14:30:00Z'));
    expect(days[0].high).toBe(102);
    expect(days[0].low).toBe(98);
    expect(days[0].closeTime).toBe(Date.parse('2026-11-02T21:00:00Z'));
    // After Tuesday's close, the previous regular day is Tuesday's.
    const inputs = pivotInputs(days, Date.parse('2026-11-03T23:00:00Z'))!;
    expect(inputs.prev.high).toBe(112);
    expect(inputs.prev.low).toBe(108);
  });

  it('weeks run to the next week (still current between sessions); years and empty history fall back', () => {
    const bars = [...day('2026-11-02', 100), ...day('2026-11-03', 110)];
    const weeks = foldRegularDays(regularSessionDays(bars, rth, M15), 'week');
    expect(weeks).toHaveLength(1);
    expect(weeks[0].closeTime).toBe(Date.parse('2026-11-09T00:00:00Z'));
    expect(regularPeriodBars('year', bars, rth, M15)).toBeNull();
    expect(regularPeriodBars('day', [], rth, M15)).toBeNull();
  });
});
