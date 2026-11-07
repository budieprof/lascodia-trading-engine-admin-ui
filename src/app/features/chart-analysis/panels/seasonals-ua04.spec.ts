import { describe, expect, it } from 'vitest';
import { seasonalDay, seasonalRanges, seasonalYears } from './performance';

const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const bar = (iso: string, close: number) => ({
  time: at(iso),
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

describe('seasonals on any history (UA04)', () => {
  it('places a date on the same day every year, leap years included', () => {
    expect(seasonalDay(at('2025-03-01'))).toBe(59);
    expect(seasonalDay(at('2024-03-01'))).toBe(59);
    expect(seasonalDay(at('2024-02-29'))).toBe(58);
    expect(seasonalDay(at('2024-12-31'))).toBe(364);
    expect(seasonalDay(at('2023-12-31'))).toBe(364);
  });

  it('reads each year once, based on the previous close; the same lines as before on non-leap years', () => {
    const bars = [
      bar('2024-12-31', 100),
      bar('2025-01-02', 110),
      bar('2025-06-02', 90),
      bar('2026-01-02', 99),
    ];
    const ys = seasonalYears(bars, 2);
    expect(ys.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    expect(ys[1].points).toEqual([
      { day: 1, pct: 10 },
      { day: 152, pct: -10 },
    ]);
    expect(ys[0].points[0].pct).toBeCloseTo(10, 6);
    expect(seasonalYears([], 3)).toEqual([]);
  });

  it('offers only the ranges the history covers; All says where it starts', () => {
    expect(seasonalRanges(2026, 2026).map((r) => r.label)).toEqual(['All (2026+)']);
    expect(seasonalRanges(2026, 2010).map((r) => r.label)).toEqual([
      '3 years',
      '5 years',
      '10 years',
      'All (2010+)',
    ]);
    expect(seasonalRanges(2026, null).map((r) => r.label)).toEqual([
      '3 years',
      '5 years',
      '10 years',
      'All',
    ]);
  });
});
