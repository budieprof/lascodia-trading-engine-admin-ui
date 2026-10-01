/**
 * Built-in example strategies for the chart's "Indicators & strategies" dialog.
 *
 * Pine v6 sources, each verified to compile (0 errors) against the local engine's
 * `POST scripting/compile` on 2026-10-01 and to produce trades on EURUSD H1. Quantities are
 * 10,000 units (0.1 lot) on 100,000 capital: the engine rejects orders below the symbol's
 * 1,000-unit minimum, so TradingView's usual `default_qty_value = 1` yields zero trades.
 * None sets a stop-loss — they are chart studies, not live-deployable strategies.
 */

export interface ExampleStrategy {
  id: string;
  name: string;
  description: string;
  source: string;
}

export const EXAMPLE_STRATEGIES: readonly ExampleStrategy[] = [
  {
    id: "ma-cross",
    name: "MA Cross",
    description: "Long on a fast/slow SMA crossover, short on the cross under.",
    source: "//@version=6\nstrategy(\"MA Cross\", overlay = true, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\nfastLen = input.int(9, \"Fast MA\", minval = 1)\nslowLen = input.int(21, \"Slow MA\", minval = 2)\nfast = ta.sma(close, fastLen)\nslow = ta.sma(close, slowLen)\nplot(fast, \"Fast\", color = color.teal)\nplot(slow, \"Slow\", color = color.orange)\nif ta.crossover(fast, slow)\n    strategy.entry(\"Long\", strategy.long)\nif ta.crossunder(fast, slow)\n    strategy.entry(\"Short\", strategy.short)\n",
  },
  {
    id: "rsi",
    name: "RSI Strategy",
    description: "Long when RSI crosses up through oversold, short when it crosses down through overbought.",
    source: "//@version=6\nstrategy(\"RSI Strategy\", overlay = false, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\nlength = input.int(14, \"RSI Length\", minval = 2)\noversold = input.float(30, \"Oversold\")\noverbought = input.float(70, \"Overbought\")\nr = ta.rsi(close, length)\nplot(r, \"RSI\", color = color.purple)\nhline(oversold, \"Oversold\", color = color.gray)\nhline(overbought, \"Overbought\", color = color.gray)\nif ta.crossover(r, oversold)\n    strategy.entry(\"Long\", strategy.long)\nif ta.crossunder(r, overbought)\n    strategy.entry(\"Short\", strategy.short)\n",
  },
  {
    id: "bollinger",
    name: "Bollinger Bands Strategy",
    description: "Fades closes back inside the bands.",
    source: "//@version=6\nstrategy(\"Bollinger Bands Strategy\", overlay = true, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\nlength = input.int(20, \"Length\", minval = 1)\nmult = input.float(2.0, \"StdDev\", minval = 0.1, step = 0.1)\nbasis = ta.sma(close, length)\ndev = mult * ta.stdev(close, length)\nupper = basis + dev\nlower = basis - dev\nplot(basis, \"Basis\", color = color.orange)\np1 = plot(upper, \"Upper\", color = color.blue)\np2 = plot(lower, \"Lower\", color = color.blue)\nfill(p1, p2, color = color.new(color.blue, 90))\nif ta.crossover(close, lower)\n    strategy.entry(\"BBandLE\", strategy.long)\nif ta.crossunder(close, upper)\n    strategy.entry(\"BBandSE\", strategy.short)\n",
  },
  {
    id: "macd",
    name: "MACD Strategy",
    description: "Trades MACD / signal-line crossovers.",
    source: "//@version=6\nstrategy(\"MACD Strategy\", overlay = false, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\nfastLen = input.int(12, \"Fast Length\")\nslowLen = input.int(26, \"Slow Length\")\nsignalLen = input.int(9, \"Signal Length\")\n[macdLine, signalLine, hist] = ta.macd(close, fastLen, slowLen, signalLen)\nplot(hist, \"Histogram\", style = plot.style_columns, color = hist >= 0 ? color.teal : color.red)\nplot(macdLine, \"MACD\", color = color.blue)\nplot(signalLine, \"Signal\", color = color.orange)\nif ta.crossover(macdLine, signalLine)\n    strategy.entry(\"MacdLE\", strategy.long)\nif ta.crossunder(macdLine, signalLine)\n    strategy.entry(\"MacdSE\", strategy.short)\n",
  },
  {
    id: "supertrend",
    name: "Supertrend Strategy",
    description: "Flips with the Supertrend direction.",
    source: "//@version=6\nstrategy(\"Supertrend Strategy\", overlay = true, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\natrPeriod = input.int(10, \"ATR Length\", minval = 1)\nfactor = input.float(3.0, \"Factor\", minval = 0.1, step = 0.1)\n[st, dir] = ta.supertrend(factor, atrPeriod)\nplot(dir < 0 ? st : na, \"Up Trend\", color = color.green, style = plot.style_linebr)\nplot(dir > 0 ? st : na, \"Down Trend\", color = color.red, style = plot.style_linebr)\nif ta.change(dir) < 0\n    strategy.entry(\"Long\", strategy.long)\nif ta.change(dir) > 0\n    strategy.entry(\"Short\", strategy.short)\n",
  },
  {
    id: "classic-rsi",
    name: "Classic RSI reversion (lascodia/classic/1)",
    description: "The retired RSIReversion type via the built-in classic library, with its ATR bracket.",
    source: "//@version=6\nstrategy(\"Classic RSI reversion\", overlay = true, default_qty_type = strategy.fixed, default_qty_value = 10000, initial_capital = 100000)\nimport lascodia/classic/1 as classic\nint sig = classic.rsiReversion()\n[sl, tp] = classic.atrBracket(sig)\nif sig == 1\n    strategy.entry(\"L\", strategy.long)\n    strategy.exit(\"L x\", \"L\", stop = sl, limit = tp)\nelse if sig == -1\n    strategy.entry(\"S\", strategy.short)\n    strategy.exit(\"S x\", \"S\", stop = sl, limit = tp)\n",
  },
];
