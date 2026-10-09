/**
 * "Export as Pine strategy" for a scorecard row (DR-I8): the pattern or structure event as a Pine v6 strategy that
 * trades the scorecard's rules — enter at the next bar's open after the signal, hold k bars, leave at the open after
 * — so a backtest or a paper run can check what the scorecard measured. It opens as a NEW, unsaved draft in the
 * Pine Editor; nothing is saved, run or traded by the export.
 *
 * Candlestick patterns are written out with the same shape rules as the chart's detector (`candlestick-patterns.ts`);
 * breaks of structure and climaxes with the scorecard's (`scorecard.ts`). Chart patterns (double tops, triangles…)
 * need the pivot-geometry finder and are not exported.
 *
 * Pure; unit-tested directly.
 */
import { CANDLESTICK_PATTERNS } from './candlestick-patterns';
import type { PatternScore } from './scorecard';

/** Each candlestick pattern's test in Pine, on the helpers below — offset 0 is the pattern's last bar. */
const CANDLE_PINE: Readonly<Record<string, string>> = {
  doji: 'f_doji(0) and not f_dragonfly(0) and not f_gravestone(0)',
  'dragonfly-doji': 'f_dragonfly(0)',
  'gravestone-doji': 'f_gravestone(0)',
  'long-legged-doji':
    'f_doji(0) and f_upper(0) >= 0.3 * f_range(0) and f_lower(0) >= 0.3 * f_range(0)',
  hammer: 'f_hammer(0)',
  'inverted-hammer': 'f_invHammer(0)',
  'hanging-man': 'f_hammer(0)',
  'shooting-star': 'f_invHammer(0)',
  'marubozu-white': 'f_white(0) and f_marubozu(0) and f_body(0) > f_avgBody(0)',
  'marubozu-black': 'f_black(0) and f_marubozu(0) and f_body(0) > f_avgBody(0)',
  'spinning-top':
    'not f_doji(0) and f_range(0) > 0 and f_body(0) <= 0.35 * f_range(0) and f_upper(0) >= f_body(0) and f_lower(0) >= f_body(0)',
  'long-lower-shadow': 'f_range(0) > 0 and f_lower(0) >= 0.7 * f_range(0)',
  'long-upper-shadow': 'f_range(0) > 0 and f_upper(0) >= 0.7 * f_range(0)',
  'bullish-engulfing':
    'f_black(1) and f_white(0) and close >= open[1] and open <= close[1] and f_body(0) > f_body(1)',
  'bearish-engulfing':
    'f_white(1) and f_black(0) and open >= close[1] and close <= open[1] and f_body(0) > f_body(1)',
  'bullish-harami':
    'f_black(1) and f_body(1) > f_avgBody(1) and f_white(0) and not f_doji(0) and f_inside(0, 1) and f_body(0) < f_body(1)',
  'bearish-harami':
    'f_white(1) and f_body(1) > f_avgBody(1) and f_black(0) and not f_doji(0) and f_inside(0, 1) and f_body(0) < f_body(1)',
  'bullish-harami-cross':
    'f_black(1) and f_body(1) > f_avgBody(1) and f_doji(0) and f_inside(0, 1)',
  'bearish-harami-cross':
    'f_white(1) and f_body(1) > f_avgBody(1) and f_doji(0) and f_inside(0, 1)',
  piercing:
    'f_black(1) and f_body(1) > f_avgBody(1) and f_white(0) and open < close[1] and close > f_mid(1) and close < open[1]',
  'dark-cloud-cover':
    'f_white(1) and f_body(1) > f_avgBody(1) and f_black(0) and open > close[1] and close < f_mid(1) and close > open[1]',
  'tweezer-top':
    'f_white(1) and f_black(0) and not f_doji(1) and not f_doji(0) and math.abs(high[1] - high) <= 0.05 * math.max(f_range(1), f_range(0))',
  'tweezer-bottom':
    'f_black(1) and f_white(0) and not f_doji(1) and not f_doji(0) and math.abs(low[1] - low) <= 0.05 * math.max(f_range(1), f_range(0))',
  'kicking-bull': 'f_black(1) and f_marubozu(1) and f_white(0) and f_marubozu(0) and low > high[1]',
  'kicking-bear': 'f_white(1) and f_marubozu(1) and f_black(0) and f_marubozu(0) and high < low[1]',
  'morning-star':
    'f_black(2) and f_body(2) > f_avgBody(2) and not f_doji(1) and f_body(1) < 0.5 * f_body(2) and f_top(1) < close[2] and f_white(0) and close > f_mid(2)',
  'evening-star':
    'f_white(2) and f_body(2) > f_avgBody(2) and not f_doji(1) and f_body(1) < 0.5 * f_body(2) and f_bot(1) > close[2] and f_black(0) and close < f_mid(2)',
  'morning-doji-star':
    'f_black(2) and f_body(2) > f_avgBody(2) and f_doji(1) and f_top(1) < close[2] and f_white(0) and close > f_mid(2)',
  'evening-doji-star':
    'f_white(2) and f_body(2) > f_avgBody(2) and f_doji(1) and f_bot(1) > close[2] and f_black(0) and close < f_mid(2)',
  'three-white-soldiers':
    'f_soldier(2) and f_soldier(1) and f_soldier(0) and close[1] > close[2] and open[1] >= open[2] and open[1] <= close[2] and close > close[1] and open >= open[1] and open <= close[1]',
  'three-black-crows':
    'f_crow(2) and f_crow(1) and f_crow(0) and close[1] < close[2] and open[1] <= open[2] and open[1] >= close[2] and close < close[1] and open <= open[1] and open >= close[1]',
  'abandoned-baby-bull':
    'f_black(2) and f_doji(1) and high[1] < low[2] and f_white(0) and low > high[1]',
  'abandoned-baby-bear':
    'f_white(2) and f_doji(1) and low[1] > high[2] and f_black(0) and high < low[1]',
  'tri-star-bull':
    'f_doji(2) and f_doji(1) and f_doji(0) and f_top(1) < f_bot(2) and f_top(1) < f_bot(0)',
  'tri-star-bear':
    'f_doji(2) and f_doji(1) and f_doji(0) and f_bot(1) > f_top(2) and f_bot(1) > f_top(0)',
  'upside-tasuki-gap':
    'f_white(2) and f_body(2) > f_avgBody(2) and f_white(1) and low[1] > high[2] and f_black(0) and open > open[1] and open < close[1] and close > high[2] and close < low[1]',
  'downside-tasuki-gap':
    'f_black(2) and f_body(2) > f_avgBody(2) and f_black(1) and high[1] < low[2] and f_white(0) and open < open[1] and open > close[1] and close < low[2] and close > high[1]',
  'rising-three-methods':
    'f_white(4) and f_body(4) > f_avgBody(4) and f_white(0) and f_body(0) > f_avgBody(4) and close > close[4] and f_inner(3) and f_inner(2) and f_inner(1)',
  'falling-three-methods':
    'f_black(4) and f_body(4) > f_avgBody(4) and f_black(0) and f_body(0) > f_avgBody(4) and close < close[4] and f_inner(3) and f_inner(2) and f_inner(1)',
};

