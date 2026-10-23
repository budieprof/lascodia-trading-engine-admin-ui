import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { periodProfiles, periodLabel, sessionProfileNotice } from './analysis-overlays';
import { developingLevels, nakedPocLevels } from './profile-levels';

const H = 3_600_000;
const DAY = 86_400_000;

function bar(time: number, low: number, high: number, volume = 10): Ohlc {
  return { time, open: low, high, low, close: high, volume };
}

/** `n` hourly bars from `start`, each spanning [low, high]. */
function hourly(start: number, n: number, low: number, high: number): Ohlc[] {
  return Array.from({ length: n }, (_, i) => bar(start + i * H, low, high));
}

describe('session profiles — Asia / London / New York (PR-1)', () => {
  // Wed 21 Oct 2026, 24 hourly bars from 00:00 UTC. Summer time in London and New York.
  const wed = Date.UTC(2026, 9, 21);
  const bars = hourly(wed, 24, 1.1, 1.1010);

  it('cuts each session on its own clock: Tokyo 09–18, London 08–17 BST, New York 08–17 EDT', () => {
    const ps = periodProfiles(bars, 'sessions');
    const byName = (s: string) => ps.find((p) => p.session === s)!;
    // Tokyo 09:00 JST = 00:00 UTC to 18:00 JST = 09:00 UTC (exclusive).
    expect([byName('asia').t0, byName('asia').t1]).toEqual([wed, wed + 8 * H]);
    // London 08:00 BST = 07:00 UTC … 16:00 UTC.
    expect([byName('london').t0, byName('london').t1]).toEqual([wed + 7 * H, wed + 15 * H]);
    // New York 08:00 EDT = 12:00 UTC … 20:00 UTC.
    expect([byName('newyork').t0, byName('newyork').t1]).toEqual([wed + 12 * H, wed + 20 * H]);
    // In time order, labelled with the session and its local date, indices into the bars.
    expect(ps.map((p) => p.label)).toEqual(['Asia 21 Oct', 'London 21 Oct', 'New York 21 Oct']);
    expect(ps.map((p) => [p.startIdx, p.endIdx])).toEqual([
      [0, 8],
      [7, 15],
      [12, 20],
    ]);
  });

  it('follows daylight saving: London opens at 08:00 UTC once the clocks go back', () => {
    const nov = Date.UTC(2026, 10, 4); // Wed 4 Nov: GMT in London, EST in New York.
    const ps = periodProfiles(hourly(nov, 24, 1.1, 1.101), 'sessions');
    expect(ps.find((p) => p.session === 'london')!.t0).toBe(nov + 8 * H);
    expect(ps.find((p) => p.session === 'newyork')!.t0).toBe(nov + 13 * H);
  });

  it('draws no session on a weekend and none with too few bars', () => {
    const sat = Date.UTC(2026, 9, 24);
    expect(periodProfiles(hourly(sat, 24, 1.1, 1.101), 'sessions')).toEqual([]);
    expect(periodProfiles(hourly(wed, 2, 1.1, 1.101), 'sessions')).toEqual([]);
  });

  it('says why on bars coarser than an hour', () => {
    expect(sessionProfileNotice(H)).toBeNull();
    expect(sessionProfileNotice(4 * H)).toMatch(/1h bars or finer/);
  });

  it('labels calendar periods by trading date, week Monday and month', () => {
    expect(periodLabel(wed + 5 * H, 'session')).toBe('Wed 21 Oct');
    expect(periodLabel(wed + 5 * H, 'week')).toBe('wk 19 Oct');
    expect(periodLabel(wed + 5 * H, 'month')).toBe('Oct 2026');
  });
});

