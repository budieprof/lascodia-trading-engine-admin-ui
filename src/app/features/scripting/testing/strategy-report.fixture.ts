/**
 * A realistic StrategyReport exactly as the engine serialises it (`StrategyReport.ToJson()`,
 * camelCase, `null` = na): EURUSD 60-minute, 10,000 USD, six closed trades (three long winners,
 * three shorts of which two lose) and one open long, with the equity curve, 13 monthly returns
 * and an engine warning. Shared by the model, section, chart and component specs.
 */

const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

const INITIAL = 10_000;
const FIRST_PRICE = 1.035;

interface CurveSeed {
  time: number;
  equity: number;
  position: number;
  price: number;
}

// Equity after every fill (entries pay 0.40 commission, exits 0.40) plus a few bars mid-trade.
const SEEDS: CurveSeed[] = [
  { time: T(2025, 1, 2), equity: 10_000, position: 0, price: 1.035 },
  { time: T(2025, 1, 6, 10), equity: 9_999.6, position: 10_000, price: 1.0312 },
  { time: T(2025, 1, 7), equity: 10_020, position: 10_000, price: 1.0332 },
  { time: T(2025, 1, 8, 14), equity: 10_052.2, position: 0, price: 1.0365 },
  { time: T(2025, 1, 15, 9), equity: 10_051.8, position: -10_000, price: 1.03 },
  { time: T(2025, 1, 16, 12), equity: 10_011.4, position: 0, price: 1.034 },
  { time: T(2025, 2, 3, 8), equity: 10_011.0, position: 10_000, price: 1.025 },
  { time: T(2025, 2, 6), equity: 10_080, position: 10_000, price: 1.0319 },
  { time: T(2025, 2, 10, 16), equity: 10_160.6, position: 0, price: 1.04 },
  { time: T(2025, 3, 4, 10), equity: 10_160.2, position: -10_000, price: 1.05 },
  { time: T(2025, 3, 6, 15), equity: 10_099.8, position: 0, price: 1.056 },
  { time: T(2025, 4, 1, 7), equity: 10_099.4, position: 10_000, price: 1.08 },
  { time: T(2025, 4, 8), equity: 10_350, position: 10_000, price: 1.1051 },
  { time: T(2025, 4, 15, 18), equity: 10_599.0, position: 0, price: 1.13 },
  { time: T(2025, 6, 2, 9), equity: 10_598.6, position: -10_000, price: 1.14 },
  { time: T(2025, 6, 3, 11), equity: 10_606.2, position: 0, price: 1.1392 },
  { time: T(2025, 9, 1), equity: 10_606.2, position: 0, price: 1.17 },
  { time: T(2026, 1, 5, 8), equity: 10_605.8, position: 10_000, price: 1.17 },
  { time: T(2026, 1, 9, 21), equity: 10_641.2, position: 10_000, price: 1.17354 },
];

function equityCurve() {
  let peak = -Infinity;
  return SEEDS.map((s, i) => {
    peak = Math.max(peak, s.equity);
    const drawdown = Number((peak - s.equity).toFixed(2));
    const swing = s.position !== 0 ? 5 : 0;
    return {
      time: s.time,
      barIndex: i * 40,
      bars: 40,
      equity: s.equity,
      minEquity: Number((s.equity - swing).toFixed(2)),
      maxEquity: Number((s.equity + swing).toFixed(2)),
      drawdown,
      drawdownPercent: peak > 0 ? Number(((drawdown / peak) * 100).toFixed(4)) : null,
      buyHoldEquity: Number(((INITIAL * s.price) / FIRST_PRICE).toFixed(2)),
      positionSize: s.position,
    };
  });
}

