import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { gaugePosition, technicalRating, ratingLabel } from './technicals';
import { dayOfYear, performanceTiles, seasonalYears, type DailyBar } from './performance';
import { alignToBars, stepDifference, swapPerLotSeries } from './fx-fundamentals';

const DAY = 86_400_000;

function trend(n: number, step: number, start = 100): Ohlc[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step + Math.sin(i / 3) * Math.abs(step) * 0.3;
    return {
      time: i * DAY,
      open: c - step / 2,
      high: c + Math.abs(step),
      low: c - Math.abs(step),
      close: c,
      volume: 1000,
    };
  });
}

function daily(
  fromUtc: number,
  toUtc: number,
  price: (t: number, i: number) => number,
): DailyBar[] {
  const out: DailyBar[] = [];
  for (let t = fromUtc, i = 0; t <= toUtc; t += DAY, i++) {
    const c = price(t, i);
    out.push({ time: t, open: c, close: c });
  }
  return out;
}

describe('technicalRating', () => {
  it('rates a steady uptrend as a buy with every moving average voting buy', () => {
    const r = technicalRating(trend(260, 0.5));
    expect(r.movingAverages.sell).toBe(0);
    expect(r.movingAverages.buy).toBe(r.movingAverages.votes.length);
    expect(r.movingAverages.label).toBe('Strong buy');
    expect(r.summary.rating).toBeGreaterThan(0.1);
    expect(['Buy', 'Strong buy']).toContain(r.summary.label);
    expect(r.summary.buy + r.summary.neutral + r.summary.sell).toBe(
      r.movingAverages.buy +
        r.movingAverages.neutral +
        r.movingAverages.sell +
        r.oscillators.buy +
        r.oscillators.neutral +
        r.oscillators.sell,
    );
  });

  it('rates a steady downtrend as a sell', () => {
    const r = technicalRating(trend(260, -0.5, 300));
    expect(r.movingAverages.label).toBe('Strong sell');
    expect(['Sell', 'Strong sell']).toContain(r.summary.label);
  });

  it('does not count warm-up indicators: 50 bars leave SMA/EMA 100 and 200 out', () => {
    const r = technicalRating(trend(50, 0.5));
    const counted = r.movingAverages.buy + r.movingAverages.neutral + r.movingAverages.sell;
    expect(counted).toBeLessThan(r.movingAverages.votes.length);
    expect(r.movingAverages.votes.find((v) => v.name === 'SMA (200)')?.value).toBeNull();
  });

  it('is neutral with zero voters on empty input', () => {
    const r = technicalRating([]);
    expect(r.summary).toEqual({ rating: 0, label: 'Neutral', buy: 0, neutral: 0, sell: 0 });
  });

  it('bands labels like TradingView', () => {
    expect(ratingLabel(-0.5)).toBe('Strong sell');
    expect(ratingLabel(-0.2)).toBe('Sell');
    expect(ratingLabel(0.1)).toBe('Neutral');
    expect(ratingLabel(0.3)).toBe('Buy');
    expect(ratingLabel(0.5)).toBe('Strong buy');
  });
});

describe('gaugePosition', () => {
  const LABELS = ['Strong sell', 'Sell', 'Neutral', 'Buy', 'Strong buy'];

  it('points the needle at the segment its label names, across every band', () => {
    for (let i = -100; i <= 100; i++) {
      const r = i / 100;
      // Band edges sit exactly on segment boundaries; either side is right there.
      if ([-50, -10, 10, 50].includes(i)) continue;
      const segment = Math.min(4, Math.floor(gaugePosition(r) * 5));
      expect(LABELS[segment], `rating ${r}`).toBe(ratingLabel(r));
    }
  });

  it('keeps Sell off the Neutral segment where a linear dial would put it', () => {
    expect(ratingLabel(-0.15)).toBe('Sell');
    expect(gaugePosition(-0.15)).toBeLessThan(0.4);
  });

  it('is monotonic, spans the dial, and centres a dead-neutral reading', () => {
    expect(gaugePosition(-1)).toBe(0);
    expect(gaugePosition(1)).toBe(1);
    expect(gaugePosition(0)).toBeCloseTo(0.5);
    for (let i = -100; i < 100; i++) {
      expect(gaugePosition((i + 1) / 100)).toBeGreaterThan(gaugePosition(i / 100));
    }
  });

  it('clamps out-of-range and non-finite ratings', () => {
    expect(gaugePosition(-3)).toBe(0);
    expect(gaugePosition(3)).toBe(1);
    expect(gaugePosition(Number.NaN)).toBe(0.5);
  });
});

