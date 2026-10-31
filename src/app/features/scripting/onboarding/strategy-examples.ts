/**
 * The example gallery (PE-I9): complete, compile-ready strategies to start from. Three are the
 * engine's retired classic strategy types, built on the built-in `lascodia/classic/1` library; one
 * shows the engine's risk, news, cost and data-quality libraries working together; the others need
 * no library. Every one opens its trades with a stop, so none trips PS9002, and every parameter is
 * an input the optimizer can search.
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
  /** The built-in `lascodia/*` libraries it imports, by name (`classic`, `risk`, …). */
  libraries: readonly string[];
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

/**
 * Risk-based sizing (1% of equity over the stop distance) opens positions several times the equity, so this one
 * declares retail FX margin (3.33% = 30:1); without it the emulator refuses every order as unaffordable.
 */
const LEVERAGED_DECLARATION =
  'overlay = true, initial_capital = 10000, margin_long = 3.33, margin_short = 3.33, default_qty_type = strategy.percent_of_equity, default_qty_value = 100';

const RSI2_PULLBACK = `//@version=6
strategy("RSI(2) pullback, news-aware", ${LEVERAGED_DECLARATION})
import lascodia/meanrev/1 as mr
import lascodia/risk/1 as risk
import lascodia/events/1 as ev
import lascodia/costs/1 as costs
import lascodia/guards/1 as guards

//#region Inputs
trendLength = input.int(200, "Trend SMA", minval = 20, group = "Signal")
oversold = input.float(10, "RSI(2) oversold", minval = 1, maxval = 50, group = "Signal")
overbought = input.float(90, "RSI(2) overbought", minval = 50, maxval = 99, group = "Signal")
exitLength = input.int(5, "Exit SMA", minval = 2, group = "Exit")
riskPct = input.float(1.0, "Risk per trade (% of equity)", minval = 0.1, maxval = 5, step = 0.1, group = "Risk")
maxCostR = input.float(0.1, "Largest cost (x risk)", minval = 0.01, step = 0.01, group = "Risk")
holdHours = input.float(24, "Expected hold (hours)", minval = 1, group = "News")
flatMinutes = input.float(30, "Be flat before news (minutes)", minval = 0, group = "News")
//#endregion

// 1 = a pullback in an uptrend, -1 = a rally in a downtrend (RSI(2) against the 200-bar trend).
int sig = mr.signal(trendLength, oversold, overbought)

// The stop sits beyond the recent swing and outside normal noise; the size makes a stop-out cost riskPct of equity.
float longStop = risk.stop(1)
float shortStop = risk.stop(-1)
float sl = sig == -1 ? shortStop : longStop
float stopDistance = math.abs(close - sl)
float units = risk.qty(strategy.equity, riskPct, stopDistance, strategy.account_currency)

// Only on clean bars, clear of scheduled news for the expected hold, with costs small against the risk.
bool cleanBar = guards.tradeable()
bool newsClear = ev.clear(holdHours * 60, 60)
bool cheap = costs.affordable(stopDistance, maxCostR)
bool exitLong = mr.exitLong(exitLength)
bool exitShort = mr.exitShort(exitLength)
bool beforeNews = ev.flattenNow(flatMinutes)

if strategy.position_size == 0 and cleanBar and newsClear and cheap and units > 0
    if sig == 1
        strategy.entry("Long", strategy.long, qty = units)
        strategy.exit("Long stop", "Long", stop = sl)
    else if sig == -1
        strategy.entry("Short", strategy.short, qty = units)
        strategy.exit("Short stop", "Short", stop = sl)

// Out on the bounce back to the short average, or before scheduled news.
if strategy.position_size > 0 and (exitLong or beforeNews)
    strategy.close("Long")
if strategy.position_size < 0 and (exitShort or beforeNews)
    strategy.close("Short")
`;

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
    libraries: [],
    source: DEFAULT_STRATEGY_SCRIPT,
  },
  {
    id: 'rsi-reversion',
    title: 'RSI reversion',
    style: 'Mean reversion',
    summary:
      'Fades RSI as it leaves the oversold or overbought zone, with an ATR stop and target. The retired RSIReversion type, from lascodia/classic.',
    libraries: ['classic'],
    source: RSI_REVERSION,
  },
  {
    id: 'bollinger-reversion',
    title: 'Bollinger band reversion',
    style: 'Mean reversion',
    summary:
      'Trades a close back inside the Bollinger band after a close outside it, skipping squeezes; ATR stop and target. The retired BollingerBandReversion type.',
    libraries: ['classic'],
    source: BOLLINGER_REVERSION,
  },
  {
    id: 'session-breakout',
    title: 'Session breakout',
    style: 'Breakout',
    summary:
      'Marks the overnight range in UTC hours and trades a close beyond it inside the morning window, one trade at a time; ATR stop and target. The retired SessionBreakout type.',
    libraries: ['classic'],
    source: SESSION_BREAKOUT,
  },
  {
    id: 'rsi2-pullback',
    title: 'RSI(2) pullback, news-aware',
    style: 'Mean reversion',
    summary:
      'Buys sharp pullbacks in an uptrend (and sells rallies in a downtrend), exits on the bounce back to a short average. Sizes from a stop outside normal noise, skips news, the rollover and costly trades, and is flat before scheduled news.',
    libraries: ['meanrev', 'risk', 'events', 'costs', 'guards'],
    source: RSI2_PULLBACK,
  },
  {
    id: 'donchian-breakout',
    title: 'Donchian breakout',
    style: 'Breakout',
    summary:
      'Goes with a close beyond the previous bars’ highest high or lowest low; ATR stop and target. No library needed.',
    libraries: [],
    source: DONCHIAN_BREAKOUT,
  },
];
