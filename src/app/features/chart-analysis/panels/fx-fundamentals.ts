/**
 * FX fundamentals — wire types for the engine endpoints and pure helpers that
 * turn them into pane series. No Angular here (tested directly).
 *
 * A "pane series" is a step series: each point's value holds until the next
 * point (a policy rate in force, a pressure roll-up, an index after a release).
 * `alignToBars` resamples one onto chart bars the way the indicator registry
 * expects — one value per bar, `null` before the first known point (never
 * zero-filled: zero is a real reading for every one of these).
 */
import type { Maybe } from '../indicators/math';

/** One point, `time` in ms UTC (the chart's Bar convention). */
export interface PanePoint {
  time: number;
  value: number;
}

// ── Engine wire shapes (camelCase JSON of the C# records) ───────────────────

/** GET /fx-fundamentals/carry?symbol= → data.differential[] */
export interface RateDifferentialPointDto {
  timeUtc: string;
  baseRatePct: number;
  quoteRatePct: number;
  differentialPct: number;
}

/** Annual interest on the price, %, 360-day year, broker sign (+ = credited). */
export interface CarrySwapPointDto {
  timeUtc: string;
  longAnnualPct: number;
  shortAnnualPct: number;
}

export interface CarrySwapDto {
  calibrated: boolean;
  issue: string | null;
  source: string | null;
  unit: string;
  brokerSwapLong: number;
  brokerSwapShort: number;
  contractSize: number;
  referencePrice: number | null;
  markupLongPct: number | null;
  markupShortPct: number | null;
  brokerLongAnnualPct: number | null;
  brokerShortAnnualPct: number | null;
  points: CarrySwapPointDto[];
}

export interface CarrySeriesDto {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  baseRateSource: string | null;
  quoteRateSource: string | null;
  differential: RateDifferentialPointDto[];
  /** Null when no broker swap is stored for the symbol. */
  swap: CarrySwapDto | null;
}

/** GET /fx-fundamentals/surprise-index?currency= → data */
export interface SurpriseIndexPointDto {
  timeUtc: string;
  eventId: number;
  title: string;
  signedSurprise: number;
  index: number;
}

export interface SurpriseIndexDto {
  currency: string;
  halfLifeDays: number;
  preReleaseForecastsOnly: boolean;
  releasesConsidered: number;
  releasesScored: number;
  points: SurpriseIndexPointDto[];
}

/** GET /news-intel/timeseries?currency=&hours= → data[] (existing endpoint). */
export interface NewsPressurePointDto {
  asOfUtc: string;
  weightedScore: number;
  absolutePressure: number;
  articleCount: number;
  paramsFingerprint: string | null;
  liveShare: number | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Engine timestamps are UTC; tolerate a missing `Z`. */
export function utcMs(iso: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

/** Step-hold resample onto bars (ascending `time`, ms). */
export function alignToBars(
  points: readonly PanePoint[],
  bars: readonly { time: number }[],
): Maybe[] {
  const out: Maybe[] = new Array(bars.length).fill(null);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < points.length && points[j + 1].time <= bars[i].time) j++;
    out[i] = j >= 0 ? points[j].value : null;
  }
  return out;
}

/**
 * Points SUMMED per bar (UA03: liquidations per minute → per bar): each point counts in the bar whose open is the
 * latest at or before it (the last bar takes everything after its open); points before the first bar are dropped.
 * A bar with no point is 0 — for a summed flow, a minute without liquidations is a real zero, unlike a level.
 * Bars before the first point are null (nothing was read there).
 */
export function sumToBars(
  points: readonly PanePoint[],
  bars: readonly { time: number }[],
): Maybe[] {
  const out: Maybe[] = new Array(bars.length).fill(null);
  if (!points.length || !bars.length) return out;
  const first = points[0].time;
  let j = 0;
  for (let i = 0; i < bars.length; i++) {
    const end = i + 1 < bars.length ? bars[i + 1].time : Infinity;
    if (end <= first) continue;
    let sum = 0;
    while (j < points.length && points[j].time < bars[i].time) j++;
    while (j < points.length && points[j].time < end) sum += points[j++].value;
    out[i] = sum;
  }
  return out;
}

