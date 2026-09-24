import { canonicaliseDslJson, patchDslFields } from './dsl-model';

/**
 * Curated DSL examples offered by the strategy form's "Insert DSL example…"
 * picker. Each one is a complete, valid v2 rule that expresses a real trading
 * idea — the spec runs every example through the parser and the client-side
 * validator, and fails on any error or warning.
 *
 * Two of the previous examples were silently broken: the Bollinger breakout
 * tested `BollingerBandUpper(20) < Sma(20)`, which can never be true (the upper
 * band sits above its own middle line), and the D1 trend filter tested
 * `Ema(200) > 0`, which is always true for any positive price. The validator
 * now lints both shapes.
 */
export interface DslExample {
  id: string;
  label: string;
  json: string;
}

const leaf = (type: string, payload: Record<string, unknown>) => ({
  leaf: { type, [type.charAt(0).toLowerCase() + type.slice(1)]: payload },
});

/** A v2 rule in the canonical camelCase layout the builder writes. */
const rule = (r: Record<string, unknown>) =>
  canonicaliseDslJson(JSON.stringify({ dslVersion: 2, atrPeriod: 14, ...r }));

export const DSL_EXAMPLES: readonly DslExample[] = [
  {
    id: 'rsi-dip-uptrend',
    label: 'RSI(14) dip below 30 above the SMA(200), exit on RSI recovery',
    json: rule({
      name: 'RSI dip in an uptrend',
      description:
        'Buy a short-term oversold reading while price holds above its 200-bar average; take the mean-reversion exit once RSI recovers.',
      symbol: 'EURUSD',
      timeframe: 'H1',
      direction: 'Buy',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('IndicatorThreshold', {
            indicator: 'Rsi',
            period: 14,
            operator: 'LessThan',
            value: 30,
          }),
          leaf('PriceVsMa', { maPeriod: 200, operator: 'GreaterThan' }),
        ],
      },
      exitConditionsRoot: leaf('IndicatorThreshold', {
        indicator: 'Rsi',
        period: 14,
        operator: 'GreaterThan',
        value: 55,
      }),
      stopLossAtrMultiplier: 1.5,
      takeProfitAtrMultiplier: 2.5,
      baseConfidence: 0.6,
    }),
  },
  {
    id: 'ema-crossunder-adx',
    label: 'EMA(20) crosses below EMA(50) while ADX(14) > 25 (sell)',
    json: rule({
      name: 'EMA 20/50 bearish cross in a trending market',
      description:
        'Sell the fast EMA crossing under the slow EMA, only when ADX confirms a trend is in force.',
      symbol: 'EURUSD',
      timeframe: 'H1',
      direction: 'Sell',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('IndicatorCrossunder', {
            leftIndicator: 'Ema',
            leftPeriod: 20,
            rightIndicator: 'Ema',
            rightPeriod: 50,
          }),
          leaf('IndicatorThreshold', {
            indicator: 'Adx',
            period: 14,
            operator: 'GreaterThan',
            value: 25,
          }),
        ],
      },
      stopLossAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      baseConfidence: 0.55,
    }),
  },
  {
    id: 'bollinger-breakout-volume',
    label: 'Close above the upper Bollinger band on a volume burst',
    json: rule({
      name: 'Bollinger upper-band breakout with volume',
      description:
        'Buy a close outside the upper Bollinger band (20, 2σ) when the bar trades at least 1.5× its average volume.',
      symbol: 'EURUSD',
      timeframe: 'H1',
      direction: 'Buy',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('MathExpression', {
            expression: 'Close - BollingerBandUpper(20)',
            operator: 'GreaterThan',
            threshold: 0,
          }),
          leaf('VolumeRatio', { lookbackBars: 20, operator: 'GreaterThan', threshold: 1.5 }),
        ],
      },
      stopLossAtrMultiplier: 1.5,
      takeProfitAtrMultiplier: 2,
      baseConfidence: 0.5,
    }),
  },
  {
    id: 'pinbar-london-trend',
    label: 'Bullish pin bar in London hours, above the SMA(50)',
    json: rule({
      name: 'London bullish pin bar with the trend',
      description:
        'Buy a bullish pin bar printed between 07:00 and 16:00 UTC while price is above its 50-bar average.',
      symbol: 'GBPUSD',
      timeframe: 'H1',
      direction: 'Buy',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('CandlePattern', { pattern: 'PinBar', bullish: true }),
          leaf('HourWindow', { startHourUtc: 7, endHourUtc: 16 }),
          leaf('PriceVsMa', { maPeriod: 50, operator: 'GreaterThan' }),
        ],
      },
      stopLossAtrMultiplier: 1,
      takeProfitAtrMultiplier: 2.5,
      baseConfidence: 0.55,
    }),
  },
  {
    id: 'htf-trend-pullback',
    label: 'H1 RSI pullback inside a rising D1 trend',
    json: rule({
      name: 'H1 pullback in a D1 uptrend',
      description:
        'Buy an H1 RSI pullback below 35 only while the daily close is above the close 20 days ago and the daily trend has strength (ADX > 20).',
      symbol: 'EURUSD',
      timeframe: 'H1',
      direction: 'Buy',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('IndicatorThreshold', {
            indicator: 'Rsi',
            period: 14,
            operator: 'LessThan',
            value: 35,
          }),
          leaf('HtfIndicatorThreshold', {
            higherTimeframe: 'D1',
            indicator: 'Momentum',
            period: 20,
            operator: 'GreaterThan',
            value: 0,
          }),
          leaf('HtfIndicatorThreshold', {
            higherTimeframe: 'D1',
            indicator: 'Adx',
            period: 14,
            operator: 'GreaterThan',
            value: 20,
          }),
        ],
      },
      stopLossAtrMultiplier: 1.5,
      takeProfitAtrMultiplier: 3,
      baseConfidence: 0.6,
    }),
  },
  {
    id: 'range-expansion-close-high',
    label: 'Wide-range bar (> 1.5 × ATR) closing in its top 30%',
    json: rule({
      name: 'Bullish range expansion',
      description:
        'Buy a bar whose range is more than 1.5× ATR(14) and which closes in the top 30% of that range — momentum ignition.',
      symbol: 'EURUSD',
      timeframe: 'H1',
      direction: 'Buy',
      entryConditionsRoot: {
        op: 'And',
        children: [
          leaf('BarRange', {
            operator: 'GreaterThan',
            threshold: 1.5,
            mode: 'AtrFraction',
            atrPeriod: 14,
          }),
          leaf('MathExpression', {
            expression: '(Close - Low) / (High - Low)',
            operator: 'GreaterThan',
            threshold: 0.7,
          }),
        ],
      },
      stopLossAtrMultiplier: 2,
      takeProfitAtrMultiplier: 3,
      baseConfidence: 0.5,
    }),
  },
];

/**
 * An example's JSON with the strategy's own symbol and timeframe written in,
 * so the rule describes the strategy it is loaded into.
 */
export function exampleJsonFor(
  example: DslExample,
  ctx: { symbol?: string | null; timeframe?: string | null },
): string {
  const patch: Record<string, unknown> = {};
  if (ctx.symbol) patch['symbol'] = ctx.symbol;
  if (ctx.timeframe) patch['timeframe'] = ctx.timeframe;
  if (Object.keys(patch).length === 0) return example.json;
  return patchDslFields(example.json, patch) ?? example.json;
}