function trade(
  number: number,
  direction: 'long' | 'short',
  entry: { id: string; signal?: string; time: number; price: number; bar: number },
  exit: {
    id: string;
    signal?: string;
    time: number;
    price: number;
    bar: number;
    leg: string;
  } | null,
  profit: number,
  cumulative: number | null,
  runUp: number,
  drawdown: number,
) {
  const qty = 10_000;
  const positionValue = Number((entry.price * qty).toFixed(2));
  return {
    number,
    isOpen: exit === null,
    direction,
    entryId: entry.id,
    entrySignal: entry.signal ?? entry.id,
    entryTime: entry.time,
    entryBarIndex: entry.bar,
    entryPrice: entry.price,
    exitId: exit?.id ?? '',
    exitSignal: exit ? (exit.signal ?? exit.id) : '',
    exitTime: exit?.time ?? null,
    exitBarIndex: exit?.bar ?? null,
    exitPrice: exit?.price ?? null,
    exitLeg: exit?.leg ?? '',
    qty,
    positionValue,
    profit,
    profitPercent: Number(((profit / positionValue) * 100).toFixed(4)),
    cumulativeProfit: cumulative,
    cumulativeProfitPercent:
      cumulative === null ? null : Number(((cumulative / INITIAL) * 100).toFixed(4)),
    runUp,
    runUpPercent: Number(((runUp / positionValue) * 100).toFixed(4)),
    drawdown,
    drawdownPercent: Number(((drawdown / positionValue) * 100).toFixed(4)),
    barsHeld: exit ? exit.bar - entry.bar : 94,
    commission: exit ? 0.8 : 0.4,
  };
}

function split(overrides: Record<string, number | null>) {
  return {
    netProfit: 0,
    netProfitPercent: 0,
    grossProfit: 0,
    grossProfitPercent: 0,
    grossLoss: 0,
    grossLossPercent: 0,
    profitFactor: null,
    commissionPaid: 0,
    openPnL: 0,
    openPnLPercent: 0,
    totalClosedTrades: 0,
    totalOpenTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    evenTrades: 0,
    percentProfitable: null,
    avgTrade: null,
    avgTradePercent: null,
    avgWinningTrade: null,
    avgWinningTradePercent: null,
    avgLosingTrade: null,
    avgLosingTradePercent: null,
    ratioAvgWinAvgLoss: null,
    largestWinningTrade: null,
    largestWinningTradePercent: null,
    largestLosingTrade: null,
    largestLosingTradePercent: null,
    avgBarsInTrades: null,
    avgBarsInWinningTrades: null,
    avgBarsInLosingTrades: null,
    maxContractsHeld: 0,
    maxTradeRunup: 0,
    maxTradeDrawdown: 0,
    ...overrides,
  };
}

