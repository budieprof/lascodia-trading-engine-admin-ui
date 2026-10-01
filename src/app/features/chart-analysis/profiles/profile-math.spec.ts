import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import {
  autoAnchoredProfile,
  fixedRangeProfile,
  periodicProfiles,
  sessionProfiles,
  sessionStartOf,
  tpoLetter,
  tpoProfile,
  valueAreaIndices,
  visibleRangeProfile,
  volumeProfile,
} from './profile-math';
import { PROFILE_STUDIES, computeProfileStudy } from './profile-studies';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 1); // Tue 2026-09-01 00:00 UTC

function bar(t: number, o: number, h: number, l: number, c: number, v = 100): Ohlc {
  return { time: t, open: o, high: h, low: l, close: c, volume: v };
}

function rowSum(vp: { rows: { upVol: number; downVol: number }[] }): number {
  return vp.rows.reduce((a, r) => a + r.upVol + r.downVol, 0);
}

// Deterministic pseudo-random walk.
function walk(n: number, stepMs = HOUR, start = T0): Ohlc[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let p = 1.1;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    const c = o + (rnd() - 0.5) * 0.004;
    const h = Math.max(o, c) + rnd() * 0.002;
    const l = Math.min(o, c) - rnd() * 0.002;
    p = c;
    return bar(start + i * stepMs, o, h, l, c, Math.round(50 + rnd() * 500));
  });
}

describe('volumeProfile', () => {
  it('conserves volume (rows and tickSize grids)', () => {
    const bars = walk(300);
    const total = bars.reduce((a, b) => a + b.volume, 0);
    for (const opts of [{ rows: 24 }, { rows: 7 }, { tickSize: 0.0005 }, { tickSize: 0.0001 }]) {
      const vp = volumeProfile(bars, opts)!;
      expect(rowSum(vp)).toBeCloseTo(total, 6);
      expect(vp.totalVolume).toBe(total);
    }
  });

  it('distributes volume across the high-low range, not the close', () => {
    // One bar 1.0–2.0, 4 rows → 25 each.
    const vp = volumeProfile([bar(T0, 1, 2, 1, 2, 100)], { rows: 4 })!;
    vp.rows.forEach((r) => expect(r.upVol).toBeCloseTo(25, 9));
  });

  it('splits up/down by bar direction', () => {
    const vp = volumeProfile([bar(T0, 1, 2, 1, 2, 100), bar(T0 + HOUR, 2, 2, 1, 1, 60)], { rows: 2 })!;
    expect(vp.rows[0].upVol).toBeCloseTo(50);
    expect(vp.rows[0].downVol).toBeCloseTo(30);
    const flat = volumeProfile([bar(T0, 2, 2, 1, 1, 60)], { rows: 2, upDown: false })!;
    expect(flat.rows[0].downVol).toBe(0);
  });

  it('finds POC and a 70% value area around it', () => {
    // Concentrated volume at 1.5 plus a thin wide bar.
    const bars = [bar(T0, 1, 2, 1, 2, 10), bar(T0 + HOUR, 1.5, 1.5, 1.5, 1.5, 100)];
    const vp = volumeProfile(bars, { rows: 10 })!;
    expect(vp.poc).toBeCloseTo(1.55, 9);
    expect(vp.val).toBeLessThanOrEqual(1.5);
    expect(vp.vah).toBeGreaterThanOrEqual(1.6);
    const inVa = vp.rows
      .filter((r) => r.priceLow >= vp.val - 1e-9 && r.priceHigh <= vp.vah + 1e-9)
      .reduce((a, r) => a + r.upVol + r.downVol, 0);
    expect(inVa / vp.totalVolume).toBeGreaterThanOrEqual(0.7);
  });

  it('value area expansion picks the heavier side', () => {
    expect(valueAreaIndices([1, 5, 10, 2, 1], 2, 70)).toEqual([1, 2]);
    expect(valueAreaIndices([1, 1, 10, 1, 1], 2, 100)).toEqual([0, 4]);
  });

  it('returns null for empty / zero-volume input', () => {
    expect(volumeProfile([])).toBeNull();
    expect(volumeProfile([bar(T0, 1, 2, 1, 1, 0)])).toBeNull();
  });
});

describe('range profiles', () => {
  const bars = walk(200);
  it('visible range covers only the requested bars', () => {
    const vp = visibleRangeProfile(bars, 50.4, 99.6, { rows: 20 })!;
    expect(vp.fromIdx).toBe(50);
    expect(vp.toIdx).toBe(100);
    expect(rowSum(vp)).toBeCloseTo(bars.slice(50, 101).reduce((a, b) => a + b.volume, 0), 6);
  });

  it('fixed range by time', () => {
    const vp = fixedRangeProfile(bars, bars[120].time, bars[10].time)!;
    expect([vp.fromIdx, vp.toIdx]).toEqual([10, 120]);
  });

  it('auto-anchors at the highest high / lowest low / session', () => {
    const hh = autoAnchoredProfile(bars, { anchor: 'highestHigh', lookback: 80 })!;
    const window = bars.slice(120);
    const max = Math.max(...window.map((b) => b.high));
    expect(bars[hh.fromIdx].high).toBe(max);
    expect(hh.toIdx).toBe(199);
    const ll = autoAnchoredProfile(bars, { anchor: 'lowestLow', lookback: 80 })!;
    expect(bars[ll.fromIdx].low).toBe(Math.min(...window.map((b) => b.low)));
    const ses = autoAnchoredProfile(bars, { anchor: 'session' })!;
    expect(new Date(bars[ses.fromIdx].time).getUTCHours()).toBe(0);
  });
});

