import {
  adl,
  adx,
  alligator,
  bandwidth,
  coppock,
  kst,
  percentB,
  ppo,
  rvi,
  schaff,
  standardErrorBands,
  volumeIndices,
  volumeOscillator,
  alma,
  aroon,
  atr,
  awesome,
  balanceOfPower,
  chaikinOscillator,
  choppiness,
  cmf,
  dema,
  dpo,
  easeOfMovement,
  elderRay,
  envelope,
  fisher,
  forceIndex,
  historicalVolatility,
  hma,
  linreg,
  massIndex,
  pvt,
  smma,
  stochRsi,
  tema,
  trix,
  ultimate,
  vortex,
  vwma,
  bollinger,
  cci,
  donchian,
  ema,
  ichimoku,
  keltner,
  macd,
  mfi,
  momentum,
  obv,
  pivotPoints,
  psar,
  roc,
  rsi,
  sma,
  stochastic,
  superTrend,
  vwap,
  williamsR,
  wma,
  chandeKrollStop,
  cmo,
  connorsRsi,
  fractals,
  mcginley,
  netVolume,
  relativeVolatilityIndex,
  smiErgodic,
  stdev,
  tsi,
  zigzag,
  estimatedDelta,
  alignByTime,
  anchoredVwap,
  autoFibExtension,
  autoFibRetracement,
  autoPitchfork,
  autoTrendlines,
  averageDayRange,
  barsPerYear,
  cciOf,
  inferBarInterval,
  bbTrend,
  chaikinVolatility,
  chandelierExit,
  chopZone,
  correlation,
  cumulativeDeltaByPeriod,
  kama,
  klinger,
  linRegChannel,
  lsma,
  pivotPointsStandard,
  pivotsHighLow,
  priceOscillator,
  rci,
  relativeStrength,
  smi,
  spreadRatio,
  t3,
  ulcerIndex,
  upDownVolume,
  vidya,
  volumeWithMa,
  vwapBands,
  zlema,
  FIB_EXTENSION_LEVELS,
  FIB_RETRACEMENT_LEVELS,
  PIVOT_TYPES,
  type AnchorPeriod,
  type DayOf,
  type PivotType,
  type Maybe,
  type Ohlc,
} from './math';
import {
  SESSION_WINDOWS,
  SESSION_ZONES,
  parseSessionWindow,
  sessionHighLow,
  type SessionWindow,
} from './sessions';

/**
 * The indicator catalogue.
 *
 * Each entry declares its inputs, where it draws (on the price chart or in its
 * own pane) and how to compute its plots. The chart component knows nothing
 * about any individual indicator — it reads this registry — so adding one is a
 * single entry here rather than a change to the renderer.
 *
 * This is the extension point that replaces TradingView's built-in study
 * library, so the shape matters more than the current contents: `inputs` drives
 * the settings dialog, `plots` drives the legend and the series creation.
 */

/**
 * `markers`: one shape per bar that has a value and nothing in between — a study whose values are
 * events, not a series (Williams fractals). Joined as a line they zig-zagged across every swing.
 * `points`: a dot per value, never joined — a trailing stop that jumps sides (Parabolic SAR) drawn as a line
 * painted a vertical stroke at every flip.
 */
export type PlotKind = 'line' | 'histogram' | 'area' | 'markers' | 'points';

/**
 * The key under which `compute` returns a plot's values PAST the last bar — one per bar ahead (Ichimoku's leading
 * spans, the Alligator's shifted lines). The chart draws them on the bars still to come.
 */
export const aheadKey = (plotKey: string): string => `${plotKey}:ahead`;

