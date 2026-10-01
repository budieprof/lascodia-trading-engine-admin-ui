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
export function alignToBars(points: readonly PanePoint[], bars: readonly { time: number }[]): Maybe[] {
  const out: Maybe[] = new Array(bars.length).fill(null);
  let j = -1;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < points.length && points[j + 1].time <= bars[i].time) j++;
    out[i] = j >= 0 ? points[j].value : null;
  }
  return out;
}

/**
 * base − quote of two independently sampled step series: a point at every
 * instant either leg changes, from the first instant both are known.
 */
export function stepDifference(a: readonly PanePoint[], b: readonly PanePoint[]): PanePoint[] {
  const times = [...new Set([...a.map((p) => p.time), ...b.map((p) => p.time)])].sort((x, y) => x - y);
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
  const steps = swap.map((p) => ({ time: utcMs(p.timeUtc), l: p.longAnnualPct, s: p.shortAnnualPct }));
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
  | 'cot';

export interface FundamentalPaneInfo {
  id: FundamentalPaneId;
  title: string;
  available: boolean;
  endpoint: string | null;
  description: string;
}

export const FUNDAMENTAL_PANES: readonly FundamentalPaneInfo[] = [
  {
    id: 'rate-differential',
    title: 'Interest-rate differential',
    available: true,
    endpoint: 'GET /fx-fundamentals/carry?symbol=',
    description:
      'Base minus quote central-bank policy rate (percent), point in time: each step appears at the decision\'s ' +
      'release, never earlier. Built from the economic calendar\'s rate decisions (Fed upper bound, ECB deposit ' +
      'rate, BoE, BoJ, RBA, BoC, RBNZ, SNB). Blank before the calendar covers both currencies.',
  },
  {
    id: 'swap-carry',
    title: 'Swap / carry per lot',
    available: true,
    endpoint: 'GET /fx-fundamentals/carry?symbol=',
    description:
      'Overnight swap per standard lot (quote currency, long and short) from the policy-rate swap model: the ' +
      'differential in force less the broker\'s markup, calibrated once against today\'s broker swap. Positive is ' +
      'credited. Empty when the model cannot calibrate (no swap stored, swap-free quote, rate missing) — the reason is returned.',
  },
  {
    id: 'news-pressure',
    title: 'News pressure (base − quote)',
    available: true,
    endpoint: 'GET /news-intel/timeseries?currency=&hours=',
    description:
      'Difference of the two currencies\' decay-weighted news pressure scores ([−1, +1] each, + = currency-bullish) ' +
      'from the news-intelligence roll-ups (ADR-0024). History is capped at 30 days by the endpoint.',
  },
  {
    id: 'economic-surprise',
    title: 'Economic surprise index',
    available: true,
    endpoint: 'GET /fx-fundamentals/surprise-index?currency=&days=&halfLifeDays=',
    description:
      'Per currency: each release\'s surprise (actual − consensus) in standard deviations of its own series\' ' +
      'prior surprises, signed for the currency, clamped to ±3σ and summed with exponential decay (30-day half-life ' +
      'by default). Forecasts recorded before 2026-08-28 have unknown provenance; pass preReleaseOnly for a strictly ' +
      'point-in-time index.',
  },
  {
    id: 'cot',
    title: 'COT positioning',
    available: false,
    endpoint: null,
    description:
      'Not available: the engine has a COT table and an ingest endpoint, but no reports have been ingested (0 rows). ' +
      'Nothing is drawn rather than a fabricated series.',
  },
];