describe('naked POCs (PR-2)', () => {
  const d1 = Date.UTC(2026, 9, 19); // Mon
  // Day 1 trades around 1.1000, day 2 around 1.1200 (day 2's first bar is the gap away from day 1).
  // Day 3 opens at 1.1200 (touching day 2's POC at once), then one bar sweeps down through 1.1000.
  const day3 = [
    ...hourly(d1 + 2 * DAY, 5, 1.1195, 1.1205),
    bar(d1 + 2 * DAY + 5 * H, 1.099, 1.121),
    ...hourly(d1 + 2 * DAY + 6 * H, 18, 1.1295, 1.1305),
  ];
  const bars = [
    ...hourly(d1, 24, 1.0995, 1.1005),
    ...hourly(d1 + DAY, 24, 1.1195, 1.1205),
    ...day3,
    // Day 4: one bar far away, so day 3 has finished; too short to be a profile of its own.
    bar(d1 + 3 * DAY, 1.1495, 1.1505),
  ];
  const periods = periodProfiles(bars, 'session');

  it('runs each POC until the first later bar that trades through it', () => {
    const levels = nakedPocLevels(bars, periods);
    expect(levels.map((l) => l.label)).toEqual(['nPOC Mon 19 Oct', 'nPOC Tue 20 Oct', 'nPOC Wed 21 Oct']);
    const [n1, n2, n3] = levels;
    expect(n1.from).toBe(d1 + 23 * H);
    expect(n1.until).toBe(d1 + 2 * DAY + 5 * H); // the sweep bar
    expect(n2.until).toBe(d1 + 2 * DAY); // day 3's first bar holds it
    expect(n3.until).toBeNull(); // still naked
    expect(n1.price).toBeGreaterThan(1.0995);
    expect(n1.price).toBeLessThan(1.1005);
  });

  it('never counts the period’s own bars as a touch, and skips the period still forming', () => {
    const forming = bars.slice(0, 24 + 24 + 10); // ends inside day 3
    const levels = nakedPocLevels(forming, periodProfiles(forming, 'session'));
    expect(levels.map((l) => l.period)).toEqual(['Mon 19 Oct', 'Tue 20 Oct']);
  });

  it('keeps only the most recent ones', () => {
    expect(nakedPocLevels(bars, periods, 1).map((l) => l.period)).toEqual(['Wed 21 Oct']);
    expect(nakedPocLevels(bars, periods, 0)).toEqual([]);
  });
});

describe('developing POC / VAH / VAL (PR-3)', () => {
  const t0 = Date.UTC(2026, 9, 19);
  // Six quiet bars low, then six heavy bars higher up: the POC must climb as the day develops.
  const bars = [
    ...Array.from({ length: 6 }, (_, i) => bar(t0 + i * H, 1.1, 1.101, 10)),
    ...Array.from({ length: 6 }, (_, i) => bar(t0 + (6 + i) * H, 1.104, 1.105, 100)),
    bar(t0 + DAY, 1.2, 1.201),
  ];
  const periods = periodProfiles(bars, 'session').slice(0, 1);

  it('has one point per bar, at the bar open', () => {
    const [d] = developingLevels(bars, periods);
    expect(d.t).toEqual(bars.slice(0, 12).map((b) => b.time));
    expect(d.period).toBe('Mon 19 Oct');
  });

  it('only knows the bars so far — the first point is the first bar alone', () => {
    const [d] = developingLevels(bars, periods);
    expect(d.vah[0]).toBeLessThanOrEqual(1.101);
    expect(d.val[0]).toBeGreaterThanOrEqual(1.1);
    expect(d.poc[5]).toBeLessThan(1.101);
    // The POC moves up once the heavy bars outweigh the quiet ones.
    expect(d.poc[11]).toBeGreaterThan(1.104);
  });

  it('ends exactly on the profile the overlay draws for the period', () => {
    const [d] = developingLevels(bars, periods);
    const p = periods[0].profile;
    expect(d.poc[d.poc.length - 1]).toBe(p.poc);
    expect(d.vah[d.vah.length - 1]).toBe(p.valueAreaHigh);
    expect(d.val[d.val.length - 1]).toBe(p.valueAreaLow);
  });
});
