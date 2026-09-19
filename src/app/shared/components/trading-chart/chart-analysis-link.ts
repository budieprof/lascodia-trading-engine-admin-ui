import type { TvResolution } from '@features/chart-analysis/datafeed/resolution';

/**
 * Translating the embedded trading chart's selection into a `/chart-analysis`
 * address.
 *
 * These two surfaces were built against different vocabularies and neither
 * half of the address can be passed through raw:
 *
 *  - **Symbol.** The embedded chart holds the slash display form ("EUR/USD");
 *    the route takes the engine form ("EURUSD").
 *  - **Timeframe.** Its pills are MT5 period codes ("H1"); that page speaks
 *    TradingView resolutions ("60").
 *
 * This lives in its own module rather than as a private member of the
 * component because the invariant worth guarding spans two features — every
 * pill must map to a resolution the chart-analysis DATAFEED can actually
 * serve. A test can only assert that by importing both sides, which it cannot
 * do through a component's private static.
 */

/**
 * The toolbar's timeframe pills.
 *
 * Defined here, beside the map they must agree with, rather than inline in the
 * component — co-locating them is what lets one spec assert that every pill an
 * operator can press leads somewhere the datafeed can serve. Split across two
 * files, adding a pill and forgetting the mapping is a silent fallback to H1.
 */
export const TIMEFRAME_PILLS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '1m', value: 'M1' },
  { label: '5m', value: 'M5' },
  { label: '15m', value: 'M15' },
  { label: '1H', value: 'H1' },
  { label: '4H', value: 'H4' },
  { label: '1D', value: 'D1' },
];

/** MT5 period code → TradingView resolution. Keyed by the pills above. */
export const TF_TO_RESOLUTION: Readonly<Record<string, TvResolution>> = {
  M1: '1',
  M5: '5',
  M15: '15',
  H1: '60',
  H4: '240',
  D1: '1D',
};

/**
 * Where an unmapped pill lands.
 *
 * Falling back beats routing to a resolution the datafeed cannot serve — that
 * would open an empty chart — but it is still the wrong chart, so the
 * accompanying spec fails rather than letting a new pill reach this quietly.
 */
export const FALLBACK_RESOLUTION: TvResolution = '60';

export interface ChartAnalysisTarget {
  /** Router link array: `['/chart-analysis', 'EURUSD']`. */
  commands: string[];
  /** Query params: `{ tf: '60' }`. */
  queryParams: { tf: TvResolution };
}

/**
 * Build the deep link for a slash-form symbol and an MT5 period code.
 *
 * `replace(/\//g, '')` rather than a single replace: nothing in the current
 * symbol list carries two slashes, but a crypto or index pair added later
 * could, and a half-stripped symbol would 404 in a way that looks like a
 * missing instrument rather than a formatting bug.
 */
export function chartAnalysisTarget(symbol: string, timeframe: string): ChartAnalysisTarget {
  return {
    commands: ['/chart-analysis', symbol.replace(/\//g, '').toUpperCase()],
    queryParams: { tf: TF_TO_RESOLUTION[timeframe] ?? FALLBACK_RESOLUTION },
  };
}
