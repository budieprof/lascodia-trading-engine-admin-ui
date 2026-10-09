/**
 * The example gallery (PE-I9): complete, compile-ready strategies to start from. Three are the
 * engine's retired classic strategy types, built on the built-in `lascodia/classic/1` library; the
 * others need no library. Every one opens its trades with a stop (an ATR bracket), so none trips
 * PS9002, and every parameter is an input the optimizer can search.
 *
 * Examples teach the shape of a strategy. None is a validated edge: backtest one before trusting it.
 */
import { DEFAULT_STRATEGY_SCRIPT } from '../components/script-authoring/authoring-mode';

export type StrategyExampleStyle = 'Mean reversion' | 'Breakout' | 'Trend';

export interface StrategyExample {
  id: string;
  title: string;
  style: StrategyExampleStyle;
  /** One or two plain sentences: what it trades on, and how it exits. */
  summary: string;
  /** Built on `lascodia/classic/1`. */
  usesClassic: boolean;
  source: string;
}

/**
 * 100% of equity as each trade's notional: the engine rounds orders down to the symbol's lot step
 * (0.01 lot = 1,000 EURUSD units), and 10% of 10,000 rounds to nothing — no trade at all.
 */
const DECLARATION =
  'overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100';

const RISK_INPUTS = (stop: string, target: string) =>
  `stopAtr = input.float(${stop}, "Stop (x ATR)", minval = 0.1, step = 0.1, group = "Risk")
targetAtr = input.float(${target}, "Target (x ATR)", minval = 0.1, step = 0.1, group = "Risk")`;

const BRACKET_ENTRIES = (guard = '') => `if sig == 1${guard ? ` and ${guard}` : ''}
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop = sl, limit = tp)
else if sig == -1${guard ? ` and ${guard}` : ''}
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", "Short", stop = sl, limit = tp)
`;

const RSI_REVERSION = `//@version=6
strategy("RSI reversion", ${DECLARATION})
import lascodia/classic/1 as classic

//#region Inputs
rsiLength = input.int(14, "RSI length", minval = 2, group = "Signal")
oversold = input.float(30, "Oversold", minval = 1, maxval = 50, group = "Signal")
overbought = input.float(70, "Overbought", minval = 50, maxval = 99, group = "Signal")
${RISK_INPUTS('1.5', '2.0')}
//#endregion

// 1 = long, -1 = short, 0 = nothing on this bar: RSI leaving the oversold or overbought zone.
int sig = classic.rsiReversion(close, rsiLength, oversold, overbought)
// The stop and target, fixed from this bar's ATR.
[sl, tp] = classic.atrBracket(sig, stopAtr, targetAtr)

${BRACKET_ENTRIES()}`;

const BOLLINGER_REVERSION = `//@version=6
strategy("Bollinger band reversion", ${DECLARATION})
import lascodia/classic/1 as classic

//#region Inputs
length = input.int(20, "Band length", minval = 2, group = "Signal")
mult = input.float(2.0, "Band width (std devs)", minval = 0.1, step = 0.1, group = "Signal")
squeeze = input.float(0.5, "Skip squeezes below (x last width)", minval = 0, step = 0.05, group = "Signal")
minWidthAtr = input.float(0.5, "Minimum band width (x ATR)", minval = 0, step = 0.1, group = "Signal")
${RISK_INPUTS('1.5', '2.0')}
//#endregion

// A close back inside the band after a close outside it; skipped in a squeeze or a narrow band.
int sig = classic.bollingerReversion(length, mult, squeeze, minWidthAtr)
[sl, tp] = classic.atrBracket(sig, stopAtr, targetAtr)

basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
plot(basis, "Basis", color.gray)
plot(basis + dev, "Upper band", color.teal)
plot(basis - dev, "Lower band", color.teal)

${BRACKET_ENTRIES()}`;

