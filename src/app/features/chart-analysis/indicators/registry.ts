import {
  adx,
  atr,
  awesome,
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