/** A fresh copy each call — specs mutate it freely. */
export function strategyReportFixture(): Record<string, any> {
  return {
    meta: {
      symbol: 'EURUSD',
      timeframe: '60',
      accountCurrency: 'USD',
      symbolCurrency: 'USD',
      initialCapital: INITIAL,
      firstBarTime: T(2025, 1, 2),
      lastBarTime: T(2026, 1, 9, 21),
      lastBarTimeClose: T(2026, 1, 9, 22),
      firstBarIndex: 0,
      lastBarIndex: 6_240,
      bars: 6_241,
      trimmedTrades: 0,
      useBarMagnifier: true,
      riskHalted: false,
      riskHaltReason: '',
      properties: {
        pyramiding: 1,
        calcOnOrderFills: false,
        calcOnEveryTick: false,
        calcOnEveryHistoryTick: false,
        maxBarsBack: 0,
        backtestFillLimitsAssumption: 0,
        defaultQtyType: 'Fixed',
        defaultQtyValue: 10_000,
        initialCapital: INITIAL,
        currency: 'USD',
        slippage: 2,
        commissionType: 'CashPerOrder',
        commissionValue: 0.4,
        processOrdersOnClose: false,
        closeEntriesRule: 'FIFO',
        marginLong: 3.33,
        marginShort: 3.33,
        riskFreeRate: 2,
        useBarMagnifier: true,
        fillOrdersOnStandardOhlc: false,
      },
    },
    performance: {
      all: split({
        netProfit: 606.2,
        netProfitPercent: 6.062,
        grossProfit: 707.8,
        grossProfitPercent: 7.078,
        grossLoss: 101.6,
        grossLossPercent: 1.016,
        profitFactor: 6.9665,
        commissionPaid: 5.2,
        openPnL: 35.4,
        openPnLPercent: 0.3338,
        totalClosedTrades: 6,
        totalOpenTrades: 1,
        winningTrades: 4,
        losingTrades: 2,
        evenTrades: 0,
        percentProfitable: 66.6667,
        avgTrade: 101.0333,
        avgTradePercent: 0.9453,
        avgWinningTrade: 176.95,
        avgWinningTradePercent: 1.6617,
        avgLosingTrade: 50.8,
        avgLosingTradePercent: 0.4876,
        ratioAvgWinAvgLoss: 3.4833,
        largestWinningTrade: 499.2,
        largestWinningTradePercent: 4.6222,
        largestLosingTrade: 60.8,
        largestLosingTradePercent: 0.579,
        avgBarsInTrades: 61.5,
        avgBarsInWinningTrades: 72.25,
        avgBarsInLosingTrades: 40,
        maxContractsHeld: 10_000,
        maxTradeRunup: 512,
        maxTradeDrawdown: 71.5,
      }),
      long: split({
        netProfit: 700.6,
        netProfitPercent: 7.006,
        grossProfit: 700.6,
        grossProfitPercent: 7.006,
        grossLoss: 0,
        grossLossPercent: 0,
        profitFactor: null,
        commissionPaid: 2.8,
        openPnL: 35.4,
        openPnLPercent: 0.3338,
        totalClosedTrades: 3,
        totalOpenTrades: 1,
        winningTrades: 3,
        losingTrades: 0,
        percentProfitable: 100,
        avgTrade: 233.5333,
        avgTradePercent: 2.1947,
        avgWinningTrade: 233.5333,
        avgWinningTradePercent: 2.1947,
        largestWinningTrade: 499.2,
        largestWinningTradePercent: 4.6222,
        avgBarsInTrades: 88,
        avgBarsInWinningTrades: 88,
        maxContractsHeld: 10_000,
        maxTradeRunup: 512,
        maxTradeDrawdown: 18,
      }),
      short: split({
        netProfit: -94.4,
        netProfitPercent: -0.944,
        grossProfit: 7.2,
        grossProfitPercent: 0.072,
        grossLoss: 101.6,
        grossLossPercent: 1.016,
        profitFactor: 0.0709,
        commissionPaid: 2.4,
        totalClosedTrades: 3,
        winningTrades: 1,
        losingTrades: 2,
        percentProfitable: 33.3333,
        avgTrade: -31.4667,
        avgTradePercent: -0.304,
        avgWinningTrade: 7.2,
        avgWinningTradePercent: 0.0632,
        avgLosingTrade: 50.8,
        avgLosingTradePercent: 0.4876,
        ratioAvgWinAvgLoss: 0.1417,
        largestWinningTrade: 7.2,
        largestWinningTradePercent: 0.0632,
        largestLosingTrade: 60.8,
        largestLosingTradePercent: 0.579,
        avgBarsInTrades: 35,
        avgBarsInWinningTrades: 26,
        avgBarsInLosingTrades: 40,
        maxContractsHeld: 10_000,
        maxTradeRunup: 22,
        maxTradeDrawdown: 71.5,
      }),
    },
    equity: {
      finalEquity: 10_641.2,
      maxDrawdown: 65.8,
      maxDrawdownPercent: 0.6476,
      maxDrawdownPercentOfInitialCapital: 0.658,
      maxDrawdownCloseToClose: 60.8,
      maxDrawdownCloseToClosePercent: 0.5984,
      maxRunup: 646.6,
      maxRunupPercent: 6.4663,
      maxRunupPercentOfInitialCapital: 6.466,
      maxRunupCloseToClose: 641.6,
      maxRunupCloseToClosePercent: 6.4163,
      returnOfMaxDrawdown: 9.2128,
      runupPeriods: 5,
      avgRunupAmount: 146.2,
      avgRunupDurationBars: 118.4,
      drawdownPeriods: 4,
      avgDrawdownAmount: 38.1,
      avgDrawdownDurationBars: 52.5,
    },
    returns: {
      returnOnInitialCapitalPercent: 6.062,
      cagr: 6.2851,
      buyAndHoldReturn: 1_338.55,
      buyAndHoldReturnPercent: 13.3855,
      strategyOutperformance: -732.35,
      sharpeRatio: 0.412,
      sortinoRatio: 1.874,
      riskFreeRate: 2,
      months: 13,
    },
    capital: {
      marginCalls: 0,
      liquidatedQty: 0,
      accountSizeRequired: 412.45,
      returnOnAccountSizeRequiredPercent: 146.97,
      netProfitAsPercentOfLargestLoss: 997.04,
      maxMarginUsed: 390.78,
      avgMarginPerTrade: 364.51,
    },
    trades: [
      trade(
        1,
        'long',
        { id: 'Long', signal: 'Breakout long', time: T(2025, 1, 6, 10), price: 1.0312, bar: 82 },
        { id: 'TP', time: T(2025, 1, 8, 14), price: 1.0365, bar: 134, leg: 'TakeProfit' },
        52.2,
        52.2,
        58,
        12,
      ),
      trade(
        2,
        'short',
        { id: 'Short', time: T(2025, 1, 15, 9), price: 1.03, bar: 293 },
        { id: 'SL', time: T(2025, 1, 16, 12), price: 1.034, bar: 320, leg: 'StopLoss' },
        -40.8,
        11.4,
        9,
        44,
      ),
      trade(
        3,
        'long',
        { id: 'Long', signal: 'Breakout long', time: T(2025, 2, 3, 8), price: 1.025, bar: 704 },
        { id: 'TP', time: T(2025, 2, 10, 16), price: 1.04, bar: 880, leg: 'TakeProfit' },
        149.2,
        160.6,
        161,
        18,
      ),
      trade(
        4,
        'short',
        { id: 'Short', time: T(2025, 3, 4, 10), price: 1.05, bar: 1_210 },
        { id: 'SL', time: T(2025, 3, 6, 15), price: 1.056, bar: 1_263, leg: 'StopLoss' },
        -60.8,
        99.8,
        4,
        71.5,
      ),
      trade(
        5,
        'long',
        { id: 'Long', signal: 'Breakout long', time: T(2025, 4, 1, 7), price: 1.08, bar: 1_847 },
        {
          id: 'Trail',
          signal: 'Trailing exit',
          time: T(2025, 4, 15, 18),
          price: 1.13,
          bar: 2_193,
          leg: 'Trailing',
        },
        499.2,
        599.0,
        512,
        16,
      ),
      trade(
        6,
        'short',
        { id: 'Short', time: T(2025, 6, 2, 9), price: 1.14, bar: 3_000 },
        {
          id: 'Close entry(s) order Short',
          time: T(2025, 6, 3, 11),
          price: 1.1392,
          bar: 3_026,
          leg: '',
        },
        7.2,
        606.2,
        22,
        6,
      ),
      trade(
        7,
        'long',
        { id: 'Long', signal: 'Breakout long', time: T(2026, 1, 5, 8), price: 1.17, bar: 6_146 },
        null,
        35.4,
        null,
        41,
        9,
      ),
    ],
    equityCurve: equityCurve(),
    monthlyReturns: [
      { year: 2025, month: 1, startEquity: 10_000, endEquity: 10_011.4, returnPercent: 0.114 },
      { year: 2025, month: 2, startEquity: 10_011.4, endEquity: 10_160.6, returnPercent: 1.4903 },
      { year: 2025, month: 3, startEquity: 10_160.6, endEquity: 10_099.8, returnPercent: -0.5984 },
      { year: 2025, month: 4, startEquity: 10_099.8, endEquity: 10_599.0, returnPercent: 4.9427 },
      { year: 2025, month: 5, startEquity: 10_599.0, endEquity: 10_599.0, returnPercent: 0 },
      { year: 2025, month: 6, startEquity: 10_599.0, endEquity: 10_606.2, returnPercent: 0.0679 },
      { year: 2025, month: 7, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2025, month: 8, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2025, month: 9, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2025, month: 10, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2025, month: 11, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2025, month: 12, startEquity: 10_606.2, endEquity: 10_606.2, returnPercent: 0 },
      { year: 2026, month: 1, startEquity: 10_606.2, endEquity: 10_641.2, returnPercent: 0.33 },
    ],
    warnings: [
      'PS9101: request.security() on GBPUSD: 12 bars had no lower-timeframe data; the bar magnifier fell back to the OHLC path for them.',
    ],
  };
}

/** PascalCase keys, as a default-serialised host payload (e.g. embedded in BacktestResult). */
export function toPascalCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPascalCaseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k.charAt(0).toUpperCase() + k.slice(1)] = toPascalCaseKeys(v);
    }
    return out;
  }
  return value;
}