const SESSION_BREAKOUT = `//@version=6
strategy("Session breakout", ${DECLARATION})
import lascodia/classic/1 as classic

//#region Inputs
rangeStart = input.int(0, "Range from (hour, UTC)", minval = 0, maxval = 23, group = "Sessions")
rangeEnd = input.int(8, "Range until (hour, UTC)", minval = 0, maxval = 23, group = "Sessions")
breakoutStart = input.int(8, "Breakouts from (hour, UTC)", minval = 0, maxval = 23, group = "Sessions")
breakoutEnd = input.int(12, "Breakouts until (hour, UTC)", minval = 1, maxval = 24, group = "Sessions")
clearance = input.float(0.3, "Clear the range by (x ATR)", minval = 0, step = 0.05, group = "Signal")
minRangeAtr = input.float(0.3, "Minimum range (x ATR)", minval = 0, step = 0.05, group = "Signal")
${RISK_INPUTS('1.5', '2.0')}
//#endregion

// The overnight range, then a close beyond it (by a margin) inside the breakout window.
[sig, rangeHigh, rangeLow] = classic.sessionBreakout(rangeStart, rangeEnd, breakoutStart, breakoutEnd, clearance, minRangeAtr)
[sl, tp] = classic.atrBracket(sig, stopAtr, targetAtr)

plot(rangeHigh, "Range high", color.green, style = plot.style_linebr)
plot(rangeLow, "Range low", color.red, style = plot.style_linebr)

// One trade at a time: a breakout while a trade is open is ignored.
${BRACKET_ENTRIES('strategy.position_size == 0')}`;

const DONCHIAN_BREAKOUT = `//@version=6
strategy("Donchian breakout", ${DECLARATION})

//#region Inputs
length = input.int(20, "Channel length", minval = 2, group = "Signal")
atrLength = input.int(14, "ATR length", minval = 1, group = "Risk")
${RISK_INPUTS('2.0', '3.0')}
//#endregion

// The channel of the bars before this one: a close beyond it is a breakout.
upper = ta.highest(high, length)[1]
lower = ta.lowest(low, length)[1]
atr = ta.atr(atrLength)
longBreak = close > upper
shortBreak = close < lower

plot(upper, "Upper channel", color.green)
plot(lower, "Lower channel", color.red)

// The stop and target are fixed when the trade opens, from the ATR of that bar.
if longBreak and strategy.position_size <= 0
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop = close - atr * stopAtr, limit = close + atr * targetAtr)
if shortBreak and strategy.position_size >= 0
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", "Short", stop = close + atr * stopAtr, limit = close - atr * targetAtr)
`;

export const STRATEGY_EXAMPLES: readonly StrategyExample[] = [
  {
    id: 'ma-crossover',
    title: 'Moving-average crossover',
    style: 'Trend',
    summary:
      'Buys when the fast EMA crosses above the slow one and sells on the cross below; every trade gets an ATR stop and target. The editor’s starting script.',
    usesClassic: false,
    source: DEFAULT_STRATEGY_SCRIPT,
  },
  {
    id: 'rsi-reversion',
    title: 'RSI reversion',
    style: 'Mean reversion',
    summary:
      'Fades RSI as it leaves the oversold or overbought zone, with an ATR stop and target. The retired RSIReversion type, from lascodia/classic.',
    usesClassic: true,
    source: RSI_REVERSION,
  },
  {
    id: 'bollinger-reversion',
    title: 'Bollinger band reversion',
    style: 'Mean reversion',
    summary:
      'Trades a close back inside the Bollinger band after a close outside it, skipping squeezes; ATR stop and target. The retired BollingerBandReversion type.',
    usesClassic: true,
    source: BOLLINGER_REVERSION,
  },
  {
    id: 'session-breakout',
    title: 'Session breakout',
    style: 'Breakout',
    summary:
      'Marks the overnight range in UTC hours and trades a close beyond it inside the morning window, one trade at a time; ATR stop and target. The retired SessionBreakout type.',
    usesClassic: true,
    source: SESSION_BREAKOUT,
  },
  {
    id: 'donchian-breakout',
    title: 'Donchian breakout',
    style: 'Breakout',
    summary:
      'Goes with a close beyond the previous bars’ highest high or lowest low; ATR stop and target. No library needed.',
    usesClassic: false,
    source: DONCHIAN_BREAKOUT,
  },
];