/**
 * base − quote of two independently sampled step series: a point at every
 * instant either leg changes, from the first instant both are known.
 */
export function stepDifference(a: readonly PanePoint[], b: readonly PanePoint[]): PanePoint[] {
  const times = [...new Set([...a.map((p) => p.time), ...b.map((p) => p.time)])].sort(
    (x, y) => x - y,
  );
  const out: PanePoint[] = [];
  let i = -1;
  let j = -1;
  for (const t of times) {
    while (i + 1 < a.length && a[i + 1].time <= t) i++;
    while (j + 1 < b.length && b[j + 1].time <= t) j++;
    if (i >= 0 && j >= 0) out.push({ time: t, value: a[i].value - b[j].value });
  }
  return out;
}

/**
 * Swap per standard lot per night, in QUOTE currency, at each daily bar:
 * annual% / 100 / 360 × close × contract size, the annual % being the modelled
 * swap in force at that bar. Sign is the broker's (+ = credited, − = charged).
 * Bars before the first swap point are omitted. Triple-swap days are NOT
 * tripled here — this is the nightly rate, not a booking.
 */
export function swapPerLotSeries(
  swap: readonly CarrySwapPointDto[],
  contractSize: number,
  dailyBars: readonly { time: number; close: number }[],
): { long: PanePoint[]; short: PanePoint[] } {
  const steps = swap.map((p) => ({
    time: utcMs(p.timeUtc),
    l: p.longAnnualPct,
    s: p.shortAnnualPct,
  }));
  const long: PanePoint[] = [];
  const short: PanePoint[] = [];
  let j = -1;
  for (const bar of dailyBars) {
    while (j + 1 < steps.length && steps[j + 1].time <= bar.time) j++;
    if (j < 0 || !(bar.close > 0)) continue;
    const k = (bar.close * contractSize) / 100 / 360;
    long.push({ time: bar.time, value: steps[j].l * k });
    short.push({ time: bar.time, value: steps[j].s * k });
  }
  return { long, short };
}

// ── Explanatory list ────────────────────────────────────────────────────────

export type FundamentalPaneId =
  | 'rate-differential'
  | 'swap-carry'
  | 'news-pressure'
  | 'economic-surprise'
  | 'cot'
  // UA03: market panes (`market-panes.ts`), offered where their data can exist.
  | 'funding-rate'
  | 'open-interest'
  | 'basis'
  | 'liquidations'
  | 'term-structure'
  | 'funding-times';

export interface FundamentalPaneInfo {
  id: FundamentalPaneId;
  title: string;
  available: boolean;
  endpoint: string | null;
  description: string;
  /** The dialog's group: the FX panes, or the market (derivatives / futures / positioning) panes. */
  group?: 'FX fundamentals' | 'Market data';
}