export interface PlotSpec {
  key: string;
  title: string;
  kind: PlotKind;
  color: string;
  /** Dashed reference levels (RSI 30/70 etc.), drawn in the indicator's pane. */
  lineWidth?: number;
  /**
   * Bars without a value: `join` (default) draws the line straight across them — a zig zag joins its
   * pivots; `break` leaves a gap — a session's high and low end with the session (DR-17).
   */
  gaps?: 'join' | 'break';
  /** For `markers`: the shape, and whether it sits on top of or under the value. */
  marker?: { shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square'; position: 'above' | 'below' };
}

/**
 * `number` and `source` as before; `select` picks one of `options`; `symbol` is
 * an engine symbol for a compare series (the host fetches its bars and passes
 * them in `IndicatorContext.compareBars`); `session` is a local `HHMM-HHMM`
 * window (its zone is a separate `select`); `time` is an instant picked on the
 * chart (UTC ms, 0 = not set) — shown as a date, never typed as milliseconds
 * (DR-22).
 */
export interface IndicatorInput {
  key: string;
  label: string;
  type: 'number' | 'source' | 'select' | 'symbol' | 'session' | 'time';
  default: number | string;
  min?: number;
  max?: number;
  /** Choices for `select` inputs. */
  options?: readonly string[];
}

export const INDICATOR_CATEGORIES = [
  'Trend',
  'Moving Averages',
  'Oscillators',
  'Volatility',
  'Volume',
  'Bill Williams',
  'Structure',
  'Multi-symbol',
  'Sessions',
] as const;

export type IndicatorCategory = (typeof INDICATOR_CATEGORIES)[number];

/** Extra data some indicators need beyond the chart's own bars. */
export interface IndicatorContext {
  /** Bars of the `symbol` input's instrument, ascending; aligned by time inside compute. */
  compareBars?: Ohlc[];
  /**
   * The trading day of a bar's `time`, for the studies that reset by day, week or month (session
   * VWAP, daily pivots, the anchored ones): the symbol's own trading days — for FX, days that roll
   * at 17:00 New York. Absent: UTC days.
   */
  tradingDay?: DayOf;
  /**
   * The bars' real (UTC) open times, index for index. The chart hands the studies its PLOTTED bars, whose times are
   * shifted into the display time zone; what reads the clock itself (the sessions) needs the instant. Absent: the
   * bars' own times are UTC.
   */
  utcTimes?: readonly number[];
  /** The chart's bar interval in ms, for what scales by it (Historical Volatility's annualisation). */
  barIntervalMs?: number;
  /**
   * Trading days a year of the symbol (Historical Volatility): 260 for a market that trades five days a week (FX),
   * 365 for one that never closes. Absent: 260.
   */
  tradingDaysPerYear?: number;
}

export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export interface IndicatorLevel {
  value: number;
  color: string;
}

export interface IndicatorDef {
  id: string;
  name: string;
  /** Group in the indicators dialog. */
  category: IndicatorCategory;
  /** One sentence for the indicators dialog. */
  description: string;
  /** Extra search terms for the indicators dialog. */
  keywords?: string[];
  /** True when compute needs `ctx.compareBars` (the host fetches the `symbol` input's bars). */
  needsCompare?: boolean;
  /** `overlay` draws on the price pane; `pane` gets its own pane below. */
  target: 'overlay' | 'pane';
  inputs: IndicatorInput[];
  plots: PlotSpec[];
  /** Horizontal reference lines for oscillator panes. */
  levels?: IndicatorLevel[];
  /** Fixed pane scale, for bounded oscillators. */
  range?: { min: number; max: number };
  compute: (
    bars: Ohlc[],
    params: Record<string, number | string>,
    ctx?: IndicatorContext,
  ) => Record<string, Maybe[]>;
}

/** Resolve a price source to a plain number series. */
export function sourceValues(bars: Ohlc[], source: PriceSource = 'close'): number[] {
  switch (source) {
    case 'open':
      return bars.map((b) => b.open);
    case 'high':
      return bars.map((b) => b.high);
    case 'low':
      return bars.map((b) => b.low);
    case 'hl2':
      return bars.map((b) => (b.high + b.low) / 2);
    case 'hlc3':
      return bars.map((b) => (b.high + b.low + b.close) / 3);
    case 'ohlc4':
      return bars.map((b) => (b.open + b.high + b.low + b.close) / 4);
    default:
      return bars.map((b) => b.close);
  }
}

const num = (params: Record<string, number | string>, key: string, fallback: number): number => {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

const src = (params: Record<string, number | string>): PriceSource =>
  (params['source'] as PriceSource) ?? 'close';

const LENGTH = (def: number, label = 'Length'): IndicatorInput => ({
  key: 'length',
  label,
  type: 'number',
  default: def,
  min: 1,
  max: 500,
});

const SOURCE: IndicatorInput = { key: 'source', label: 'Source', type: 'source', default: 'close' };

const str = (params: Record<string, number | string>, key: string, fallback: string): string => {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
};

const NUM = (key: string, label: string, def: number, min = 1, max = 500): IndicatorInput => ({
  key,
  label,
  type: 'number',
  default: def,
  min,
  max,
});

const SELECT = (
  key: string,
  label: string,
  options: readonly string[],
  def: string,
): IndicatorInput => ({
  key,
  label,
  type: 'select',
  default: def,
  options,
});

const SESSION_INPUT = (key: string, label: string, w: SessionWindow): IndicatorInput => ({
  key,
  label,
  type: 'session',
  default: `${w.start}-${w.end}`,
});

const SYMBOL: IndicatorInput = {
  key: 'symbol',
  label: 'Compare symbol',
  type: 'symbol',
  default: 'GBPUSD',
};
const PERIODS: readonly AnchorPeriod[] = ['Day', 'Week', 'Month'];
const MA_TYPES = ['SMA', 'EMA'] as const;

const maOf = (type: string, values: number[], len: number): Maybe[] =>
  type === 'EMA' ? ema(values, len) : sma(values, len);

/** Compare-symbol closes aligned to `bars` by time; all null when no compare bars were supplied. */
const compareCloses = (bars: Ohlc[], ctx?: IndicatorContext): Maybe[] =>
  ctx?.compareBars?.length
    ? alignByTime(bars, ctx.compareBars).map((b) => (b ? b.close : null))
    : bars.map(() => null);

const VWAP_BAND_PLOTS: PlotSpec[] = [
  { key: 'vwap', title: 'VWAP', kind: 'line', color: '#2962FF' },
  { key: 'upper1', title: 'Upper 1', kind: 'line', color: '#26A69A' },
  { key: 'lower1', title: 'Lower 1', kind: 'line', color: '#26A69A' },
  { key: 'upper2', title: 'Upper 2', kind: 'line', color: '#787B86' },
  { key: 'lower2', title: 'Lower 2', kind: 'line', color: '#787B86' },
];

const levelKey = (r: number) => 'l' + String(r).replace('.', '_');

export const INDICATORS: readonly IndicatorDef[] = [
  {
    id: 'sma',
    name: 'Moving Average (Simple)',
    category: 'Moving Averages',
    description: 'Arithmetic mean of the source over the last N bars.',
    keywords: ['ma', 'simple'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'SMA', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ ma: sma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'ema',
    name: 'Moving Average (Exponential)',
    category: 'Moving Averages',
    description: 'Exponentially weighted average that reacts faster to recent prices.',
    keywords: ['ma', 'exponential'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'EMA', kind: 'line', color: '#FF6D00' }],
    compute: (bars, p) => ({ ma: ema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'wma',
    name: 'Moving Average (Weighted)',
    category: 'Moving Averages',
    description: 'Linearly weighted average, heaviest on the newest bar.',
    keywords: ['ma', 'weighted'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'WMA', kind: 'line', color: '#AB47BC' }],
    compute: (bars, p) => ({ ma: wma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'bollinger',
    name: 'Bollinger Bands',
    category: 'Volatility',
    description: 'Moving average with bands at a multiple of the standard deviation.',
    keywords: ['bb', 'bands'],
    target: 'overlay',
    inputs: [
      LENGTH(20),
      { key: 'mult', label: 'StdDev', type: 'number', default: 2, min: 0.1, max: 10 },
      SOURCE,
    ],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#2962FF' },
      { key: 'middle', title: 'Basis', kind: 'line', color: '#FF6D00' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) => {
      const r = bollinger(sourceValues(bars, src(p)), num(p, 'length', 20), num(p, 'mult', 2));
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: 'vwap',
    name: 'VWAP (Session)',
    category: 'Volume',
    description: 'Volume-weighted average price, reset at the open of each trading session.',
    keywords: ['session'],
    target: 'overlay',
    inputs: [],
    plots: [{ key: 'vwap', title: 'VWAP', kind: 'line', color: '#00BCD4' }],
    compute: (bars, _p, ctx) => ({ vwap: vwap(bars, ctx?.tradingDay) }),
  },
  {
    id: 'donchian',
    name: 'Donchian Channels',
    category: 'Volatility',
    description: 'Highest high and lowest low over the last N bars, with their midpoint.',
    keywords: ['channel', 'breakout'],
    target: 'overlay',
    inputs: [LENGTH(20)],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#26A69A' },
      { key: 'middle', title: 'Mid', kind: 'line', color: '#787B86' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#EF5350' },
    ],
    compute: (bars, p) => {
      const r = donchian(bars, num(p, 'length', 20));
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: 'rsi',
    name: 'Relative Strength Index',
    category: 'Oscillators',
    description: 'Wilder momentum oscillator measuring the speed of gains versus losses (0-100).',
    keywords: ['overbought', 'oversold'],
    target: 'pane',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'rsi', title: 'RSI', kind: 'line', color: '#7E57C2' }],
    levels: [
      { value: 70, color: '#787B86' },
      { value: 30, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({ rsi: rsi(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'macd',
    name: 'MACD',
    category: 'Oscillators',
    description: 'Difference between fast and slow EMAs with a signal line and histogram.',
    keywords: ['convergence', 'divergence'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 12, min: 1, max: 200 },
      { key: 'slow', label: 'Slow', type: 'number', default: 26, min: 1, max: 400 },
      { key: 'signal', label: 'Signal', type: 'number', default: 9, min: 1, max: 200 },
      SOURCE,
    ],
    plots: [
      { key: 'histogram', title: 'Hist', kind: 'histogram', color: '#26A69A' },
      { key: 'macd', title: 'MACD', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = macd(
        sourceValues(bars, src(p)),
        num(p, 'fast', 12),
        num(p, 'slow', 26),
        num(p, 'signal', 9),
      );
      return { macd: r.macd, signal: r.signal, histogram: r.histogram };
    },
  },
  {
    id: 'stochastic',
    name: 'Stochastic',
    category: 'Oscillators',
    description: 'Where the close sits within the recent high-low range, smoothed (0-100).',
    keywords: ['stoch', '%k'],
    target: 'pane',
    inputs: [
      LENGTH(14, '%K Length'),
      // TradingView's default (DR-15): an unsmoothed %K.
      { key: 'smoothK', label: '%K Smooth', type: 'number', default: 1, min: 1, max: 50 },
      { key: 'smoothD', label: '%D Smooth', type: 'number', default: 3, min: 1, max: 50 },
    ],
    plots: [
      { key: 'k', title: '%K', kind: 'line', color: '#2962FF' },
      { key: 'd', title: '%D', kind: 'line', color: '#FF6D00' },
    ],
    levels: [
      { value: 80, color: '#787B86' },
      { value: 20, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => {
      const r = stochastic(bars, num(p, 'length', 14), num(p, 'smoothK', 1), num(p, 'smoothD', 3));
      return { k: r.k, d: r.d };
    },
  },
  {
    id: 'atr',
    name: 'Average True Range',
    category: 'Volatility',
    description: 'Wilder average of the true range — typical bar size including gaps.',
    keywords: ['true range'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'atr', title: 'ATR', kind: 'line', color: '#EF5350' }],
    compute: (bars, p) => ({ atr: atr(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'adx',
    name: 'Average Directional Index',
    category: 'Trend',
    description: 'Trend strength (ADX) with the positive and negative directional indicators.',
    keywords: ['dmi', 'directional'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [
      { key: 'adx', title: 'ADX', kind: 'line', color: '#212121' },
      { key: 'plusDi', title: '+DI', kind: 'line', color: '#26A69A' },
      { key: 'minusDi', title: '-DI', kind: 'line', color: '#EF5350' },
    ],
    levels: [{ value: 25, color: '#787B86' }],
    range: { min: 0, max: 100 },
    compute: (bars, p) => {
      const r = adx(bars, num(p, 'length', 14));
      return { adx: r.adx, plusDi: r.plusDi, minusDi: r.minusDi };
    },
  },
  {
    id: 'obv',
    name: 'On Balance Volume',
    category: 'Volume',
    description: 'Running total of volume added on up closes and subtracted on down closes.',
    keywords: ['on balance'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'obv', title: 'OBV', kind: 'line', color: '#26A69A' }],
    compute: (bars) => ({ obv: obv(bars) }),
  },

  // ── Second wave ──────────────────────────────────────────────────────────
  {
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
    category: 'Trend',
    description: 'Tenkan, Kijun, the leading spans (cloud) and the lagging span.',
    keywords: ['cloud', 'kumo'],
    target: 'overlay',
    inputs: [
      { key: 'conversion', label: 'Conversion', type: 'number', default: 9, min: 1, max: 200 },
      { key: 'base', label: 'Base', type: 'number', default: 26, min: 1, max: 200 },
      { key: 'spanB', label: 'Span B', type: 'number', default: 52, min: 1, max: 400 },
      { key: 'displacement', label: 'Shift', type: 'number', default: 26, min: 1, max: 200 },
    ],
    plots: [
      { key: 'conversion', title: 'Tenkan', kind: 'line', color: '#2962FF' },
      { key: 'base', title: 'Kijun', kind: 'line', color: '#EF5350' },
      { key: 'spanA', title: 'Span A', kind: 'line', color: '#26A69A' },
      { key: 'spanB', title: 'Span B', kind: 'line', color: '#FF6D00' },
      { key: 'lagging', title: 'Chikou', kind: 'line', color: '#787B86' },
    ],
    compute: (bars, p) => {
      const r = ichimoku(
        bars,
        num(p, 'conversion', 9),
        num(p, 'base', 26),
        num(p, 'spanB', 52),
        num(p, 'displacement', 26),
      );
      return {
        conversion: r.conversion,
        base: r.base,
        spanA: r.spanA,
        spanB: r.spanB,
        lagging: r.lagging,
        [aheadKey('spanA')]: r.spanAAhead,
        [aheadKey('spanB')]: r.spanBAhead,
      };
    },
  },
  {
    id: 'psar',
    name: 'Parabolic SAR',
    category: 'Trend',
    description: 'Parabolic stop-and-reverse points that trail price and flip on reversal.',
    keywords: ['sar', 'stop'],
    target: 'overlay',
    // TradingView's three inputs; `step` keeps its key (the start) so saved layouts read the same.
    inputs: [
      { key: 'step', label: 'Start', type: 'number', default: 0.02, min: 0.001, max: 1 },
      { key: 'increment', label: 'Increment', type: 'number', default: 0.02, min: 0.001, max: 1 },
      { key: 'max', label: 'Max value', type: 'number', default: 0.2, min: 0.01, max: 1 },
    ],
    plots: [{ key: 'psar', title: 'PSAR', kind: 'points', color: '#AB47BC' }],
    compute: (bars, p) => ({
      psar: psar(
        bars,
        num(p, 'step', 0.02),
        num(p, 'increment', num(p, 'step', 0.02)),
        num(p, 'max', 0.2),
      ),
    }),
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    category: 'Trend',
    description: 'ATR-based trailing line that flips sides when price closes through it.',
    keywords: ['atr', 'stop'],
    target: 'overlay',
    inputs: [
      LENGTH(10),
      { key: 'mult', label: 'Factor', type: 'number', default: 3, min: 0.1, max: 20 },
    ],
    // TradingView's two lines: green under price in an up trend, red over it in a down trend, never joined.
    plots: [
      { key: 'up', title: 'Up Trend', kind: 'line', color: '#26A69A', gaps: 'break' },
      { key: 'down', title: 'Down Trend', kind: 'line', color: '#EF5350', gaps: 'break' },
    ],
    compute: (bars, p) => {
      const r = superTrend(bars, num(p, 'length', 10), num(p, 'mult', 3));
      return { up: r.up, down: r.down };
    },
  },
  {
    id: 'keltner',
    name: 'Keltner Channels',
    category: 'Volatility',
    description: 'EMA basis with bands at a multiple of ATR.',
    keywords: ['channel'],
    target: 'overlay',
    inputs: [
      LENGTH(20),
      { key: 'mult', label: 'Factor', type: 'number', default: 2, min: 0.1, max: 10 },
      { key: 'atrPeriod', label: 'ATR', type: 'number', default: 10, min: 1, max: 200 },
    ],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#2962FF' },
      { key: 'middle', title: 'Basis', kind: 'line', color: '#FF6D00' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) => {
      const r = keltner(bars, num(p, 'length', 20), num(p, 'mult', 2), num(p, 'atrPeriod', 10));
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: 'pivots',
    name: 'Pivot Points (Daily)',
    category: 'Structure',
    description: 'Daily floor-trader pivot, two resistances and two supports from the prior day.',
    keywords: ['support', 'resistance'],
    target: 'overlay',
    inputs: [],
    plots: [
      { key: 'r2', title: 'R2', kind: 'line', color: '#EF5350' },
      { key: 'r1', title: 'R1', kind: 'line', color: '#EF5350' },
      { key: 'pivot', title: 'P', kind: 'line', color: '#787B86' },
      { key: 's1', title: 'S1', kind: 'line', color: '#26A69A' },
      { key: 's2', title: 'S2', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, _p, ctx) => {
      const r = pivotPoints(bars, ctx?.tradingDay);
      return { pivot: r.pivot, r1: r.r1, r2: r.r2, s1: r.s1, s2: r.s2 };
    },
  },
  {
    id: 'cci',
    name: 'Commodity Channel Index',
    category: 'Oscillators',
    description: 'Deviation of typical price from its average, scaled by mean deviation.',
    keywords: ['commodity'],
    target: 'pane',
    inputs: [LENGTH(20)],
    plots: [{ key: 'cci', title: 'CCI', kind: 'line', color: '#2962FF' }],
    levels: [
      { value: 100, color: '#787B86' },
      { value: -100, color: '#787B86' },
    ],
    compute: (bars, p) => ({ cci: cci(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'williams-r',
    name: 'Williams %R',
    category: 'Oscillators',
    description: 'Close relative to the recent high-low range on a 0 to -100 scale.',
    keywords: ['%r'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'wr', title: '%R', kind: 'line', color: '#7E57C2' }],
    levels: [
      { value: -20, color: '#787B86' },
      { value: -80, color: '#787B86' },
    ],
    range: { min: -100, max: 0 },
    compute: (bars, p) => ({ wr: williamsR(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'mfi',
    name: 'Money Flow Index',
    category: 'Volume',
    description: 'Volume-weighted RSI of typical price (0-100).',
    keywords: ['money flow'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'mfi', title: 'MFI', kind: 'line', color: '#00BCD4' }],
    levels: [
      { value: 80, color: '#787B86' },
      { value: 20, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({ mfi: mfi(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'momentum',
    name: 'Momentum',
    category: 'Oscillators',
    description: 'Difference between the current source and its value N bars ago.',
    keywords: ['mom'],
    target: 'pane',
    inputs: [LENGTH(10), SOURCE],
    plots: [{ key: 'mom', title: 'MOM', kind: 'line', color: '#FF6D00' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      mom: momentum(sourceValues(bars, src(p)), num(p, 'length', 10)),
    }),
  },
  {
    id: 'roc',
    name: 'Rate of Change',
    category: 'Oscillators',
    description: 'Percentage change of the source over N bars.',
    keywords: ['rate of change'],
    target: 'pane',
    inputs: [LENGTH(9), SOURCE],
    plots: [{ key: 'roc', title: 'ROC', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ roc: roc(sourceValues(bars, src(p)), num(p, 'length', 9)) }),
  },
  {
    id: 'awesome',
    name: 'Awesome Oscillator',
    category: 'Bill Williams',
    description: '5/34 SMA difference of the bar midpoint, as a histogram.',
    keywords: ['ao'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 5, min: 1, max: 100 },
      { key: 'slow', label: 'Slow', type: 'number', default: 34, min: 1, max: 200 },
    ],
    plots: [{ key: 'ao', title: 'AO', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ ao: awesome(bars, num(p, 'fast', 5), num(p, 'slow', 34)) }),
  },

  // ── Third wave ───────────────────────────────────────────────────────────
  {
    id: 'smma',
    name: 'Moving Average (Smoothed)',
    category: 'Moving Averages',
    description: 'Wilder smoothed (RMA) moving average.',
    keywords: ['rma', 'smoothed'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'SMMA', kind: 'line', color: '#8D6E63' }],
    compute: (bars, p) => ({ ma: smma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'hma',
    name: 'Hull Moving Average',
    category: 'Moving Averages',
    description: 'Hull moving average — weighted MAs combined to cut lag.',
    keywords: ['hull'],
    target: 'overlay',
    inputs: [LENGTH(9), SOURCE],
    plots: [{ key: 'ma', title: 'HMA', kind: 'line', color: '#00ACC1' }],
    compute: (bars, p) => ({ ma: hma(sourceValues(bars, src(p)), num(p, 'length', 9)) }),
  },
  {
    id: 'dema',
    name: 'Double EMA',
    category: 'Moving Averages',
    description: 'Double exponential moving average (2·EMA − EMA of EMA).',
    keywords: ['double'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'DEMA', kind: 'line', color: '#43A047' }],
    compute: (bars, p) => ({ ma: dema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'tema',
    name: 'Triple EMA',
    category: 'Moving Averages',
    description: 'Triple exponential moving average for reduced lag.',
    keywords: ['triple'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'TEMA', kind: 'line', color: '#6D4C41' }],
    compute: (bars, p) => ({ ma: tema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'alma',
    name: 'Arnaud Legoux MA',
    category: 'Moving Averages',
    description: 'Arnaud Legoux MA — Gaussian-weighted with an adjustable offset.',
    keywords: ['legoux'],
    target: 'overlay',
    inputs: [
      LENGTH(9),
      { key: 'offset', label: 'Offset', type: 'number', default: 0.85, min: 0, max: 1 },
      { key: 'sigma', label: 'Sigma', type: 'number', default: 6, min: 1, max: 50 },
      SOURCE,
    ],
    plots: [{ key: 'ma', title: 'ALMA', kind: 'line', color: '#F4511E' }],
    compute: (bars, p) => ({
      ma: alma(
        sourceValues(bars, src(p)),
        num(p, 'length', 9),
        num(p, 'offset', 0.85),
        num(p, 'sigma', 6),
      ),
    }),
  },
  {
    id: 'vwma',
    name: 'Volume Weighted MA',
    category: 'Moving Averages',
    description: "Moving average weighted by each bar's volume.",
    keywords: ['volume weighted'],
    target: 'overlay',
    inputs: [LENGTH(20)],
    plots: [{ key: 'ma', title: 'VWMA', kind: 'line', color: '#5E35B1' }],
    compute: (bars, p) => ({ ma: vwma(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'linreg',
    name: 'Linear Regression Curve',
    category: 'Trend',
    description: 'End point of a rolling least-squares regression line.',
    keywords: ['regression'],
    target: 'overlay',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'lr', title: 'LinReg', kind: 'line', color: '#3949AB' }],
    compute: (bars, p) => ({ lr: linreg(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'envelope',
    name: 'Envelope',
    category: 'Volatility',
    description: 'Moving average with bands a fixed percentage above and below.',
    keywords: ['bands'],
    target: 'overlay',
    inputs: [
      LENGTH(20),
      { key: 'percent', label: 'Percent', type: 'number', default: 2, min: 0.1, max: 50 },
      SOURCE,
    ],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#2962FF' },
      { key: 'middle', title: 'Basis', kind: 'line', color: '#787B86' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) => {
      const r = envelope(sourceValues(bars, src(p)), num(p, 'length', 20), num(p, 'percent', 2));
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: 'aroon',
    name: 'Aroon',
    category: 'Trend',
    description: 'How recently the period high and low occurred (0-100).',
    keywords: ['up', 'down'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [
      { key: 'up', title: 'Up', kind: 'line', color: '#26A69A' },
      { key: 'down', title: 'Down', kind: 'line', color: '#EF5350' },
    ],
    levels: [{ value: 50, color: '#787B86' }],
    range: { min: 0, max: 100 },
    compute: (bars, p) => {
      const r = aroon(bars, num(p, 'length', 14));
      return { up: r.up, down: r.down };
    },
  },
  {
    id: 'trix',
    name: 'TRIX',
    category: 'Oscillators',
    description: 'Rate of change of a triple-smoothed EMA.',
    keywords: ['triple'],
    target: 'pane',
    inputs: [LENGTH(18), SOURCE],
    plots: [{ key: 'trix', title: 'TRIX', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ trix: trix(sourceValues(bars, src(p)), num(p, 'length', 18)) }),
  },
  {
    id: 'dpo',
    name: 'Detrended Price Oscillator',
    category: 'Oscillators',
    description: 'Price minus a displaced moving average, removing trend to show cycles.',
    keywords: ['detrended', 'cycle'],
    target: 'pane',
    inputs: [LENGTH(21), SOURCE],
    plots: [{ key: 'dpo', title: 'DPO', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ dpo: dpo(sourceValues(bars, src(p)), num(p, 'length', 21)) }),
  },
  {
    id: 'ultimate',
    name: 'Ultimate Oscillator',
    category: 'Oscillators',
    description: 'Weighted blend of buying pressure over three lookbacks (0-100).',
    keywords: ['uo'],
    target: 'pane',
    inputs: [
      { key: 'p1', label: 'Fast', type: 'number', default: 7, min: 1, max: 100 },
      { key: 'p2', label: 'Mid', type: 'number', default: 14, min: 1, max: 200 },
      { key: 'p3', label: 'Slow', type: 'number', default: 28, min: 1, max: 400 },
    ],
    plots: [{ key: 'uo', title: 'UO', kind: 'line', color: '#7E57C2' }],
    levels: [
      { value: 70, color: '#787B86' },
      { value: 30, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({
      uo: ultimate(bars, num(p, 'p1', 7), num(p, 'p2', 14), num(p, 'p3', 28)),
    }),
  },
  {
    id: 'cmf',
    name: 'Chaikin Money Flow',
    category: 'Volume',
    description: 'Sum of money-flow volume over total volume for N bars.',
    keywords: ['chaikin money flow'],
    target: 'pane',
    inputs: [LENGTH(20)],
    plots: [{ key: 'cmf', title: 'CMF', kind: 'line', color: '#00897B' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ cmf: cmf(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'adl',
    name: 'Accumulation / Distribution',
    category: 'Volume',
    description: 'Cumulative money-flow volume (accumulation/distribution line).',
    keywords: ['accumulation', 'distribution'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'adl', title: 'A/D', kind: 'line', color: '#26A69A' }],
    compute: (bars) => ({ adl: adl(bars) }),
  },
  {
    id: 'chaikin-osc',
    name: 'Chaikin Oscillator',
    category: 'Volume',
    description: 'Fast minus slow EMA of the accumulation/distribution line.',
    keywords: ['chaikin'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 3, min: 1, max: 100 },
      { key: 'slow', label: 'Slow', type: 'number', default: 10, min: 1, max: 200 },
    ],
    plots: [{ key: 'co', title: 'Chaikin', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      co: chaikinOscillator(bars, num(p, 'fast', 3), num(p, 'slow', 10)),
    }),
  },
  {
    id: 'force-index',
    name: 'Force Index',
    category: 'Volume',
    description: 'EMA of price change multiplied by volume.',
    keywords: ['elder'],
    target: 'pane',
    inputs: [LENGTH(13)],
    plots: [{ key: 'fi', title: 'Force', kind: 'line', color: '#EF5350' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ fi: forceIndex(bars, num(p, 'length', 13)) }),
  },
  {
    id: 'elder-ray',
    name: 'Elder Ray (Bull/Bear Power)',
    category: 'Oscillators',
    description: 'High minus EMA (bull power) and low minus EMA (bear power).',
    keywords: ['bull power', 'bear power'],
    target: 'pane',
    inputs: [LENGTH(13)],
    plots: [
      { key: 'bull', title: 'Bull', kind: 'histogram', color: '#26A69A' },
      { key: 'bear', title: 'Bear', kind: 'histogram', color: '#EF5350' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = elderRay(bars, num(p, 'length', 13));
      return { bull: r.bull, bear: r.bear };
    },
  },
  {
    id: 'bop',
    name: 'Balance of Power',
    category: 'Oscillators',
    description: 'Smoothed (close − open) / (high − low): who controlled each bar.',
    keywords: ['balance of power'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'bop', title: 'BOP', kind: 'line', color: '#FF6D00' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ bop: balanceOfPower(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'eom',
    name: 'Ease of Movement',
    category: 'Volume',
    description: 'Price movement relative to volume — how easily price moves.',
    keywords: ['ease of movement'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'eom', title: 'EOM', kind: 'line', color: '#00BCD4' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ eom: easeOfMovement(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'pvt',
    name: 'Price Volume Trend',
    category: 'Volume',
    description: 'Cumulative volume scaled by the percentage price change.',
    keywords: ['price volume trend'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'pvt', title: 'PVT', kind: 'line', color: '#5E35B1' }],
    compute: (bars) => ({ pvt: pvt(bars) }),
  },
  {
    id: 'mass-index',
    name: 'Mass Index',
    category: 'Volatility',
    description: 'Sum of EMA ratios of the high-low range, flagging range expansions.',
    keywords: ['reversal bulge'],
    target: 'pane',
    inputs: [
      LENGTH(25),
      { key: 'emaPeriod', label: 'EMA', type: 'number', default: 9, min: 1, max: 100 },
    ],
    plots: [{ key: 'mi', title: 'Mass', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 27, color: '#787B86' }],
    compute: (bars, p) => ({
      mi: massIndex(bars, num(p, 'length', 25), num(p, 'emaPeriod', 9)),
    }),
  },
  {
    id: 'choppiness',
    name: 'Choppiness Index',
    category: 'Volatility',
    description: 'Whether the market is trending (low) or choppy (high), 0-100.',
    keywords: ['chop'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'chop', title: 'CHOP', kind: 'line', color: '#787B86' }],
    levels: [
      { value: 61.8, color: '#787B86' },
      { value: 38.2, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({ chop: choppiness(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'vortex',
    name: 'Vortex',
    category: 'Trend',
    description: 'VI+ and VI− measuring upward and downward trend movement.',
    keywords: ['vi'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [
      { key: 'plus', title: 'VI+', kind: 'line', color: '#26A69A' },
      { key: 'minus', title: 'VI-', kind: 'line', color: '#EF5350' },
    ],
    levels: [{ value: 1, color: '#787B86' }],
    compute: (bars, p) => {
      const r = vortex(bars, num(p, 'length', 14));
      return { plus: r.plus, minus: r.minus };
    },
  },
  {
    id: 'hv',
    name: 'Historical Volatility',
    category: 'Volatility',
    description: 'Annualised standard deviation of log returns, in percent.',
    keywords: ['historical volatility'],
    target: 'pane',
    inputs: [LENGTH(20)],
    plots: [{ key: 'hv', title: 'HV%', kind: 'line', color: '#F4511E' }],
    // Annualised by the chart's own interval (DR-12): bars a year at this timeframe, on the symbol's trading days.
    compute: (bars, p, ctx) => ({
      hv: historicalVolatility(
        bars,
        num(p, 'length', 20),
        barsPerYear(ctx?.barIntervalMs ?? inferBarInterval(bars), ctx?.tradingDaysPerYear ?? 260),
      ),
    }),
  },
  {
    id: 'stoch-rsi',
    name: 'Stochastic RSI',
    category: 'Oscillators',
    description: 'Stochastic oscillator applied to RSI values.',
    keywords: ['stochrsi'],
    target: 'pane',
    inputs: [
      { key: 'rsiPeriod', label: 'RSI', type: 'number', default: 14, min: 1, max: 200 },
      { key: 'stochPeriod', label: 'Stoch', type: 'number', default: 14, min: 1, max: 200 },
      { key: 'smoothK', label: '%K', type: 'number', default: 3, min: 1, max: 50 },
      { key: 'smoothD', label: '%D', type: 'number', default: 3, min: 1, max: 50 },
      SOURCE,
    ],
    plots: [
      { key: 'k', title: '%K', kind: 'line', color: '#2962FF' },
      { key: 'd', title: '%D', kind: 'line', color: '#FF6D00' },
    ],
    levels: [
      { value: 80, color: '#787B86' },
      { value: 20, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => {
      const r = stochRsi(
        sourceValues(bars, src(p)),
        num(p, 'rsiPeriod', 14),
        num(p, 'stochPeriod', 14),
        num(p, 'smoothK', 3),
        num(p, 'smoothD', 3),
      );
      return { k: r.k, d: r.d };
    },
  },
  {
    id: 'fisher',
    name: 'Fisher Transform',
    category: 'Oscillators',
    description: 'Fisher transform of price, making turning points sharper.',
    keywords: ['ehlers'],
    target: 'pane',
    inputs: [LENGTH(9)],
    plots: [
      { key: 'fisher', title: 'Fisher', kind: 'line', color: '#2962FF' },
      { key: 'trigger', title: 'Trigger', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = fisher(bars, num(p, 'length', 9));
      return { fisher: r.fisher, trigger: r.trigger };
    },
  },

  // ── Fourth wave ──────────────────────────────────────────────────────────
  {
    id: 'alligator',
    name: 'Williams Alligator',
    category: 'Bill Williams',
    description: 'Three smoothed, forward-shifted MAs: jaw, teeth and lips.',
    keywords: ['williams'],
    target: 'overlay',
    inputs: [],
    plots: [
      { key: 'jaw', title: 'Jaw', kind: 'line', color: '#2962FF' },
      { key: 'teeth', title: 'Teeth', kind: 'line', color: '#EF5350' },
      { key: 'lips', title: 'Lips', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars) => {
      const r = alligator(bars);
      return {
        jaw: r.jaw,
        teeth: r.teeth,
        lips: r.lips,
        [aheadKey('jaw')]: r.jawAhead,
        [aheadKey('teeth')]: r.teethAhead,
        [aheadKey('lips')]: r.lipsAhead,
      };
    },
  },
  {
    id: 'se-bands',
    name: 'Standard Error Bands',
    category: 'Volatility',
    description: 'Regression line with bands at a multiple of its standard error.',
    keywords: ['standard error'],
    target: 'overlay',
    inputs: [
      LENGTH(21),
      { key: 'mult', label: 'StdErr', type: 'number', default: 2, min: 0.1, max: 10 },
      SOURCE,
    ],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#2962FF' },
      { key: 'middle', title: 'Fit', kind: 'line', color: '#787B86' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) => {
      const r = standardErrorBands(
        sourceValues(bars, src(p)),
        num(p, 'length', 21),
        num(p, 'mult', 2),
      );
      return { upper: r.upper, middle: r.middle, lower: r.lower };
    },
  },
  {
    id: 'kst',
    name: 'Know Sure Thing',
    category: 'Oscillators',
    description: 'Know Sure Thing — weighted sum of four smoothed rates of change.',
    keywords: ['pring'],
    target: 'pane',
    inputs: [SOURCE],
    plots: [
      { key: 'kst', title: 'KST', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = kst(sourceValues(bars, src(p)));
      return { kst: r.kst, signal: r.signal };
    },
  },
  {
    id: 'coppock',
    name: 'Coppock Curve',
    category: 'Oscillators',
    description: 'WMA of the sum of two rates of change; a long-term momentum gauge.',
    keywords: ['curve'],
    target: 'pane',
    inputs: [SOURCE],
    plots: [{ key: 'coppock', title: 'Coppock', kind: 'line', color: '#7E57C2' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ coppock: coppock(sourceValues(bars, src(p))) }),
  },
  {
    id: 'rvi',
    name: 'Relative Vigor Index',
    category: 'Oscillators',
    description: 'Relative Vigor Index — close-open relative to high-low, with a signal.',
    keywords: ['vigor'],
    target: 'pane',
    inputs: [LENGTH(10)],
    plots: [
      { key: 'rvi', title: 'RVI', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = rvi(bars, num(p, 'length', 10));
      return { rvi: r.rvi, signal: r.signal };
    },
  },
  {
    id: 'ppo',
    name: 'Percentage Price Oscillator',
    category: 'Oscillators',
    description: 'MACD expressed as a percentage of the slow EMA.',
    keywords: ['percentage price'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 12, min: 1, max: 200 },
      { key: 'slow', label: 'Slow', type: 'number', default: 26, min: 1, max: 400 },
      { key: 'signal', label: 'Signal', type: 'number', default: 9, min: 1, max: 200 },
      SOURCE,
    ],
    plots: [
      { key: 'histogram', title: 'Hist', kind: 'histogram', color: '#26A69A' },
      { key: 'ppo', title: 'PPO', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = ppo(
        sourceValues(bars, src(p)),
        num(p, 'fast', 12),
        num(p, 'slow', 26),
        num(p, 'signal', 9),
      );
      return { ppo: r.ppo, signal: r.signal, histogram: r.histogram };
    },
  },
  {
    id: 'schaff',
    name: 'Schaff Trend Cycle',
    category: 'Oscillators',
    description: 'Schaff Trend Cycle — stochastic of MACD for faster cycle turns.',
    keywords: ['stc'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 23, min: 1, max: 200 },
      { key: 'slow', label: 'Slow', type: 'number', default: 50, min: 1, max: 400 },
      { key: 'cycle', label: 'Cycle', type: 'number', default: 10, min: 1, max: 100 },
      SOURCE,
    ],
    plots: [{ key: 'stc', title: 'STC', kind: 'line', color: '#AB47BC' }],
    levels: [
      { value: 75, color: '#787B86' },
      { value: 25, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({
      stc: schaff(
        sourceValues(bars, src(p)),
        num(p, 'fast', 23),
        num(p, 'slow', 50),
        num(p, 'cycle', 10),
      ),
    }),
  },
  {
    id: 'percent-b',
    name: 'Bollinger %B',
    category: 'Volatility',
    description: 'Where the source sits relative to the Bollinger Bands.',
    keywords: ['%b', 'bollinger'],
    target: 'pane',
    inputs: [
      LENGTH(20),
      { key: 'mult', label: 'StdDev', type: 'number', default: 2, min: 0.1, max: 10 },
      SOURCE,
    ],
    plots: [{ key: 'pb', title: '%B', kind: 'line', color: '#2962FF' }],
    levels: [
      { value: 1, color: '#787B86' },
      { value: 0, color: '#787B86' },
    ],
    compute: (bars, p) => ({
      pb: percentB(sourceValues(bars, src(p)), num(p, 'length', 20), num(p, 'mult', 2)),
    }),
  },
  {
    id: 'bandwidth',
    name: 'Bollinger Bandwidth',
    category: 'Volatility',
    description: 'Width of the Bollinger Bands relative to their basis.',
    keywords: ['bollinger', 'squeeze'],
    target: 'pane',
    inputs: [
      LENGTH(20),
      { key: 'mult', label: 'StdDev', type: 'number', default: 2, min: 0.1, max: 10 },
      SOURCE,
    ],
    plots: [{ key: 'bw', title: 'BW', kind: 'line', color: '#00BCD4' }],
    compute: (bars, p) => ({
      bw: bandwidth(sourceValues(bars, src(p)), num(p, 'length', 20), num(p, 'mult', 2)),
    }),
  },
  {
    id: 'volume-osc',
    name: 'Volume Oscillator',
    category: 'Volume',
    description: 'Percent difference between fast and slow volume EMAs.',
    keywords: ['vo'],
    target: 'pane',
    inputs: [
      { key: 'fast', label: 'Fast', type: 'number', default: 5, min: 1, max: 100 },
      { key: 'slow', label: 'Slow', type: 'number', default: 10, min: 1, max: 200 },
    ],
    plots: [{ key: 'vo', title: 'VO%', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      vo: volumeOscillator(bars, num(p, 'fast', 5), num(p, 'slow', 10)),
    }),
  },
  {
    id: 'nvi-pvi',
    name: 'Negative / Positive Volume Index',
    category: 'Volume',
    description: 'Cumulative price change on falling-volume (NVI) and rising-volume (PVI) bars.',
    keywords: ['negative volume', 'positive volume'],
    target: 'pane',
    inputs: [],
    plots: [
      { key: 'nvi', title: 'NVI', kind: 'line', color: '#2962FF' },
      { key: 'pvi', title: 'PVI', kind: 'line', color: '#FF6D00' },
    ],
    compute: (bars) => {
      const r = volumeIndices(bars);
      return { nvi: r.nvi, pvi: r.pvi };
    },
  },
  {
    id: 'cmo',
    name: 'Chande Momentum Oscillator',
    category: 'Oscillators',
    description: 'Chande momentum: net gains over total movement (−100 to 100).',
    keywords: ['chande'],
    target: 'pane',
    inputs: [LENGTH(9), SOURCE],
    plots: [{ key: 'cmo', title: 'CMO', kind: 'line', color: '#2962FF' }],
    levels: [
      { value: 50, color: '#787B86' },
      { value: 0, color: '#787B86' },
      { value: -50, color: '#787B86' },
    ],
    range: { min: -100, max: 100 },
    compute: (bars, p) => ({ cmo: cmo(sourceValues(bars, src(p)), num(p, 'length', 9)) }),
  },
  {
    id: 'connors-rsi',
    name: 'Connors RSI',
    category: 'Oscillators',
    description: 'Average of short RSI, streak RSI and percent-rank of returns.',
    keywords: ['crsi'],
    target: 'pane',
    inputs: [
      { key: 'rsiLen', label: 'RSI Length', type: 'number', default: 3, min: 1, max: 50 },
      { key: 'streakLen', label: 'Streak Length', type: 'number', default: 2, min: 1, max: 50 },
      { key: 'rankLen', label: 'Rank Length', type: 'number', default: 100, min: 2, max: 500 },
    ],
    plots: [{ key: 'crsi', title: 'CRSI', kind: 'line', color: '#7B1FA2' }],
    levels: [
      { value: 90, color: '#787B86' },
      { value: 50, color: '#787B86' },
      { value: 10, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({
      crsi: connorsRsi(
        bars.map((b) => b.close),
        num(p, 'rsiLen', 3),
        num(p, 'streakLen', 2),
        num(p, 'rankLen', 100),
      ),
    }),
  },
  {
    id: 'chande-kroll',
    name: 'Chande Kroll Stop',
    category: 'Trend',
    description: 'ATR-based long and short stop lines from recent extremes.',
    keywords: ['stop'],
    target: 'overlay',
    inputs: [
      { key: 'atrLength', label: 'ATR Length', type: 'number', default: 10, min: 1, max: 100 },
      { key: 'atrMult', label: 'ATR Multiplier', type: 'number', default: 1, min: 0.1, max: 10 },
      { key: 'stopLength', label: 'Stop Length', type: 'number', default: 9, min: 1, max: 100 },
    ],
    plots: [
      { key: 'long', title: 'Long Stop', kind: 'line', color: '#26A69A' },
      { key: 'short', title: 'Short Stop', kind: 'line', color: '#EF5350' },
    ],
    compute: (bars, p) =>
      chandeKrollStop(bars, num(p, 'atrLength', 10), num(p, 'atrMult', 1), num(p, 'stopLength', 9)),
  },
  {
    id: 'mcginley',
    name: 'McGinley Dynamic',
    category: 'Moving Averages',
    description: 'Self-adjusting moving average that tracks price speed.',
    keywords: ['dynamic'],
    target: 'overlay',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'md', title: 'McGinley', kind: 'line', color: '#FF6D00' }],
    compute: (bars, p) => ({ md: mcginley(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'stdev',
    name: 'Standard Deviation',
    category: 'Volatility',
    description: 'Rolling standard deviation of the source.',
    keywords: ['standard deviation'],
    target: 'pane',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'sd', title: 'StdDev', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ sd: stdev(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'tsi',
    name: 'True Strength Index',
    category: 'Oscillators',
    description: 'True Strength Index — double-smoothed momentum ratio with a signal.',
    keywords: ['true strength'],
    target: 'pane',
    inputs: [
      { key: 'long', label: 'Long', type: 'number', default: 25, min: 1, max: 200 },
      { key: 'short', label: 'Short', type: 'number', default: 13, min: 1, max: 100 },
      { key: 'signal', label: 'Signal', type: 'number', default: 13, min: 1, max: 100 },
    ],
    plots: [
      { key: 'tsi', title: 'TSI', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = tsi(
        bars.map((b) => b.close),
        num(p, 'long', 25),
        num(p, 'short', 13),
        num(p, 'signal', 13),
      );
      return { tsi: r.tsi, signal: r.signal };
    },
  },
  {
    id: 'smi-ergodic',
    name: 'SMI Ergodic',
    category: 'Oscillators',
    description: "SMI Ergodic — TSI with Blau's default lengths and signal.",
    keywords: ['ergodic'],
    target: 'pane',
    inputs: [
      { key: 'long', label: 'Long', type: 'number', default: 20, min: 1, max: 200 },
      { key: 'short', label: 'Short', type: 'number', default: 5, min: 1, max: 100 },
      { key: 'signal', label: 'Signal', type: 'number', default: 5, min: 1, max: 100 },
    ],
    plots: [
      { key: 'smi', title: 'SMI', kind: 'line', color: '#7B1FA2' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => {
      const r = smiErgodic(
        bars.map((b) => b.close),
        num(p, 'long', 20),
        num(p, 'short', 5),
        num(p, 'signal', 5),
      );
      return { smi: r.tsi, signal: r.signal };
    },
  },
  {
    id: 'rvi-volatility',
    name: 'Relative Volatility Index',
    category: 'Volatility',
    description: 'RSI computed on standard deviation, showing volatility direction.',
    keywords: ['relative volatility'],
    target: 'pane',
    // TradingView's: σ over 10 bars, smoothed by an EMA of 14.
    inputs: [
      LENGTH(14, 'Smoothing'),
      { key: 'stdevLen', label: 'StdDev Length', type: 'number', default: 10, min: 1, max: 200 },
    ],
    plots: [{ key: 'rvi', title: 'RVI', kind: 'line', color: '#2962FF' }],
    levels: [
      { value: 80, color: '#787B86' },
      { value: 50, color: '#787B86' },
      { value: 20, color: '#787B86' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => ({
      rvi: relativeVolatilityIndex(
        bars.map((b) => b.close),
        num(p, 'length', 14),
        num(p, 'stdevLen', 10),
      ),
    }),
  },
  {
    id: 'fractals',
    name: 'Williams Fractals',
    category: 'Bill Williams',
    description: 'Swing highs and lows confirmed by surrounding bars.',
    keywords: ['fractal'],
    target: 'overlay',
    inputs: [{ key: 'size', label: 'Periods', type: 'number', default: 2, min: 1, max: 10 }],
    // TradingView's triangles: an up fractal over the swing high, a down fractal under the swing low.
    plots: [
      {
        key: 'up',
        title: 'Up Fractal',
        kind: 'markers',
        color: '#EF5350',
        marker: { shape: 'arrowUp', position: 'above' },
      },
      {
        key: 'down',
        title: 'Down Fractal',
        kind: 'markers',
        color: '#26A69A',
        marker: { shape: 'arrowDown', position: 'below' },
      },
    ],
    compute: (bars, p) => fractals(bars, num(p, 'size', 2)),
  },
  {
    id: 'zigzag',
    name: 'Zig Zag',
    category: 'Structure',
    description: 'Connects swings that reverse by more than a percentage threshold.',
    keywords: ['swing'],
    target: 'overlay',
    inputs: [
      { key: 'deviation', label: 'Deviation %', type: 'number', default: 5, min: 0.1, max: 50 },
    ],
    plots: [{ key: 'zz', title: 'Zig Zag', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ zz: zigzag(bars, num(p, 'deviation', 5)) }),
  },
  {
    id: 'est-delta',
    name: 'Delta (estimated)',
    category: 'Volume',
    description: 'Per-bar buy/sell imbalance estimated from OHLCV (not order flow).',
    keywords: ['delta', 'order flow', 'est'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'delta', title: 'Δ est', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    // NOT order flow. There is no aggressor tape for FX here, so this is the standard
    // OHLCV proxy: a bar closing near its high is assumed bought, near its low sold. The
    // name says "estimated" because a drawn estimate reads as a measurement otherwise.
    compute: (bars) => ({ delta: estimatedDelta(bars).map((d) => d.delta) }),
  },
  {
    id: 'est-cum-delta',
    name: 'Cumulative Delta (estimated)',
    category: 'Volume',
    description: 'Running total of estimated delta — cumulative volume delta proxy (est.).',
    keywords: ['cvd', 'cumulative volume delta', 'est'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'cum', title: 'ΣΔ est', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    // The reason to plot the cumulative form: price making higher highs while this slopes
    // down is the divergence worth seeing, and it is invisible in the per-bar series.
    compute: (bars) => ({ cum: estimatedDelta(bars).map((d) => d.cumulative) }),
  },
  {
    id: 'net-volume',
    name: 'Net Volume',
    category: 'Volume',
    description: 'Volume signed by bar direction.',
    keywords: ['net'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'nv', title: 'Net Vol', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars) => ({ nv: netVolume(bars) }),
  },
  // ── Fifth wave: TradingView built-in parity ──────────────────────────────
  {
    id: 'ma-ribbon',
    name: 'Moving Average Ribbon',
    category: 'Moving Averages',
    description: 'Four moving averages (20/50/100/200 by default) showing trend alignment.',
    keywords: ['ribbon', 'ma'],
    target: 'overlay',
    inputs: [
      SELECT('maType', 'MA type', MA_TYPES, 'EMA'),
      NUM('len1', 'MA 1', 20),
      NUM('len2', 'MA 2', 50),
      NUM('len3', 'MA 3', 100),
      NUM('len4', 'MA 4', 200),
      SOURCE,
    ],
    plots: [
      { key: 'ma1', title: 'MA 1', kind: 'line', color: '#F7D774' },
      { key: 'ma2', title: 'MA 2', kind: 'line', color: '#F5A623' },
      { key: 'ma3', title: 'MA 3', kind: 'line', color: '#E5533D' },
      { key: 'ma4', title: 'MA 4', kind: 'line', color: '#8E1A1A' },
    ],
    compute: (bars, p) => {
      const v = sourceValues(bars, src(p));
      const t = str(p, 'maType', 'EMA');
      return {
        ma1: maOf(t, v, num(p, 'len1', 20)),
        ma2: maOf(t, v, num(p, 'len2', 50)),
        ma3: maOf(t, v, num(p, 'len3', 100)),
        ma4: maOf(t, v, num(p, 'len4', 200)),
      };
    },
  },
  {
    id: 'ma-cross',
    name: 'MA Cross',
    category: 'Moving Averages',
    description: 'Fast and slow simple moving averages; crossings mark trend changes.',
    keywords: ['crossover', 'golden cross'],
    target: 'overlay',
    inputs: [NUM('fast', 'Fast', 9), NUM('slow', 'Slow', 21)],
    plots: [
      { key: 'fast', title: 'Fast', kind: 'line', color: '#26A69A' },
      { key: 'slow', title: 'Slow', kind: 'line', color: '#EF5350' },
    ],
    compute: (bars, p) => {
      const c = bars.map((b) => b.close);
      return { fast: sma(c, num(p, 'fast', 9)), slow: sma(c, num(p, 'slow', 21)) };
    },
  },
  {
    id: 'ema-cross',
    name: 'EMA Cross',
    category: 'Moving Averages',
    description: 'Fast and slow exponential moving averages; crossings mark trend changes.',
    keywords: ['crossover'],
    target: 'overlay',
    inputs: [NUM('fast', 'Fast', 9), NUM('slow', 'Slow', 26)],
    plots: [
      { key: 'fast', title: 'Fast', kind: 'line', color: '#26A69A' },
      { key: 'slow', title: 'Slow', kind: 'line', color: '#EF5350' },
    ],
    compute: (bars, p) => {
      const c = bars.map((b) => b.close);
      return { fast: ema(c, num(p, 'fast', 9)), slow: ema(c, num(p, 'slow', 26)) };
    },
  },
  {
    id: 'lsma',
    name: 'Least Squares Moving Average',
    category: 'Moving Averages',
    description:
      'Rolling least-squares regression evaluated at the latest bar (with optional offset).',
    keywords: ['lsma', 'regression'],
    target: 'overlay',
    inputs: [LENGTH(25), NUM('offset', 'Offset', 0, 0, 100), SOURCE],
    plots: [{ key: 'ma', title: 'LSMA', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({
      ma: lsma(sourceValues(bars, src(p)), num(p, 'length', 25), num(p, 'offset', 0)),
    }),
  },
  {
    id: 'zlema',
    name: 'Zero Lag EMA',
    category: 'Moving Averages',
    description: 'EMA of a de-lagged series (2·price − price[lag]) to reduce lag.',
    keywords: ['zlema', 'zero-lag'],
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'ZLEMA', kind: 'line', color: '#00BCD4' }],
    compute: (bars, p) => ({ ma: zlema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'kama',
    name: 'Kaufman Adaptive Moving Average',
    category: 'Moving Averages',
    description: 'Moving average whose speed adapts to the efficiency ratio of price movement.',
    keywords: ['kama', 'adaptive', 'moving average adaptive'],
    target: 'overlay',
    inputs: [LENGTH(10), NUM('fast', 'Fast', 2, 1, 100), NUM('slow', 'Slow', 30, 1, 200), SOURCE],
    plots: [{ key: 'ma', title: 'KAMA', kind: 'line', color: '#AB47BC' }],
    compute: (bars, p) => ({
      ma: kama(
        sourceValues(bars, src(p)),
        num(p, 'length', 10),
        num(p, 'fast', 2),
        num(p, 'slow', 30),
      ),
    }),
  },
  {
    id: 'vidya',
    name: 'Variable Index Dynamic Average',
    category: 'Moving Averages',
    description: 'EMA whose smoothing factor is scaled by the absolute Chande momentum.',
    keywords: ['vidya', 'adaptive'],
    target: 'overlay',
    inputs: [LENGTH(9), NUM('cmoLen', 'CMO length', 9), SOURCE],
    plots: [{ key: 'ma', title: 'VIDYA', kind: 'line', color: '#F4511E' }],
    compute: (bars, p) => ({
      ma: vidya(sourceValues(bars, src(p)), num(p, 'length', 9), num(p, 'cmoLen', 9)),
    }),
  },
  {
    id: 't3',
    name: 'T3 Moving Average',
    category: 'Moving Averages',
    description:
      'Tillson T3 — six chained EMAs blended by a volume factor for smooth, low-lag output.',
    keywords: ['tillson'],
    target: 'overlay',
    inputs: [LENGTH(5), NUM('vFactor', 'Volume factor', 0.7, 0, 1), SOURCE],
    plots: [{ key: 'ma', title: 'T3', kind: 'line', color: '#43A047' }],
    compute: (bars, p) => ({
      ma: t3(sourceValues(bars, src(p)), num(p, 'length', 5), num(p, 'vFactor', 0.7)),
    }),
  },
  {
    id: 'adr',
    name: 'Average Day Range',
    category: 'Volatility',
    description: "Simple average of each bar's high-low range.",
    keywords: ['adr', 'range'],
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'adr', title: 'ADR', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ adr: averageDayRange(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'chop-zone',
    name: 'Chop Zone',
    category: 'Trend',
    description: 'Angle of a 34-EMA normalised by the recent range; near zero means chop.',
    keywords: ['chop', 'angle'],
    target: 'pane',
    inputs: [],
    plots: [{ key: 'angle', title: 'Angle°', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars) => ({ angle: chopZone(bars) }),
  },
  {
    id: 'bb-trend',
    name: 'Bollinger Bands Trend',
    category: 'Volatility',
    description: 'Compares short and long Bollinger Bands to gauge trend strength and direction.',
    keywords: ['bbtrend', 'bollinger'],
    target: 'pane',
    inputs: [NUM('short', 'Short', 20), NUM('long', 'Long', 50), NUM('mult', 'StdDev', 2, 0.1, 10)],
    plots: [{ key: 'bbt', title: 'BBTrend', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      bbt: bbTrend(
        bars.map((b) => b.close),
        num(p, 'short', 20),
        num(p, 'long', 50),
        num(p, 'mult', 2),
      ),
    }),
  },
  {
    id: 'ulcer',
    name: 'Ulcer Index',
    category: 'Volatility',
    description: 'Root-mean-square percentage drawdown from the recent high — downside risk.',
    keywords: ['drawdown', 'risk'],
    target: 'pane',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'ui', title: 'Ulcer', kind: 'line', color: '#EF5350' }],
    compute: (bars, p) => ({ ui: ulcerIndex(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'chandelier',
    name: 'Chandelier Exit',
    category: 'Trend',
    description:
      'Trailing stops a multiple of ATR from the highest high (long) and lowest low (short).',
    keywords: ['stop', 'atr', 'exit'],
    target: 'overlay',
    inputs: [LENGTH(22, 'ATR period'), NUM('mult', 'ATR multiplier', 3, 0.1, 20)],
    plots: [
      { key: 'long', title: 'Long stop', kind: 'line', color: '#26A69A' },
      { key: 'short', title: 'Short stop', kind: 'line', color: '#EF5350' },
    ],
    compute: (bars, p) => chandelierExit(bars, num(p, 'length', 22), num(p, 'mult', 3)),
  },
  {
    id: 'klinger',
    name: 'Klinger Oscillator',
    category: 'Volume',
    description: 'Difference of fast and slow EMAs of direction-signed volume, with a signal line.',
    keywords: ['kvo', 'volume oscillator'],
    target: 'pane',
    inputs: [NUM('fast', 'Fast', 34), NUM('slow', 'Slow', 55), NUM('signal', 'Signal', 13)],
    plots: [
      { key: 'kvo', title: 'KVO', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#26A69A' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) =>
      klinger(bars, num(p, 'fast', 34), num(p, 'slow', 55), num(p, 'signal', 13)),
  },
  {
    id: 'chaikin-vol',
    name: 'Chaikin Volatility',
    category: 'Volatility',
    description: 'Percent rate of change of an EMA of the high-low range.',
    keywords: ['chaikin'],
    target: 'pane',
    inputs: [LENGTH(10, 'EMA length'), NUM('rocLen', 'ROC length', 10)],
    plots: [{ key: 'cv', title: 'ChVol', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      cv: chaikinVolatility(bars, num(p, 'length', 10), num(p, 'rocLen', 10)),
    }),
  },
  {
    id: 'price-osc',
    name: 'Price Oscillator',
    category: 'Oscillators',
    description: 'Percent difference between a fast and a slow moving average.',
    keywords: ['po', 'apo'],
    target: 'pane',
    inputs: [
      NUM('fast', 'Fast', 10),
      NUM('slow', 'Slow', 21),
      SELECT('maType', 'MA type', MA_TYPES, 'SMA'),
      SOURCE,
    ],
    plots: [{ key: 'po', title: 'PO', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({
      po: priceOscillator(
        sourceValues(bars, src(p)),
        num(p, 'fast', 10),
        num(p, 'slow', 21),
        str(p, 'maType', 'SMA') === 'EMA' ? 'EMA' : 'SMA',
      ),
    }),
  },
  {
    id: 'dmi',
    name: 'Directional Movement Index',
    category: 'Trend',
    description: '+DI and −DI directional indicators with ADX, as a standalone study.',
    keywords: ['dmi', 'di', 'adx'],
    target: 'pane',
    inputs: [LENGTH(14, 'DI length')],
    plots: [
      { key: 'plusDi', title: '+DI', kind: 'line', color: '#26A69A' },
      { key: 'minusDi', title: '-DI', kind: 'line', color: '#EF5350' },
      { key: 'adx', title: 'ADX', kind: 'line', color: '#F5A623' },
    ],
    range: { min: 0, max: 100 },
    compute: (bars, p) => {
      const r = adx(bars, num(p, 'length', 14));
      return { plusDi: r.plusDi, minusDi: r.minusDi, adx: r.adx };
    },
  },
  {
    id: 'rci',
    name: 'Rank Correlation Index',
    category: 'Oscillators',
    description: 'Spearman rank correlation between price and time over N bars (−100 to 100).',
    keywords: ['rci', 'spearman'],
    target: 'pane',
    inputs: [LENGTH(10), SOURCE],
    plots: [{ key: 'rci', title: 'RCI', kind: 'line', color: '#2962FF' }],
    levels: [
      { value: 80, color: '#787B86' },
      { value: -80, color: '#787B86' },
    ],
    range: { min: -100, max: 100 },
    compute: (bars, p) => ({ rci: rci(sourceValues(bars, src(p)), num(p, 'length', 10)) }),
  },
  {
    id: 'woodies-cci',
    name: 'Woodies CCI',
    category: 'Oscillators',
    description: "CCI with a fast turbo CCI, as used in Woodie's CCI trading method.",
    keywords: ['cci', 'turbo'],
    target: 'pane',
    inputs: [LENGTH(14, 'CCI length'), NUM('turbo', 'Turbo length', 6)],
    plots: [
      { key: 'hist', title: 'CCI hist', kind: 'histogram', color: '#787B86' },
      { key: 'cci', title: 'CCI', kind: 'line', color: '#2962FF' },
      { key: 'turbo', title: 'Turbo', kind: 'line', color: '#F5A623' },
    ],
    levels: [
      { value: 100, color: '#787B86' },
      { value: 0, color: '#787B86' },
      { value: -100, color: '#787B86' },
    ],
    // TradingView's Woodies CCI runs on the close, not hlc3.
    compute: (bars, p) => {
      const closes = bars.map((b) => b.close);
      const c = cciOf(closes, num(p, 'length', 14));
      return { hist: c, cci: c, turbo: cciOf(closes, num(p, 'turbo', 6)) };
    },
  },
  {
    id: 'smi',
    name: 'Stochastic Momentum Index',
    category: 'Oscillators',
    description:
      'Close relative to the midpoint of the recent range, double-smoothed (−100 to 100).',
    keywords: ['smi', 'blau'],
    target: 'pane',
    inputs: [LENGTH(10, '%K length'), NUM('dLen', '%D length', 3), NUM('signal', 'EMA length', 3)],
    plots: [
      { key: 'smi', title: 'SMI', kind: 'line', color: '#2962FF' },
      { key: 'signal', title: 'Signal', kind: 'line', color: '#FF6D00' },
    ],
    levels: [
      { value: 40, color: '#787B86' },
      { value: -40, color: '#787B86' },
    ],
    range: { min: -100, max: 100 },
    compute: (bars, p) => smi(bars, num(p, 'length', 10), num(p, 'dLen', 3), num(p, 'signal', 3)),
  },
  {
    id: 'volume',
    name: 'Volume',
    category: 'Volume',
    description: 'Bar volume (tick volume for FX) with a moving average.',
    keywords: ['vol', 'tick volume'],
    target: 'pane',
    inputs: [LENGTH(20, 'MA length')],
    plots: [
      { key: 'volume', title: 'Volume', kind: 'histogram', color: '#26A69A' },
      { key: 'ma', title: 'Vol MA', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) => volumeWithMa(bars, num(p, 'length', 20)),
  },
  {
    id: 'vwap-bands',
    name: 'VWAP with Bands',
    category: 'Volume',
    description: 'Anchored-period VWAP with volume-weighted standard-deviation bands.',
    keywords: ['vwap', 'bands', 'stdev'],
    target: 'overlay',
    inputs: [
      SELECT('anchor', 'Anchor period', PERIODS, 'Day'),
      NUM('mult1', 'Band 1 ×', 1, 0.1, 10),
      NUM('mult2', 'Band 2 ×', 2, 0.1, 10),
    ],
    plots: VWAP_BAND_PLOTS,
    compute: (bars, p, ctx) => {
      const r = vwapBands(
        bars,
        num(p, 'mult1', 1),
        num(p, 'mult2', 2),
        str(p, 'anchor', 'Day') as AnchorPeriod,
        ctx?.tradingDay,
      );
      return { ...r };
    },
  },
  {
    id: 'anchored-vwap',
    name: 'Anchored VWAP',
    category: 'Volume',
    description: 'VWAP from an anchor picked on the chart (or bars back) with deviation bands.',
    keywords: ['avwap', 'anchor'],
    target: 'overlay',
    inputs: [
      NUM('barsBack', 'Anchor bars back', 100, 1, 100000),
      // Picked on the chart (DR-22: it was typed as UTC milliseconds); not set = use bars back.
      { key: 'anchorTime', label: 'Anchor (pick on chart)', type: 'time', default: 0 },
      NUM('mult1', 'Band 1 ×', 1, 0.1, 10),
      NUM('mult2', 'Band 2 ×', 2, 0.1, 10),
    ],
    plots: VWAP_BAND_PLOTS,
    compute: (bars, p) => ({
      ...anchoredVwap(
        bars,
        num(p, 'barsBack', 100),
        num(p, 'anchorTime', 0),
        num(p, 'mult1', 1),
        num(p, 'mult2', 2),
      ),
    }),
  },
  {
    id: 'up-down-volume',
    name: 'Up/Down Volume',
    category: 'Volume',
    description:
      'Volume split by candle direction (up positive, down negative) with the net delta.',
    keywords: ['up volume', 'down volume', 'delta'],
    target: 'pane',
    inputs: [],
    plots: [
      { key: 'up', title: 'Up', kind: 'histogram', color: '#26A69A' },
      { key: 'down', title: 'Down', kind: 'histogram', color: '#EF5350' },
      { key: 'delta', title: 'Delta', kind: 'line', color: '#2962FF' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars) => upDownVolume(bars),
  },
  {
    id: 'cvd',
    name: 'Cumulative Volume Delta (est.)',
    category: 'Volume',
    description:
      'Estimated delta accumulated per anchor period — an OHLCV proxy, not aggressor tape.',
    keywords: ['cvd', 'delta', 'order flow', 'est'],
    target: 'pane',
    inputs: [SELECT('anchor', 'Reset period', ['Day', 'Week', 'Month', 'None'], 'Day')],
    plots: [{ key: 'cvd', title: 'CVD est', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p, ctx) => ({
      cvd: cumulativeDeltaByPeriod(
        bars,
        str(p, 'anchor', 'Day') as AnchorPeriod | 'None',
        ctx?.tradingDay,
      ),
    }),
  },
  {
    id: 'auto-fib-retracement',
    name: 'Auto Fib Retracement',
    category: 'Structure',
    description:
      'Fibonacci retracement levels drawn automatically across the recent high-low swing.',
    keywords: ['fibonacci', 'fib'],
    target: 'overlay',
    inputs: [NUM('lookback', 'Lookback', 100, 2, 5000)],
    plots: FIB_RETRACEMENT_LEVELS.map((r, k) => ({
      key: levelKey(r),
      title: String(r),
      kind: 'line' as const,
      color: ['#787B86', '#EF5350', '#FF9800', '#4CAF50', '#089981', '#00BCD4', '#787B86'][k],
    })),
    compute: (bars, p) => {
      const lv = autoFibRetracement(bars, num(p, 'lookback', 100));
      return Object.fromEntries(FIB_RETRACEMENT_LEVELS.map((r, k) => [levelKey(r), lv[k]]));
    },
  },
  {
    id: 'auto-fib-extension',
    name: 'Auto Fib Extension',
    category: 'Structure',
    description: 'Fibonacci extension targets projected from the last three swing pivots.',
    keywords: ['fibonacci', 'fib', 'projection'],
    target: 'overlay',
    inputs: [NUM('depth', 'Pivot depth', 10, 1, 100)],
    plots: FIB_EXTENSION_LEVELS.map((r, k) => ({
      key: levelKey(r),
      title: String(r),
      kind: 'line' as const,
      color: ['#089981', '#2962FF', '#FF9800', '#EF5350'][k],
    })),
    compute: (bars, p) => {
      const lv = autoFibExtension(bars, num(p, 'depth', 10));
      return Object.fromEntries(FIB_EXTENSION_LEVELS.map((r, k) => [levelKey(r), lv[k]]));
    },
  },
  {
    id: 'auto-pitchfork',
    name: 'Auto Pitchfork',
    category: 'Structure',
    description: "Andrews' pitchfork drawn from the last three alternating swing pivots.",
    keywords: ['andrews', 'median line'],
    target: 'overlay',
    inputs: [NUM('depth', 'Pivot depth', 10, 1, 100)],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#26A69A' },
      { key: 'median', title: 'Median', kind: 'line', color: '#EF5350' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, p) => autoPitchfork(bars, num(p, 'depth', 10)),
  },
  {
    id: 'auto-trendlines',
    name: 'Auto Trendlines',
    category: 'Structure',
    description:
      'Trendlines through the last two swing highs and last two swing lows, extended right.',
    keywords: ['trendline', 'support', 'resistance'],
    target: 'overlay',
    inputs: [NUM('depth', 'Pivot depth', 10, 1, 100)],
    plots: [
      { key: 'resistance', title: 'Resistance', kind: 'line', color: '#EF5350' },
      { key: 'support', title: 'Support', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, p) => autoTrendlines(bars, num(p, 'depth', 10)),
  },
  {
    id: 'pivots-hl',
    name: 'Pivot Points High Low',
    category: 'Structure',
    description: 'Latest confirmed swing high and swing low, held as levels until the next pivot.',
    keywords: ['swing', 'pivot high', 'pivot low'],
    target: 'overlay',
    inputs: [NUM('left', 'Left bars', 10, 1, 100), NUM('right', 'Right bars', 10, 1, 100)],
    plots: [
      { key: 'high', title: 'Pivot high', kind: 'line', color: '#EF5350' },
      { key: 'low', title: 'Pivot low', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, p) => pivotsHighLow(bars, num(p, 'left', 10), num(p, 'right', 10)),
  },
  {
    id: 'pivots-standard',
    name: 'Pivot Points Standard',
    category: 'Structure',
    description:
      'Pivot, resistance and support levels from the prior day/week/month, in six formula styles.',
    keywords: ['traditional', 'fibonacci', 'woodie', 'classic', 'dm', 'camarilla', 'floor'],
    target: 'overlay',
    inputs: [
      SELECT('type', 'Type', PIVOT_TYPES, 'Traditional'),
      SELECT('timeframe', 'Pivots timeframe', PERIODS, 'Day'),
    ],
    plots: [
      { key: 'r3', title: 'R3', kind: 'line', color: '#EF5350' },
      { key: 'r2', title: 'R2', kind: 'line', color: '#EF5350' },
      { key: 'r1', title: 'R1', kind: 'line', color: '#EF5350' },
      { key: 'p', title: 'P', kind: 'line', color: '#F5A623' },
      { key: 's1', title: 'S1', kind: 'line', color: '#26A69A' },
      { key: 's2', title: 'S2', kind: 'line', color: '#26A69A' },
      { key: 's3', title: 'S3', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, p, ctx) => ({
      ...pivotPointsStandard(
        bars,
        str(p, 'type', 'Traditional') as PivotType,
        str(p, 'timeframe', 'Day') as AnchorPeriod,
        ctx?.tradingDay,
      ),
    }),
  },
  {
    id: 'linreg-channel',
    name: 'Linear Regression Channel',
    category: 'Trend',
    description:
      'Least-squares fit over the last N bars with bands at a multiple of the residual σ.',
    keywords: ['regression', 'channel'],
    target: 'overlay',
    inputs: [LENGTH(100), NUM('mult', 'Deviation', 2, 0.1, 10), SOURCE],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: '#2962FF' },
      { key: 'middle', title: 'Regression', kind: 'line', color: '#EF5350' },
      { key: 'lower', title: 'Lower', kind: 'line', color: '#2962FF' },
    ],
    compute: (bars, p) =>
      linRegChannel(sourceValues(bars, src(p)), num(p, 'length', 100), num(p, 'mult', 2)),
  },
  {
    id: 'sessions',
    name: 'Sessions',
    category: 'Sessions',
    description:
      'Running high and low of the Tokyo, London and New York sessions, on their own clocks (DST included).',
    keywords: ['asia', 'london', 'new york', 'tokyo', 'session box'],
    target: 'overlay',
    // Each session is a local window in its own zone (DR-18); the keys changed from the old fixed UTC hours
    // (asiaStart…), so a saved layout's hours are not read as local times — it takes these defaults.
    inputs: [
      SESSION_INPUT('asiaSession', 'Asia session', SESSION_WINDOWS.asia),
      SELECT('asiaZone', 'Asia zone', SESSION_ZONES, SESSION_WINDOWS.asia.zone),
      SESSION_INPUT('londonSession', 'London session', SESSION_WINDOWS.london),
      SELECT('londonZone', 'London zone', SESSION_ZONES, SESSION_WINDOWS.london.zone),
      SESSION_INPUT('nySession', 'New York session', SESSION_WINDOWS.newyork),
      SELECT('nyZone', 'New York zone', SESSION_ZONES, SESSION_WINDOWS.newyork.zone),
    ],
    // Each session's high and low end with the session: a gap overnight, never a line across it.
    plots: [
      { key: 'asiaHigh', title: 'Asia H', kind: 'line', color: '#AB47BC', gaps: 'break' },
      { key: 'asiaLow', title: 'Asia L', kind: 'line', color: '#AB47BC', gaps: 'break' },
      { key: 'londonHigh', title: 'London H', kind: 'line', color: '#2962FF', gaps: 'break' },
      { key: 'londonLow', title: 'London L', kind: 'line', color: '#2962FF', gaps: 'break' },
      { key: 'nyHigh', title: 'NY H', kind: 'line', color: '#FF6D00', gaps: 'break' },
      { key: 'nyLow', title: 'NY L', kind: 'line', color: '#FF6D00', gaps: 'break' },
    ],
    compute: (bars, p, ctx) => {
      const w = (key: string, zoneKey: string, fallback: SessionWindow): SessionWindow =>
        parseSessionWindow(str(p, key, ''), str(p, zoneKey, fallback.zone)) ?? fallback;
      const t = ctx?.utcTimes;
      const a = sessionHighLow(bars, w('asiaSession', 'asiaZone', SESSION_WINDOWS.asia), t);
      const l = sessionHighLow(bars, w('londonSession', 'londonZone', SESSION_WINDOWS.london), t);
      const n = sessionHighLow(bars, w('nySession', 'nyZone', SESSION_WINDOWS.newyork), t);
      return {
        asiaHigh: a.high,
        asiaLow: a.low,
        londonHigh: l.high,
        londonLow: l.low,
        nyHigh: n.high,
        nyLow: n.low,
      };
    },
  },
  {
    id: 'correlation',
    name: 'Correlation Coefficient',
    category: 'Multi-symbol',
    description: 'Rolling Pearson correlation of closes against another symbol (−1 to 1).',
    keywords: ['correlation', 'pearson', 'compare'],
    target: 'pane',
    needsCompare: true,
    inputs: [SYMBOL, LENGTH(20)],
    plots: [{ key: 'corr', title: 'Corr', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    range: { min: -1, max: 1 },
    compute: (bars, p, ctx) => ({
      corr: correlation(
        bars.map((b) => b.close),
        compareCloses(bars, ctx),
        num(p, 'length', 20),
      ),
    }),
  },
  {
    id: 'relative-strength',
    name: 'Relative Strength (vs symbol)',
    category: 'Multi-symbol',
    description: 'Performance over N bars relative to another symbol; above 1 is outperforming.',
    keywords: ['rs', 'compare', 'outperformance'],
    target: 'pane',
    needsCompare: true,
    inputs: [SYMBOL, LENGTH(50)],
    plots: [{ key: 'rs', title: 'RS', kind: 'line', color: '#26A69A' }],
    levels: [{ value: 1, color: '#787B86' }],
    compute: (bars, p, ctx) => ({
      rs: relativeStrength(
        bars.map((b) => b.close),
        compareCloses(bars, ctx),
        num(p, 'length', 50),
      ),
    }),
  },
  {
    id: 'spread',
    name: 'Spread (vs symbol)',
    category: 'Multi-symbol',
    description: "Close minus a multiple of another symbol's close.",
    keywords: ['pair', 'spread', 'compare'],
    target: 'pane',
    needsCompare: true,
    inputs: [SYMBOL, NUM('mult', 'Multiplier', 1, -1000, 1000)],
    plots: [{ key: 'spread', title: 'Spread', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p, ctx) => ({
      spread: spreadRatio(
        bars.map((b) => b.close),
        compareCloses(bars, ctx),
        num(p, 'mult', 1),
      ).spread,
    }),
  },
  {
    id: 'ratio',
    name: 'Ratio (vs symbol)',
    category: 'Multi-symbol',
    description: "Close divided by another symbol's close.",
    keywords: ['pair', 'ratio', 'compare'],
    target: 'pane',
    needsCompare: true,
    inputs: [SYMBOL],
    plots: [{ key: 'ratio', title: 'Ratio', kind: 'line', color: '#AB47BC' }],
    compute: (bars, _p, ctx) => ({
      ratio: spreadRatio(
        bars.map((b) => b.close),
        compareCloses(bars, ctx),
      ).ratio,
    }),
  },
  {
    id: 'compare-pct',
    name: 'Compare (% change)',
    category: 'Multi-symbol',
    description: 'This symbol and another as percent change from the first common bar.',
    keywords: ['compare', 'percent', 'overlay'],
    target: 'pane',
    needsCompare: true,
    inputs: [SYMBOL],
    plots: [
      { key: 'self', title: 'This %', kind: 'line', color: '#2962FF' },
      { key: 'other', title: 'Compare %', kind: 'line', color: '#FF6D00' },
    ],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, _p, ctx) => {
      const other = compareCloses(bars, ctx);
      const first = other.findIndex((v) => v !== null);
      const nil = bars.map((): Maybe => null);
      if (first < 0) return { self: nil, other: nil };
      const a0 = bars[first].close;
      const b0 = other[first] as number;
      return {
        self: bars.map((b, i) => (i < first || a0 === 0 ? null : (b.close / a0 - 1) * 100)),
        other: other.map((v) => (v === null || b0 === 0 ? null : (v / b0 - 1) * 100)),
      };
    },
  },
] as const;

export function indicatorById(id: string): IndicatorDef | undefined {
  return INDICATORS.find((i) => i.id === id);
}

/** Default parameter map for an indicator, used when one is first added. */
export function defaultParams(def: IndicatorDef): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const i of def.inputs) out[i.key] = i.default;
  return out;
}

/** A short label for the legend, e.g. `EMA 20` or `MACD 12 26 9`. */
export function indicatorLabel(def: IndicatorDef, params: Record<string, number | string>): string {
  const numeric = def.inputs
    .filter((i) => i.type === 'number' || i.type === 'symbol' || i.type === 'select')
    .map((i) => params[i.key])
    .filter((v) => v !== undefined);
  const short = def.plots.length === 1 ? def.plots[0].title : def.name.replace(/\s*\(.*\)$/, '');
  return numeric.length ? `${short} ${numeric.join(' ')}` : short;
}