/** The candlestick helpers: one bar's shape `k` bars back, as the chart's detector reads it. */
const CANDLE_HELPERS = `// One bar's shape, k bars back — the chart's candlestick rules.
bodySeries = math.abs(close - open)
avgBody14 = ta.sma(bodySeries, 14)
f_body(k) => math.abs(close[k] - open[k])
f_range(k) => high[k] - low[k]
f_top(k) => math.max(open[k], close[k])
f_bot(k) => math.min(open[k], close[k])
f_upper(k) => high[k] - f_top(k)
f_lower(k) => f_bot(k) - low[k]
f_white(k) => close[k] > open[k]
f_black(k) => close[k] < open[k]
f_mid(k) => f_bot(k) + f_body(k) / 2
f_doji(k) => f_range(k) > 0 and f_body(k) <= 0.05 * f_range(k)
// The average body of the 14 bars BEFORE bar k (the chart averages fewer at the very start).
f_avgBody(k) => nz(avgBody14[k + 1], f_body(k))
f_dragonfly(k) => f_doji(k) and f_upper(k) <= 0.1 * f_range(k)
f_gravestone(k) => f_doji(k) and f_lower(k) <= 0.1 * f_range(k)
f_marubozu(k) => f_range(k) > 0 and f_upper(k) <= 0.05 * f_range(k) and f_lower(k) <= 0.05 * f_range(k) and not f_doji(k)
f_hammer(k) => not f_doji(k) and f_range(k) > 0 and f_body(k) < f_avgBody(k) and f_lower(k) >= 2 * f_body(k) and f_upper(k) <= 0.1 * f_range(k)
f_invHammer(k) => not f_doji(k) and f_range(k) > 0 and f_body(k) < f_avgBody(k) and f_upper(k) >= 2 * f_body(k) and f_lower(k) <= 0.1 * f_range(k)
f_inside(i, o) => f_top(i) <= f_top(o) and f_bot(i) >= f_bot(o)
f_soldier(k) => f_white(k) and f_body(k) > f_avgBody(2) and f_upper(k) <= 0.3 * f_body(k)
f_crow(k) => f_black(k) and f_body(k) > f_avgBody(2) and f_lower(k) <= 0.3 * f_body(k)
f_inner(k) => f_body(k) < f_body(4) and high[k] <= high[4] and low[k] >= low[4]`;

/** Whether a scorecard row can be exported. */
export function canExportPine(row: Pick<PatternScore, 'source' | 'id'>): boolean {
  if (row.source === 'candle') return row.id in CANDLE_PINE;
  return row.source === 'structure';
}