export const FUNDAMENTAL_PANES: readonly FundamentalPaneInfo[] = [
  {
    id: 'rate-differential',
    title: 'Interest-rate differential',
    available: true,
    endpoint: 'GET /fx-fundamentals/carry?symbol=',
    description:
      "Base minus quote central-bank policy rate (percent), point in time: each step appears at the decision's " +
      "release, never earlier. Built from the economic calendar's rate decisions (Fed upper bound, ECB deposit " +
      'rate, BoE, BoJ, RBA, BoC, RBNZ, SNB). Blank before the calendar covers both currencies.',
  },
  {
    id: 'swap-carry',
    title: 'Swap / carry per lot',
    available: true,
    endpoint: 'GET /fx-fundamentals/carry?symbol=',
    description:
      'Overnight swap per standard lot (quote currency, long and short) from the policy-rate swap model: the ' +
      "differential in force less the broker's markup, calibrated once against today's broker swap. Positive is " +
      'credited. Empty when the model cannot calibrate (no swap stored, swap-free quote, rate missing) — the reason is returned.',
  },
  {
    id: 'news-pressure',
    title: 'News pressure (base − quote)',
    available: true,
    endpoint: 'GET /news-intel/timeseries?currency=&hours=',
    description:
      "Difference of the two currencies' decay-weighted news pressure scores ([−1, +1] each, + = currency-bullish) " +
      'from the news-intelligence roll-ups (ADR-0024). History is capped at 30 days by the endpoint.',
  },
  {
    id: 'economic-surprise',
    title: 'Economic surprise index',
    available: true,
    endpoint: 'GET /fx-fundamentals/surprise-index?currency=&days=&halfLifeDays=',
    description:
      "Per currency: each release's surprise (actual − consensus) in standard deviations of its own series' " +
      'prior surprises, signed for the currency, clamped to ±3σ and summed with exponential decay (30-day half-life ' +
      'by default). Forecasts recorded before 2026-08-28 have unknown provenance; pass preReleaseOnly for a strictly ' +
      'point-in-time index.',
  },
  {
    id: 'cot',
    title: 'COT positioning',
    available: true,
    group: 'Market data',
    endpoint: 'POST /sentiment/cot/list',
    description:
      'CFTC Commitments of Traders: net non-commercial (speculative) positioning per weekly report, for each currency ' +
      'of an FX pair or currency future (contracts). Reports are dated Tuesday and published Friday; a currency the ' +
      'engine has not ingested draws nothing and says so.',
  },
  {
    id: 'funding-rate',
    title: 'Funding rate',
    available: true,
    group: 'Market data',
    endpoint: 'GET /md/crypto/derivatives?symbol=&sourceId=',
    description:
      "Crypto perpetuals: the venue's funding rate, percent per funding interval, per minute it was reported (the last " +
      '28 days at most). Positive: longs pay shorts.',
  },
  {
    id: 'open-interest',
    title: 'Open interest',
    available: true,
    group: 'Market data',
    endpoint: 'GET /md/crypto/derivatives?symbol=&sourceId=',
    description:
      "Crypto perpetuals: open interest in the venue's unit, and its percent change over the window you set. Needs " +
      'the engine to persist derivatives minutes.',
  },
  {
    id: 'basis',
    title: 'Basis / premium',
    available: true,
    group: 'Market data',
    endpoint: 'GET /md/crypto/derivatives · GET /md/basis',
    description:
      'Crypto perpetuals: (mark − index) / index, percent. FX majors: the CME future − spot basis in price (rolling ' +
      'median of paired quotes), the last 7 days.',
  },
  {
    id: 'liquidations',
    title: 'Liquidations',
    available: true,
    group: 'Market data',
    endpoint: 'GET /md/crypto/derivatives?symbol=&sourceId=',
    description:
      'Crypto perpetuals: liquidated notional per bar in the quote currency — buy side (shorts closed) and sell side ' +
      "(longs closed), summed from the venue's liquidation stream.",
  },
  {
    id: 'funding-times',
    title: 'Funding times',
    available: true,
    group: 'Market data',
    endpoint: 'GET /md/crypto/derivatives?symbol=&sourceId=',
    description:
      'Crypto perpetuals: a bar at each funding instant the venue reported (its own schedule — hourly on some venues, ' +
      'every 8 hours on others), sized by the rate charged, percent per interval.',
  },
  {
    id: 'term-structure',
    title: 'Term structure (roll yield)',
    available: true,
    group: 'Market data',
    endpoint: 'GET /futures/statistics?root= · GET /instrument-fundamentals/futures/{root}',
    description:
      "Futures: the front two contracts' settlements per trading date as an annualised roll yield, percent — " +
      'positive in backwardation, negative in contango. Needs exchange settlement statistics for the root.',
  },
];