describe('session splitting', () => {
  it('daily sessions follow the tz offset across midnight', () => {
    const bars = walk(48); // 2 UTC days of H1
    expect(sessionProfiles(bars, { session: 'daily' }).map((s) => s.startIdx)).toEqual([0, 24]);
    // Clock at UTC+3: day boundary at 21:00 UTC.
    const s3 = sessionProfiles(bars, { session: 'daily', tzOffsetMinutes: 180 });
    expect(s3.map((s) => s.startIdx)).toEqual([0, 21, 45]);
    expect(s3[1].sessionStart).toBe(T0 + 21 * HOUR);
    const total = s3.reduce((a, s) => a + rowSum(s.profile), 0);
    expect(total).toBeCloseTo(bars.reduce((a, b) => a + b.volume, 0), 6);
  });

  it('asia wraps midnight into one session', () => {
    const bars = walk(48, HOUR, T0 - 2 * HOUR); // starts 22:00 UTC
    const asia = sessionProfiles(bars, { session: 'asia' });
    // 23:00..07:00 = 9 bars.
    expect(asia[0].endIdx - asia[0].startIdx + 1).toBe(9);
    expect(asia[0].sessionStart).toBe(T0 - HOUR);
    expect(sessionStartOf(T0 + 3 * HOUR, 'asia')).toBe(T0 - HOUR);
    expect(sessionStartOf(T0 + 10 * HOUR, 'asia')).toBeNull();
    const ldn = sessionProfiles(bars, { session: 'london' });
    expect(ldn[0].profile.t0).toBe(T0 + 7 * HOUR);
    expect(ldn[0].endIdx - ldn[0].startIdx + 1).toBe(9);
  });

  it('periodic week/month boundaries', () => {
    const bars = walk(24 * 40); // 40 days from Tue 1 Sep
    const weeks = periodicProfiles(bars, { period: 'week' });
    expect(new Date(weeks[1].profile.t0).getUTCDay()).toBe(1); // Monday
    const months = periodicProfiles(bars, { period: 'month' });
    expect(months.length).toBe(2);
    expect(months[1].profile.t0).toBe(Date.UTC(2026, 9, 1));
  });
});

describe('tpoProfile', () => {
  it('letters per bracket, POC, IB and single prints', () => {
    // 30m bars: A 1.0–1.4, B 1.2–1.6, C 1.2–1.4, D 1.9–2.0 (gap above).
    const b = [
      bar(T0, 1.0, 1.4, 1.0, 1.4),
      bar(T0 + 30 * MIN, 1.4, 1.6, 1.2, 1.3),
      bar(T0 + 60 * MIN, 1.3, 1.4, 1.2, 1.3),
      bar(T0 + 90 * MIN, 1.9, 2.0, 1.9, 2.0),
    ];
    const [t] = tpoProfile(b, { bracketMinutes: 30, tickSize: 0.1 });
    const at = (p: number) => t.rows.find((r) => p >= r.priceLow - 1e-9 && p < r.priceHigh - 1e-9)!;
    expect(at(1.25).letters).toEqual(['A', 'B', 'C']);
    expect(at(1.05).letters).toEqual(['A']);
    expect(at(1.55).letters).toEqual(['B']);
    expect(at(1.95).letters).toEqual(['D']);
    expect(at(1.75).letters).toEqual([]);
    expect(t.poc).toBeGreaterThan(1.2);
    expect(t.poc).toBeLessThan(1.4);
    expect(t.ibHigh).toBe(1.6);
    expect(t.ibLow).toBe(1.0);
    expect(t.bracketCount).toBe(4);
    expect(t.singlePrints.map((i) => t.rows[i].letters[0])).toEqual(expect.arrayContaining(['A', 'B', 'D']));
  });

  it('several 5m bars within one bracket share a letter; days split', () => {
    const bars = walk(2 * 288, 5 * MIN);
    const tp = tpoProfile(bars, { bracketMinutes: 30, rows: 30 });
    expect(tp.length).toBe(2);
    expect(tp[0].bracketCount).toBe(48);
    for (const r of tp[0].rows) expect(new Set(r.letters).size).toBe(r.letters.length);
  });

  it('letter sequence', () => {
    expect([0, 1, 25, 26, 51, 52].map(tpoLetter)).toEqual(['A', 'B', 'Z', 'a', 'z', 'A']);
  });
});

describe('profile studies catalogue', () => {
  const bars = walk(24 * 10);
  it('every study computes and VP descriptions mention tick volume', () => {
    for (const s of PROFILE_STUDIES) {
      const m = computeProfileStudy(s.id, bars, {}, { from: 10, to: 100 });
      if (m.kind === 'volume') {
        expect(m.blocks.length).toBeGreaterThan(0);
        expect(s.description).toContain('(tick volume)');
      } else expect(m.sessions.length).toBe(10);
    }
    const sess = computeProfileStudy('vp-session', bars, { session: 'london' });
    expect(sess.kind === 'volume' && sess.blocks.length).toBe(10);
  });
});
