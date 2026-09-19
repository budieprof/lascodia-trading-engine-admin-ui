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
  type Maybe,
  type Ohlc,
} from './math';

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

export type PlotKind = 'line' | 'histogram' | 'area';

export interface PlotSpec {
  key: string;
  title: string;
  kind: PlotKind;
  color: string;
  /** Dashed reference levels (RSI 30/70 etc.), drawn in the indicator's pane. */
  lineWidth?: number;
}

export interface IndicatorInput {
  key: string;
  label: string;
  type: 'number' | 'source';
  default: number | PriceSource;
  min?: number;
  max?: number;
}

export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export interface IndicatorLevel {
  value: number;
  color: string;
}

export interface IndicatorDef {
  id: string;
  name: string;
  /** `overlay` draws on the price pane; `pane` gets its own pane below. */
  target: 'overlay' | 'pane';
  inputs: IndicatorInput[];
  plots: PlotSpec[];
  /** Horizontal reference lines for oscillator panes. */
  levels?: IndicatorLevel[];
  /** Fixed pane scale, for bounded oscillators. */
  range?: { min: number; max: number };
  compute: (bars: Ohlc[], params: Record<string, number | string>) => Record<string, Maybe[]>;
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

export const INDICATORS: readonly IndicatorDef[] = [
  {
    id: 'sma',
    name: 'Moving Average (Simple)',
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'SMA', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ ma: sma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'ema',
    name: 'Moving Average (Exponential)',
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'EMA', kind: 'line', color: '#FF6D00' }],
    compute: (bars, p) => ({ ma: ema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'wma',
    name: 'Moving Average (Weighted)',
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'WMA', kind: 'line', color: '#AB47BC' }],
    compute: (bars, p) => ({ ma: wma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'bollinger',
    name: 'Bollinger Bands',
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
    target: 'overlay',
    inputs: [],
    plots: [{ key: 'vwap', title: 'VWAP', kind: 'line', color: '#00BCD4' }],
    compute: (bars) => ({ vwap: vwap(bars) }),
  },
  {
    id: 'donchian',
    name: 'Donchian Channels',
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
    target: 'pane',
    inputs: [
      LENGTH(14, '%K Length'),
      { key: 'smoothK', label: '%K Smooth', type: 'number', default: 3, min: 1, max: 50 },
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
      const r = stochastic(bars, num(p, 'length', 14), num(p, 'smoothK', 3), num(p, 'smoothD', 3));
      return { k: r.k, d: r.d };
    },
  },
  {
    id: 'atr',
    name: 'Average True Range',
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'atr', title: 'ATR', kind: 'line', color: '#EF5350' }],
    compute: (bars, p) => ({ atr: atr(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'adx',
    name: 'Average Directional Index',
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
    target: 'pane',
    inputs: [],
    plots: [{ key: 'obv', title: 'OBV', kind: 'line', color: '#26A69A' }],
    compute: (bars) => ({ obv: obv(bars) }),
  },

  // ── Second wave ──────────────────────────────────────────────────────────
  {
    id: 'ichimoku',
    name: 'Ichimoku Cloud',
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
      };
    },
  },
  {
    id: 'psar',
    name: 'Parabolic SAR',
    target: 'overlay',
    inputs: [
      { key: 'step', label: 'Step', type: 'number', default: 0.02, min: 0.001, max: 1 },
      { key: 'max', label: 'Max', type: 'number', default: 0.2, min: 0.01, max: 1 },
    ],
    plots: [{ key: 'psar', title: 'PSAR', kind: 'line', color: '#AB47BC' }],
    compute: (bars, p) => ({ psar: psar(bars, num(p, 'step', 0.02), num(p, 'max', 0.2)) }),
  },
  {
    id: 'supertrend',
    name: 'SuperTrend',
    target: 'overlay',
    inputs: [
      LENGTH(10),
      { key: 'mult', label: 'Factor', type: 'number', default: 3, min: 0.1, max: 20 },
    ],
    plots: [{ key: 'st', title: 'SuperTrend', kind: 'line', color: '#26A69A' }],
    compute: (bars, p) => ({ st: superTrend(bars, num(p, 'length', 10), num(p, 'mult', 3)) }),
  },
  {
    id: 'keltner',
    name: 'Keltner Channels',
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
    target: 'overlay',
    inputs: [],
    plots: [
      { key: 'r2', title: 'R2', kind: 'line', color: '#EF5350' },
      { key: 'r1', title: 'R1', kind: 'line', color: '#EF5350' },
      { key: 'pivot', title: 'P', kind: 'line', color: '#787B86' },
      { key: 's1', title: 'S1', kind: 'line', color: '#26A69A' },
      { key: 's2', title: 'S2', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars) => {
      const r = pivotPoints(bars);
      return { pivot: r.pivot, r1: r.r1, r2: r.r2, s1: r.s1, s2: r.s2 };
    },
  },
  {
    id: 'cci',
    name: 'Commodity Channel Index',
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
    target: 'pane',
    inputs: [LENGTH(9), SOURCE],
    plots: [{ key: 'roc', title: 'ROC', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ roc: roc(sourceValues(bars, src(p)), num(p, 'length', 9)) }),
  },
  {
    id: 'awesome',
    name: 'Awesome Oscillator',
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
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'SMMA', kind: 'line', color: '#8D6E63' }],
    compute: (bars, p) => ({ ma: smma(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'hma',
    name: 'Hull Moving Average',
    target: 'overlay',
    inputs: [LENGTH(9), SOURCE],
    plots: [{ key: 'ma', title: 'HMA', kind: 'line', color: '#00ACC1' }],
    compute: (bars, p) => ({ ma: hma(sourceValues(bars, src(p)), num(p, 'length', 9)) }),
  },
  {
    id: 'dema',
    name: 'Double EMA',
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'DEMA', kind: 'line', color: '#43A047' }],
    compute: (bars, p) => ({ ma: dema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'tema',
    name: 'Triple EMA',
    target: 'overlay',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'ma', title: 'TEMA', kind: 'line', color: '#6D4C41' }],
    compute: (bars, p) => ({ ma: tema(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'alma',
    name: 'Arnaud Legoux MA',
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
    target: 'overlay',
    inputs: [LENGTH(20)],
    plots: [{ key: 'ma', title: 'VWMA', kind: 'line', color: '#5E35B1' }],
    compute: (bars, p) => ({ ma: vwma(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'linreg',
    name: 'Linear Regression Curve',
    target: 'overlay',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'lr', title: 'LinReg', kind: 'line', color: '#3949AB' }],
    compute: (bars, p) => ({ lr: linreg(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'envelope',
    name: 'Envelope',
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
    target: 'pane',
    inputs: [LENGTH(18), SOURCE],
    plots: [{ key: 'trix', title: 'TRIX', kind: 'line', color: '#2962FF' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ trix: trix(sourceValues(bars, src(p)), num(p, 'length', 18)) }),
  },
  {
    id: 'dpo',
    name: 'Detrended Price Oscillator',
    target: 'pane',
    inputs: [LENGTH(21), SOURCE],
    plots: [{ key: 'dpo', title: 'DPO', kind: 'line', color: '#AB47BC' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ dpo: dpo(sourceValues(bars, src(p)), num(p, 'length', 21)) }),
  },
  {
    id: 'ultimate',
    name: 'Ultimate Oscillator',
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
    target: 'pane',
    inputs: [LENGTH(20)],
    plots: [{ key: 'cmf', title: 'CMF', kind: 'line', color: '#00897B' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ cmf: cmf(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'adl',
    name: 'Accumulation / Distribution',
    target: 'pane',
    inputs: [],
    plots: [{ key: 'adl', title: 'A/D', kind: 'line', color: '#26A69A' }],
    compute: (bars) => ({ adl: adl(bars) }),
  },
  {
    id: 'chaikin-osc',
    name: 'Chaikin Oscillator',
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
    target: 'pane',
    inputs: [LENGTH(13)],
    plots: [{ key: 'fi', title: 'Force', kind: 'line', color: '#EF5350' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ fi: forceIndex(bars, num(p, 'length', 13)) }),
  },
  {
    id: 'elder-ray',
    name: 'Elder Ray (Bull/Bear Power)',
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
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'bop', title: 'BOP', kind: 'line', color: '#FF6D00' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ bop: balanceOfPower(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'eom',
    name: 'Ease of Movement',
    target: 'pane',
    inputs: [LENGTH(14)],
    plots: [{ key: 'eom', title: 'EOM', kind: 'line', color: '#00BCD4' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ eom: easeOfMovement(bars, num(p, 'length', 14)) }),
  },
  {
    id: 'pvt',
    name: 'Price Volume Trend',
    target: 'pane',
    inputs: [],
    plots: [{ key: 'pvt', title: 'PVT', kind: 'line', color: '#5E35B1' }],
    compute: (bars) => ({ pvt: pvt(bars) }),
  },
  {
    id: 'mass-index',
    name: 'Mass Index',
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
    target: 'pane',
    inputs: [LENGTH(20)],
    plots: [{ key: 'hv', title: 'HV%', kind: 'line', color: '#F4511E' }],
    compute: (bars, p) => ({ hv: historicalVolatility(bars, num(p, 'length', 20)) }),
  },
  {
    id: 'stoch-rsi',
    name: 'Stochastic RSI',
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
    target: 'overlay',
    inputs: [],
    plots: [
      { key: 'jaw', title: 'Jaw', kind: 'line', color: '#2962FF' },
      { key: 'teeth', title: 'Teeth', kind: 'line', color: '#EF5350' },
      { key: 'lips', title: 'Lips', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars) => {
      const r = alligator(bars);
      return { jaw: r.jaw, teeth: r.teeth, lips: r.lips };
    },
  },
  {
    id: 'se-bands',
    name: 'Standard Error Bands',
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
    target: 'pane',
    inputs: [SOURCE],
    plots: [{ key: 'coppock', title: 'Coppock', kind: 'line', color: '#7E57C2' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars, p) => ({ coppock: coppock(sourceValues(bars, src(p))) }),
  },
  {
    id: 'rvi',
    name: 'Relative Vigor Index',
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
    target: 'overlay',
    inputs: [LENGTH(14), SOURCE],
    plots: [{ key: 'md', title: 'McGinley', kind: 'line', color: '#FF6D00' }],
    compute: (bars, p) => ({ md: mcginley(sourceValues(bars, src(p)), num(p, 'length', 14)) }),
  },
  {
    id: 'stdev',
    name: 'Standard Deviation',
    target: 'pane',
    inputs: [LENGTH(20), SOURCE],
    plots: [{ key: 'sd', title: 'StdDev', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ sd: stdev(sourceValues(bars, src(p)), num(p, 'length', 20)) }),
  },
  {
    id: 'tsi',
    name: 'True Strength Index',
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
    target: 'pane',
    inputs: [
      LENGTH(10),
      { key: 'stdevLen', label: 'StdDev Length', type: 'number', default: 10, min: 2, max: 200 },
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
        num(p, 'length', 10),
        num(p, 'stdevLen', 10),
      ),
    }),
  },
  {
    id: 'fractals',
    name: 'Williams Fractals',
    target: 'overlay',
    inputs: [{ key: 'size', label: 'Periods', type: 'number', default: 2, min: 1, max: 10 }],
    plots: [
      { key: 'up', title: 'Up Fractal', kind: 'line', color: '#EF5350' },
      { key: 'down', title: 'Down Fractal', kind: 'line', color: '#26A69A' },
    ],
    compute: (bars, p) => fractals(bars, num(p, 'size', 2)),
  },
  {
    id: 'zigzag',
    name: 'Zig Zag',
    target: 'overlay',
    inputs: [
      { key: 'deviation', label: 'Deviation %', type: 'number', default: 5, min: 0.1, max: 50 },
    ],
    plots: [{ key: 'zz', title: 'Zig Zag', kind: 'line', color: '#2962FF' }],
    compute: (bars, p) => ({ zz: zigzag(bars, num(p, 'deviation', 5)) }),
  },
  {
    id: 'net-volume',
    name: 'Net Volume',
    target: 'pane',
    inputs: [],
    plots: [{ key: 'nv', title: 'Net Vol', kind: 'histogram', color: '#26A69A' }],
    levels: [{ value: 0, color: '#787B86' }],
    compute: (bars) => ({ nv: netVolume(bars) }),
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
    .filter((i) => i.type === 'number')
    .map((i) => params[i.key])
    .filter((v) => v !== undefined);
  const short = def.plots.length === 1 ? def.plots[0].title : def.name.replace(/\s*\(.*\)$/, '');
  return numeric.length ? `${short} ${numeric.join(' ')}` : short;
}
