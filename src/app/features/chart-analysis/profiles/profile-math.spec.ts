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
import { TradingCalendar } from '../datafeed/session-calendar';
import { vwap, vwapBands } from '../indicators/math';
import { anchoredVwap, volumeProfileRows } from '../drawings/tools/forecast-math';
import { profileWithValueArea } from '../overlays/analysis-overlays';
import { volumeProfile as volumeProfileOf, vwapRun } from './profile-math';

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
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
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
    const vp = volumeProfile([bar(T0, 1, 2, 1, 2, 100), bar(T0 + HOUR, 2, 2, 1, 1, 60)], {
      rows: 2,
    })!;
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
    expect(rowSum(vp)).toBeCloseTo(
      bars.slice(50, 101).reduce((a, b) => a + b.volume, 0),
      6,
    );
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
    expect(total).toBeCloseTo(
      bars.reduce((a, b) => a + b.volume, 0),
      6,
    );
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
    expect(t.singlePrints.map((i) => t.rows[i].letters[0])).toEqual(
      expect.arrayContaining(['A', 'B', 'D']),
    );
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

// FX trades from 17:00 New York to 17:00 New York (21:00 UTC on EDT): TradingView's session profiles,
// TPO and periodic profiles count those sessions, and so does every study here given the calendar.
describe('profiles on FX trading sessions', () => {
  const FX = new TradingCalendar({ session: '1700-1700:23456', timeZone: 'America/New_York' });
  // H1 from Mon 5 Oct 2026 18:00 UTC: Monday's session ends at 21:00, Tuesday's runs to Tue 21:00.
  const START = Date.UTC(2026, 9, 5, 18);
  const bars = walk(30, HOUR, START);

  it('a daily session profile spans 21:00 to 21:00 UTC, not midnight to midnight', () => {
    const s = sessionProfiles(bars, { session: 'daily', days: FX });
    expect(s.map((x) => x.startIdx)).toEqual([0, 3, 27]);
    expect(s[1].sessionStart).toBe(Date.UTC(2026, 9, 5, 21));
    // An explicit clock offset keeps its midnight-to-midnight day.
    const utcPlus3 = sessionProfiles(bars, { session: 'daily', tzOffsetMinutes: 180, days: FX });
    expect(utcPlus3[1].sessionStart).toBe(Date.UTC(2026, 9, 5, 21)); // 00:00 at UTC+3
    expect(
      sessionProfiles(bars, { session: 'daily', tzOffsetMinutes: 60, days: FX })[1].sessionStart,
    ).toBe(Date.UTC(2026, 9, 5, 23));
  });

  it('TPO letters count from the session’s open: A is 21:00–21:30 UTC', () => {
    const tp = tpoProfile(bars, { bracketMinutes: 30, rows: 20, days: FX });
    expect(tp.map((t) => t.sessionStart)).toEqual([
      Date.UTC(2026, 9, 4, 21),
      Date.UTC(2026, 9, 5, 21),
      Date.UTC(2026, 9, 6, 21),
    ]);
    // Tuesday's session: 24 hourly bars, one per even bracket → A, C, E … up to bracket 46.
    expect(tp[1].bracketCount).toBe(47);
  });

  it('periodic: the session opening Sunday evening is Monday’s week; a month turns at its first session', () => {
    const sunday = walk(6, HOUR, Date.UTC(2026, 9, 11, 19)); // Sun 19:00 … 00:00 UTC
    const weeks = periodicProfiles(sunday, { period: 'week', days: FX });
    // 19:00 and 20:00 still belong to the week that traded to Friday; 21:00 opens Monday's.
    expect(weeks.map((w) => w.startIdx)).toEqual([0, 2]);
    const month = walk(6, HOUR, Date.UTC(2026, 8, 30, 18)); // 30 Sep 18:00 … 23:00 UTC
    expect(periodicProfiles(month, { period: 'month', days: FX }).map((m) => m.startIdx)).toEqual([
      0, 3,
    ]);
    expect(periodicProfiles(month, { period: 'day', days: FX }).map((m) => m.startIdx)).toEqual([
      0, 3,
    ]);
  });

  it('auto-anchored “session” starts at the current session’s open, the evening before', () => {
    const vp = autoAnchoredProfile(bars, { anchor: 'session', days: FX })!;
    expect(bars[vp.fromIdx].time).toBe(Date.UTC(2026, 9, 6, 21));
    const tuesday = autoAnchoredProfile(bars.slice(0, 20), { anchor: 'session', days: FX })!;
    expect(bars[tuesday.fromIdx].time).toBe(Date.UTC(2026, 9, 5, 21));
  });

  it('computeProfileStudy passes the sessions on', () => {
    const m = computeProfileStudy('tpo', bars, {}, null, FX);
    expect(m.kind === 'tpo' && m.sessions[1].sessionStart).toBe(Date.UTC(2026, 9, 5, 21));
  });
});

// ── DR-19: one VWAP and one profile ────────────────────────────────────────────
describe('one VWAP for every caller (DR-19)', () => {
  const H = 3_600_000;
  const bar = (i: number, price: number, volume: number) => ({
    time: Date.UTC(2026, 8, 1) + i * H,
    open: price,
    high: price + 0.001,
    low: price - 0.001,
    close: price,
    volume,
  });
  // Two bars without volume, then traded bars, one more without volume in the middle.
  const bars = [
    bar(0, 1.1, 0),
    bar(1, 1.2, 0),
    bar(2, 1.3, 100),
    bar(3, 1.5, 300),
    bar(4, 9.9, 0),
    bar(5, 1.4, 100),
  ];

  it('is na until volume trades, and a bar without volume adds nothing', () => {
    const run = vwapRun(bars);
    expect(run.vwap.slice(0, 2)).toEqual([null, null]);
    expect(run.vwap[2]).toBeCloseTo(1.3, 12);
    expect(run.vwap[3]).toBeCloseTo((1.3 * 100 + 1.5 * 300) / 400, 12);
    expect(run.vwap[4]).toBeCloseTo(run.vwap[3] as number, 12); // the 9.9 bar had no volume
    expect(run.dev[2]).toBe(0); // a single bar deviates from nothing
  });

  it('the session VWAP, the VWAP bands and the anchored-VWAP drawing all give that answer', () => {
    const run = vwapRun(bars);
    expect(vwap(bars)).toEqual(run.vwap);
    expect(vwapBands(bars, 1, 2, 'Day').vwap).toEqual(run.vwap);
    const drawn = anchoredVwap(bars, bars[0].time);
    expect(drawn.map((p) => p.time)).toEqual(bars.slice(2).map((b) => b.time)); // no point before volume
    expect(drawn.map((p) => p.vwap)).toEqual(run.vwap.slice(2));
  });

  it('the overlay, the drawing tool and the study share one profile', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      bar(i, 1.1 + Math.sin(i / 3) * 0.01, 100 + i * 10),
    );
    const study = volumeProfileOf(many, { rows: 24 })!;
    const tool = volumeProfileRows(many, 24, 70)!;
    const overlay = profileWithValueArea(many, 24)!;
    expect(tool.rows.map((r) => r.total)).toEqual(study.rows.map((r) => r.upVol + r.downVol));
    expect(tool.poc).toBe(study.pocIndex);
    expect(overlay.poc).toBeCloseTo(study.poc, 12);
    expect(overlay.bins.map((b) => b.volume)).toEqual(study.rows.map((r) => r.upVol + r.downVol));
  });
});
