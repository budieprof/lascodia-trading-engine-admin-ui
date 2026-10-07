import { describe, expect, it } from 'vitest';
import {
  bracket,
  periodLabel,
  pivotInputs,
  pivotLevels,
  pivotPeriodBars,
  pivotPeriodFor,
  yearBars,
  type PeriodBar,
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

/** A period bar as the engine sends it: its open and its exclusive close. */
function bar(
  time: number,
  closeTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): PeriodBar {
  return { time, closeTime, open, high, low, close, volume: 0 };
}

/**
 * The engine's session-grid bars around TradingView's 2026-10-04 screenshot (EDT: sessions open and
 * close at 21:00 UTC). A month opens with its first trading day's session — the evening before — and
 * closes with its last's.
 */
const MONTHLY = [
  // August: Mon 3 Aug's session opens Sun 2 Aug 21:00 UTC (1 Aug is a Saturday).
  bar(Date.UTC(2026, 7, 2, 21), Date.UTC(2026, 7, 31, 21), 1.1, 1.2, 1.0, 1.15),
  // September: Tue 1 Sep's session opens Mon 31 Aug 21:00 UTC; Wed 30 Sep closes it.
  bar(Date.UTC(2026, 7, 31, 21), Date.UTC(2026, 8, 30, 21), 1.16, 1.16541, 1.131181, 1.13294),
  // October, forming: Thu 1 Oct's session opens Wed 30 Sep 21:00 UTC.
  bar(Date.UTC(2026, 8, 30, 21), Date.UTC(2026, 9, 30, 21), 1.13292, 1.14, 1.12, 1.125),
];
/** Thu 1 Oct and Fri 2 Oct sessions. */
const DAILY = [
  bar(Date.UTC(2026, 8, 29, 21), Date.UTC(2026, 8, 30, 21), 1.145, 1.15, 1.131181, 1.13294),
  bar(Date.UTC(2026, 8, 30, 21), Date.UTC(2026, 9, 1, 21), 1.13292, 1.14, 1.13, 1.135),
  bar(Date.UTC(2026, 9, 1, 21), Date.UTC(2026, 9, 2, 21), 1.135, 1.138, 1.12, 1.125),
];

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

describe('pivotInputs (the engine’s period bars)', () => {
  it('takes the previous month and the current month’s open from the monthly bars', () => {
    // The 1D tab's newest bar is Fri 2 Oct's session (opened Thu 1 Oct 21:00 UTC): October.
    const r = pivotInputs(MONTHLY, Date.UTC(2026, 9, 1, 21));
    expect(r?.prev).toEqual({
      start: Date.UTC(2026, 7, 31, 21),
      closeTime: Date.UTC(2026, 8, 30, 21),
      open: 1.16,
      high: 1.16541,
      low: 1.131181,
      close: 1.13294,
    });
    expect(r?.currentOpen).toBe(1.13292);
    // These are the inputs TradingView's 27 printed levels come from (pivotLevels above).
    const levels = pivotLevels(r!.prev, r!.currentOpen);
    expect(levels.classic.P).toBeCloseTo(TRADINGVIEW.classic.P!, 5);
    expect(levels.woodie.P).toBeCloseTo(TRADINGVIEW.woodie.P!, 5);
  });

  it('a period opens with its first chart bar: October’s first session is October, not September', () => {
    // Thu 1 Oct's session opens on the evening of 30 Sep — its monthly bar opens at that instant.
    const r = pivotInputs(MONTHLY, Date.UTC(2026, 8, 30, 21));
    expect(r?.prev.start).toBe(Date.UTC(2026, 7, 31, 21));
  });

  it('uses the period of the newest bar: daily pivots on 2 Oct come from the 1 Oct session', () => {
    const r = pivotInputs(DAILY, Date.UTC(2026, 9, 2, 20, 55));
    // Sessions roll at 17:00 New York: 1 Oct's session opened 30 Sep 21:00 UTC.
    expect(r?.prev.start).toBe(Date.UTC(2026, 8, 30, 21));
    expect(r?.prev.close).toBe(1.135);
    expect(r?.currentOpen).toBe(1.135);
  });

  it('past the newest period’s close (no bar of the current period yet), that period is the previous', () => {
    const r = pivotInputs(DAILY, Date.UTC(2026, 9, 3, 12)); // Saturday, chart on a stale bar
    expect(r?.prev.start).toBe(Date.UTC(2026, 9, 1, 21));
    expect(r?.currentOpen).toBeNull();
  });

  it('returns null when there is no earlier period', () => {
    expect(pivotInputs(MONTHLY.slice(0, 1), Date.UTC(2026, 7, 10))).toBeNull();
    expect(pivotInputs(MONTHLY, Date.UTC(2026, 6, 1))).toBeNull();
  });

  it("reproduces TradingView's EURUSD daily pivots from the engine's 17:00 New York session", () => {
    // Thu 1 Oct closes at 21:00 UTC. Our broker's session: H 1.13368, L 1.12150, C 1.12443.
    // TradingView (FXCM) printed P 1.12645 from H 1.13367 / L 1.12150 / C 1.12418 — the same
    // boundary, a 2.5-pip feed difference in the close; with UTC-midnight days the close was 1.12482.
    const sessions = [
      bar(Date.UTC(2026, 8, 30, 21), Date.UTC(2026, 9, 1, 21), 1.133, 1.13368, 1.1215, 1.12443),
      bar(Date.UTC(2026, 9, 1, 21), Date.UTC(2026, 9, 2, 21), 1.12445, 1.12468, 1.12379, 1.12445),
    ];
    const r = pivotInputs(sessions, Date.UTC(2026, 9, 2, 20, 58));
    expect(r?.prev).toMatchObject({ high: 1.13368, low: 1.1215, close: 1.12443 });
    expect(r?.currentOpen).toBe(1.12445);
  });
});

describe('yearBars / pivotPeriodBars', () => {
  it("folds the engine's months into the years they close in — January opens on 31 December", () => {
    const months = [
      bar(Date.UTC(2024, 11, 1, 22), Date.UTC(2024, 11, 31, 22), 1.05, 1.07, 1.03, 1.04),
      // January 2025 opens Tue 31 Dec 2024 22:00 UTC (Wed 1 Jan is a trading day on the grid).
      bar(Date.UTC(2024, 11, 31, 22), Date.UTC(2025, 0, 31, 22), 1.04, 1.06, 1.01, 1.035),
      bar(Date.UTC(2025, 0, 31, 22), Date.UTC(2025, 1, 28, 22), 1.035, 1.09, 1.02, 1.08),
      bar(Date.UTC(2025, 11, 31, 22), Date.UTC(2026, 0, 30, 22), 1.17, 1.2, 1.16, 1.19),
    ];
    const years = yearBars(months);
    expect(years.map((y) => new Date(y.closeTime! - 1).getUTCFullYear())).toEqual([
      2024, 2025, 2026,
    ]);
    expect(years[1]).toMatchObject({
      time: Date.UTC(2024, 11, 31, 22),
      closeTime: Date.UTC(2025, 1, 28, 22),
      open: 1.04,
      high: 1.09,
      low: 1.01,
      close: 1.08,
    });
    // Yearly pivots in 2026 come from 2025.
    const r = pivotInputs(years, Date.UTC(2026, 0, 12, 22));
    expect(r?.prev.start).toBe(Date.UTC(2024, 11, 31, 22));
    expect(r?.currentOpen).toBe(1.17);
  });

  it('picks the engine’s days, weeks and months for their periods', () => {
    const src = { daily: DAILY, weekly: [] as PeriodBar[], monthly: MONTHLY };
    expect(pivotPeriodBars('day', src)).toBe(DAILY);
    expect(pivotPeriodBars('week', src)).toEqual([]);
    expect(pivotPeriodBars('month', src)).toBe(MONTHLY);
    expect(pivotPeriodBars('year', src)).toHaveLength(1);
  });
});

describe('periodLabel', () => {
  it('names days, months and years by the trading day they close on, weeks by their open', () => {
    // Thursday's session opens on Wednesday evening; September's month bar on 31 August's.
    expect(periodLabel('day', { start: DAILY[1].time, closeTime: DAILY[1].closeTime })).toBe(
      'Thu 1 Oct',
    );
    expect(periodLabel('month', { start: MONTHLY[1].time, closeTime: MONTHLY[1].closeTime })).toBe(
      'September 2026',
    );
    expect(
      periodLabel('year', {
        start: Date.UTC(2024, 11, 31, 22),
        closeTime: Date.UTC(2025, 11, 31, 22),
      }),
    ).toBe('2025');
    // The week of Monday 5 Oct opens on Sunday 4 Oct, 17:00 New York.
    expect(periodLabel('week', { start: Date.UTC(2026, 9, 4, 21) })).toBe('week of 4 Oct');
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