const pineString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The Pine v6 strategy for a scorecard row; null for what is not exported (chart patterns). `trendFilter`: the
 * candlestick study's SMA50 trend filter (a reversal pattern needs the bar before it on the right side of the SMA).
 */
export function pineStrategyFor(
  row: Pick<PatternScore, 'source' | 'id' | 'name' | 'direction'>,
  opts: {
    horizon: number;
    trendFilter?: boolean;
    depth?: number;
    climaxMult?: number;
    symbol?: string;
    timeframe?: string;
  },
): string | null {
  if (!canExportPine(row)) return null;
  const long = row.direction === 'bullish';
  const title = `${row.name} — scorecard export`;
  const lines: string[] = [
    '//@version=6',
    `// Exported from the chart's pattern scorecard (DR-I8)${opts.symbol ? ` on ${opts.symbol}` : ''}${opts.timeframe ? ` ${opts.timeframe}` : ''}.`,
    "// The scorecard's rules: the signal is known at its bar's close, the trade enters at the next bar's open,",
    '// is held for the chosen number of bars and leaves at the open after the last of them. A draft: review it,',
    '// backtest it and run it on paper before anything else.',
    `strategy(${pineString(title)}, overlay = true, process_orders_on_close = false, pyramiding = 0)`,
    '',
    `holdBars = input.int(${Math.max(1, Math.round(opts.horizon))}, "Bars held", minval = 1)`,
  ];
  let signal: string;
  if (row.source === 'candle') {
    const meta = CANDLESTICK_PATTERNS.find((p) => p.id === row.id);
    const bars = meta?.bars ?? 1;
    lines.push(
      `useTrend = input.bool(${opts.trendFilter ? 'true' : 'false'}, "SMA50 trend filter")`,
      '',
      CANDLE_HELPERS,
      '',
    );
    lines.push(`pattern = ${CANDLE_PINE[row.id]}`);
    if (meta?.trend) {
      const side = meta.trend === 'up' ? '>' : '<';
      // The SMA on every bar, outside the `or` (Pine v6 evaluates `and` / `or` lazily).
      lines.push('sma50 = ta.sma(close, 50)');
      lines.push(`trendOk = not useTrend or close[${bars}] ${side} sma50[${bars}]`);
      signal = 'pattern and trendOk';
    } else {
      signal = 'pattern';
    }
  } else if (row.id === 'bos-up' || row.id === 'bos-down') {
    const depth = Math.max(1, Math.round(opts.depth ?? 5));
    lines.push(
      `depth = input.int(${depth}, "Swing bars each side", minval = 1)`,
      '',
      '// The last confirmed swing high / low; a close beyond it breaks structure (once per swing).',
      'ph = ta.pivothigh(high, depth, depth)',
      'pl = ta.pivotlow(low, depth, depth)',
      'var float lastHigh = na',
      'var float lastLow = na',
      'if not na(ph)',
      '    lastHigh := ph',
      'if not na(pl)',
      '    lastLow := pl',
      'bosUp = not na(lastHigh) and close > lastHigh',
      'bosDown = not na(lastLow) and close < lastLow',
      'if bosUp',
      '    lastHigh := na',
      'if bosDown',
      '    lastLow := na',
    );
    signal = row.id === 'bos-up' ? 'bosUp' : 'bosDown';
  } else {
    lines.push(
      `mult = input.float(${opts.climaxMult ?? 2.5}, "Climax × the 50-bar means", minval = 1)`,
      '',
      "// Range AND volume beyond `mult` × their means over the 50 bars before (the market structure overlay's rule).",
      '// The means are taken on every bar, outside the `and` (Pine v6 evaluates `and` lazily).',
      'rng = high - low',
      'rangeMean = ta.sma(rng, 50)[1]',
      'volumeMean = ta.sma(volume, 50)[1]',
      'climax = rng > rangeMean * mult and volume > volumeMean * mult',
    );
    signal = row.id === 'selling-climax' ? 'climax and close < open' : 'climax and close >= open';
  }
  lines.push(
    `signal = ${signal}`,
    '',
    `if signal and strategy.position_size == 0`,
    `    strategy.entry(${long ? '"Long"' : '"Short"'}, ${long ? 'strategy.long' : 'strategy.short'})`,
    '',
    '// Leave at the open after the last bar held.',
    'if strategy.position_size != 0 and bar_index - strategy.opentrades.entry_bar_index(0) >= holdBars - 1',
    '    strategy.close_all()',
    '',
    `plotshape(signal, "Signal", ${long ? 'shape.triangleup' : 'shape.triangledown'}, ${long ? 'location.belowbar' : 'location.abovebar'}, ${long ? 'color.teal' : 'color.red'}, size = size.tiny)`,
  );
  return lines.join('\n') + '\n';
}
