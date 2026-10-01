import { describe, expect, it } from 'vitest';
import { shiftPointsByBars } from './drawing-ops';

// Hourly bars Fri 20:00–22:00, weekend gap, then Mon 00:00–02:00 (UTC ms).
const H = 3_600_000;
const fri = Date.UTC(2026, 8, 25, 20);
const mon = Date.UTC(2026, 8, 28, 0);
const bars = [fri, fri + H, fri + 2 * H, mon, mon + H, mon + 2 * H].map((time) => ({ time }));

function logicalAt(t: number): number {
  for (let i = 0; i < bars.length - 1; i++)
    if (t >= bars[i].time && t <= bars[i + 1].time) return i + (t - bars[i].time) / (bars[i + 1].time - bars[i].time);
  return t < bars[0].time ? (t - bars[0].time) / H : bars.length - 1 + (t - bars[bars.length - 1].time) / H;
}
function timeAtLogical(l: number): number {
  if (l <= 0) return bars[0].time + l * H;
  const last = bars.length - 1;
  if (l >= last) return bars[last].time + (l - last) * H;
  const i = Math.floor(l);
  return bars[i].time + (l - i) * (bars[i + 1].time - bars[i].time);
}

describe('moving drawings by bars', () => {
  it('keeps the bar spacing of every anchor across a weekend gap', () => {
    // Ellipse anchors on bars 0, 2 and 1 (all Friday); move 2 bars right.
    const pts = [
      { time: bars[0].time, price: 1 },
      { time: bars[2].time, price: 1.1 },
      { time: bars[1].time, price: 1.05 },
    ];
    const moved = shiftPointsByBars(pts, 2, 0.01, logicalAt, timeAtLogical, 2 * H);
    // Bars 2, 4 and 3: the shape spans the same number of bars, the weekend is skipped.
    expect(moved.map((p) => p.time)).toEqual([bars[2].time, bars[4].time, bars[3].time]);
    expect(moved[0].price).toBeCloseTo(1.01, 10);
    // A plain millisecond shift would have put the third anchor inside the weekend.
    expect(pts[2].time + 2 * H).toBeLessThan(mon);
  });

  it('falls back to a time shift when bars are unknown', () => {
    const moved = shiftPointsByBars([{ time: 0, price: 1 }], 3, 0, () => null, () => null, 3 * H);
    expect(moved[0].time).toBe(3 * H);
  });
});
