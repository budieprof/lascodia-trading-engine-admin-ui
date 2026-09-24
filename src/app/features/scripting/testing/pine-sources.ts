/**
 * Pine sources shared by the scripting specs: a breakout strategy with plots of every kind,
 * alertcondition() calls (literal, named, dynamic, duplicate, commented out) and a call name
 * inside a string literal.
 */
export const BREAKOUT_SOURCE = `//@version=6
strategy("Breakout", overlay=true, initial_capital=10000)
len = input.int(20, "Length")
hi = ta.highest(high, len)
lo = ta.lowest(low, len)
plot(hi, "Upper", color=color.teal)
plot(lo, title="Lower")
plotshape(ta.crossover(close, hi[1]), "Breakout up", shape.triangleup)
// alertcondition(false, "Commented out")
alertcondition(ta.crossover(close, hi[1]), "Long breakout", "Price broke above {{plot_0}}")
alertcondition(ta.crossunder(close, lo[1]), title="Short breakout", message="Below {{plot(\\"Lower\\")}}")
alertcondition(close > hi, title=str.format("Dyn {0}", len))
alertcondition(ta.cross(close, hi), "Long breakout", "duplicate title")
if ta.crossover(close, hi[1])
    strategy.entry("Long", strategy.long, comment="alertcondition(x) inside a string")
`;

export const RSI_INDICATOR_SOURCE = `//@version=6
indicator("RSI screener", overlay=false)
len = input.int(14, "Length", minval=1)
r = ta.rsi(close, len)
plot(r, "RSI", display=display.pine_screener)
alertcondition(r > 70, "Overbought", "RSI {{plot_0}} on {{ticker}}")
`;