describe('performanceTiles', () => {
  it('compares the latest close with the close at or before each anchor', () => {
    // 2025-01-01 .. 2026-06-30, price = day index + 100.
    const bars = daily(Date.UTC(2025, 0, 1), Date.UTC(2026, 5, 30), (_t, i) => 100 + i);
    const latest = bars[bars.length - 1].close;
    const at = (t: number) => bars.find((b) => b.time === t)!.close;
    const tiles = Object.fromEntries(performanceTiles(bars).map((t) => [t.period, t]));

    expect(tiles['1W'].pct).toBeCloseTo(
      ((latest - at(Date.UTC(2026, 5, 23))) / at(Date.UTC(2026, 5, 23))) * 100,
      10,
    );
    expect(tiles['1M'].fromTime).toBe(Date.UTC(2026, 4, 30));
    expect(tiles['6M'].fromTime).toBe(Date.UTC(2025, 11, 30));
    // YTD = since the previous year's last close (Dec 31).
    expect(tiles['YTD'].fromTime).toBe(Date.UTC(2025, 11, 31));
    expect(tiles['YTD'].pct).toBeCloseTo(
      ((latest - at(Date.UTC(2025, 11, 31))) / at(Date.UTC(2025, 11, 31))) * 100,
      10,
    );
    expect(tiles['1Y'].fromTime).toBe(Date.UTC(2025, 5, 30));
  });

  it('nulls a period the history does not reach instead of shortening it', () => {
    const bars = daily(Date.UTC(2026, 3, 1), Date.UTC(2026, 5, 30), () => 1);
    const tiles = Object.fromEntries(performanceTiles(bars).map((t) => [t.period, t.pct]));
    expect(tiles['1M']).toBe(0);
    expect(tiles['6M']).toBeNull();
    expect(tiles['1Y']).toBeNull();
    expect(tiles['YTD']).toBeNull();
  });

  it('handles weekend gaps (anchor on a Saturday uses Friday)', () => {
    // Bars only on 2026-06-05 (Fri) and 2026-06-12 (Fri).
    const bars: DailyBar[] = [
      { time: Date.UTC(2026, 5, 5), open: 1, close: 1 },
      { time: Date.UTC(2026, 5, 12), open: 1.1, close: 1.1 },
    ];
    const w = performanceTiles(bars).find((t) => t.period === '1W')!;
    expect(w.pct).toBeCloseTo(10, 10);
  });
});

describe('seasonalYears', () => {
  const bars = daily(
    Date.UTC(2023, 6, 1),
    Date.UTC(2026, 2, 31),
    (t) => 100 + (t - Date.UTC(2023, 6, 1)) / DAY,
  );

  it('returns the latest year and two prior, newest first, aligned on day-of-year', () => {
    const ys = seasonalYears(bars, 2);
    expect(ys.map((y) => y.year)).toEqual([2026, 2025, 2024]);
    for (const y of ys) {
      expect(y.points[0].day).toBe(0);
      expect(y.points.every((p, i) => i === 0 || p.day > y.points[i - 1].day)).toBe(true);
    }
    // 2026 is partial: ends on Mar 31 (day 89).
    expect(ys[0].points[ys[0].points.length - 1].day).toBe(89);
    // 2024 is a leap year: Dec 31 is day 365.
    expect(ys[2].points[ys[2].points.length - 1].day).toBe(365);
  });

  it('bases each year on the previous year-end close', () => {
    const [y2026] = seasonalYears(bars, 0);
    const dec31 = bars.find((b) => b.time === Date.UTC(2025, 11, 31))!.close;
    const jan1 = bars.find((b) => b.time === Date.UTC(2026, 0, 1))!.close;
    expect(y2026.points[0].pct).toBeCloseTo(((jan1 - dec31) / dec31) * 100, 10);
  });

  it('falls back to the first open when the prior year is missing', () => {
    const ys = seasonalYears(bars, 5);
    const first = ys[ys.length - 1];
    expect(first.year).toBe(2023);
    expect(first.points[0].pct).toBe(0);
    expect(first.points[0].day).toBe(dayOfYear(Date.UTC(2023, 6, 1)));
  });
});

describe('fx-fundamentals helpers', () => {
  it('step-holds points onto bars with null before the first point', () => {
    const v = alignToBars(
      [
        { time: 10, value: 1 },
        { time: 30, value: 2 },
      ],
      [{ time: 5 }, { time: 10 }, { time: 20 }, { time: 30 }, { time: 40 }],
    );
    expect(v).toEqual([null, 1, 1, 2, 2]);
  });

  it('differences two independently sampled series from the first time both are known', () => {
    const d = stepDifference(
      [
        { time: 0, value: 0.5 },
        { time: 20, value: 0.1 },
      ],
      [{ time: 10, value: 0.2 }],
    );
    expect(d.map((p) => p.time)).toEqual([10, 20]);
    expect(d[0].value).toBeCloseTo(0.3, 10);
    expect(d[1].value).toBeCloseTo(-0.1, 10);
  });

  it('prices swap per lot per night at each daily close', () => {
    const { long, short } = swapPerLotSeries(
      [{ timeUtc: '1970-01-02T00:00:00Z', longAnnualPct: 3.6, shortAnnualPct: -7.2 }],
      100_000,
      [
        { time: 0, close: 1 },
        { time: DAY, close: 1 },
      ],
    );
    expect(long).toEqual([{ time: DAY, value: 10 }]); // 3.6% / 360 × 1 × 100k
    expect(short[0].value).toBeCloseTo(-20, 10);
  });
});
