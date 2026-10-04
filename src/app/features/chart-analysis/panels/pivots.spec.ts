import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import {
  bracket,
  periodLabel,
  periodStart,
  pivotInputs,
  pivotLevels,
  pivotPeriodFor,
  type PivotMethod,
  type PivotRow,
} from './pivots';

/**
 * TradingView's Technicals page, EURUSD (FXCM), "1 day" tab, 2026-10-04 — every
 * pivot it printed. One previous period reproduces all 27: September 2026 with
 * H 1.16541 / L 1.131181 / C 1.13294 (closing below its open), and October's
 * open 1.13292 for Woodie.
 */
const TRADINGVIEW: Record<PivotMethod, Partial<Record<PivotRow, number>>> = {
  classic: {
    R3: 1.21164,
    R2: 1.17741,
    R1: 1.15517,
    P: 1.14318,
    S1: 1.12094,
    S2: 1.10895,
    S3: 1.07472,
  },
  fibonacci: {
    R3: 1.17741,
    R2: 1.16433,
    R1: 1.15625,
    P: 1.14318,
    S1: 1.1301,
    S2: 1.12202,
    S3: 1.10895,
  },
  camarilla: {
    R3: 1.14235,
    R2: 1.13922,
    R1: 1.13608,
    P: 1.14318,
    S1: 1.1298,
    S2: 1.12666,
    S3: 1.12353,
  },
  woodie: {
    R3: 1.18426,
    R2: 1.17484,
    R1: 1.15003,
    P: 1.14061,
    S1: 1.11581,
    S2: 1.10638,
    S3: 1.08158,
  },
  dm: { R1: 1.14918, P: 1.14018, S1: 1.11495 },
};

const SEPT = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

function bar(time: number, open: number, high: number, low: number, close: number): Ohlc {
  return { time, open, high, low, close, volume: 0 };
}

describe('pivotLevels', () => {
  it('matches every level TradingView printed, to the fifth decimal', () => {
    const levels = pivotLevels(
      { start: SEPT, open: 1.16, high: 1.16541, low: 1.131181, close: 1.13294 },
      1.13292,
    );
    for (const [method, rows] of Object.entries(TRADINGVIEW) as [
      PivotMethod,
      Partial<Record<PivotRow, number>>,
    ][]) {
      for (const [row, value] of Object.entries(rows) as [PivotRow, number][]) {
        expect(levels[method][row], `${method} ${row}`).toBeCloseTo(value, 5);
      }
    }
  });

  it('leaves the levels DM does not define empty', () => {
    const dm = pivotLevels({ start: 0, open: 1, high: 2, low: 0.5, close: 1.5 }, null).dm;
    expect([dm.R3, dm.R2, dm.S2, dm.S3]).toEqual([null, null, null, null]);
  });

  it('picks DM by close against open', () => {
    const prev = { start: 0, high: 2, low: 1, close: 1.5 };
    expect(pivotLevels({ ...prev, open: 1.2 }, null).dm.P).toBeCloseTo((2 * 2 + 1 + 1.5) / 4);
    expect(pivotLevels({ ...prev, open: 1.8 }, null).dm.P).toBeCloseTo((2 + 2 * 1 + 1.5) / 4);
    expect(pivotLevels({ ...prev, open: 1.5 }, null).dm.P).toBeCloseTo((2 + 1 + 2 * 1.5) / 4);
  });

  it('falls back to the previous close for Woodie when the current period has no bar yet', () => {
    const prev = { start: 0, open: 1, high: 2, low: 1, close: 1.5 };
    expect(pivotLevels(prev, null).woodie.P).toBeCloseTo((2 + 1 + 2 * 1.5) / 4);
  });
});

describe('pivotPeriodFor', () => {
  it("follows TradingView's auto rule", () => {
    expect(['1', '5', '15'].map(pivotPeriodFor)).toEqual(['day', 'day', 'day']);
    expect(['30', '60', '120', '240'].map(pivotPeriodFor)).toEqual([
      'week',
      'week',
      'week',
      'week',
    ]);
    expect(pivotPeriodFor('1D')).toBe('month');
    expect(['1W', '1M'].map(pivotPeriodFor)).toEqual(['year', 'year']);
  });
});

describe('pivotInputs', () => {
  // September: one day per week-ish, enough to fold; October: two bars.
  const daily = [
    bar(SEPT - DAY, 1.1, 1.2, 1.0, 1.15), // 31 Aug — August
    bar(SEPT, 1.16, 1.165, 1.15, 1.155),
    bar(SEPT + 10 * DAY, 1.155, 1.16541, 1.14, 1.145),
    bar(SEPT + 29 * DAY, 1.145, 1.15, 1.131181, 1.13294), // 30 Sep
    bar(Date.UTC(2026, 9, 1), 1.13292, 1.14, 1.13, 1.135),
    bar(Date.UTC(2026, 9, 2), 1.135, 1.138, 1.12, 1.125),
  ];

  it('folds the previous month and takes the current month’s open', () => {
    const r = pivotInputs(daily, 'month', Date.UTC(2026, 9, 2, 20));
    expect(r?.prev).toEqual({
      start: SEPT,
      open: 1.16,
      high: 1.16541,
      low: 1.131181,
      close: 1.13294,
    });
    expect(r?.currentOpen).toBe(1.13292);
  });

  it('uses the period of the newest bar: daily pivots on 2 Oct come from 1 Oct', () => {
    const r = pivotInputs(daily, 'day', Date.UTC(2026, 9, 2, 20, 55));
    expect(r?.prev.start).toBe(Date.UTC(2026, 9, 1));
    expect(r?.prev.close).toBe(1.135);
  });

  it('returns null when there is no earlier period', () => {
    expect(pivotInputs(daily.slice(0, 1), 'month', SEPT - DAY)).toBeNull();
  });
});

describe('periodStart / periodLabel', () => {
  it('starts weeks on Sunday like the chart’s weekly bars, and years on 1 January', () => {
    const fri = Date.UTC(2026, 9, 2, 12);
    expect(new Date(periodStart('week', fri)).getUTCDay()).toBe(0);
    expect(periodStart('year', fri)).toBe(Date.UTC(2026, 0, 1));
    expect(periodLabel('month', SEPT)).toBe('September 2026');
    expect(periodLabel('year', Date.UTC(2025, 0, 1))).toBe('2025');
  });
});

describe('bracket', () => {
  it('finds the nearest level above and at-or-below the price', () => {
    const levels = pivotLevels(
      { start: 0, open: 1.16, high: 1.16541, low: 1.131181, close: 1.13294 },
      1.13292,
    );
    // TradingView's 1.12522 sits between classic S1 (1.12094) and P (1.14318).
    expect(bracket(levels.classic, 1.12522)).toEqual({ above: 'P', below: 'S1' });
    expect(bracket(levels.dm, 2)).toEqual({ above: null, below: 'R1' });
  });
});
