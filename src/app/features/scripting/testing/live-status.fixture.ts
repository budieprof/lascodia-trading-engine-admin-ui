/**
 * The live status endpoint's `closedTrades` / `openTrades` for the session whose report is
 * {@link strategyReportFixture}: the same fills, with the protective levels and origins the
 * report does not carry. Trades #1–#4 are the warm-up replay, #5 and the open #7 paper, #6 live.
 */

const T = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

function closed(
  tradeKey: number,
  direction: 'long' | 'short',
  entryId: string,
  entry: [number, number],
  exit: [number, number, string],
  levels: [number | null, number | null],
  origin: string,
) {
  return {
    tradeKey,
    entryId,
    direction,
    qty: 10_000,
    lots: 0.1,
    entryPrice: entry[1],
    entryTimeMs: entry[0],
    exitPrice: exit[1],
    exitTimeMs: exit[0],
    exitLeg: exit[2],
    exitComment: '',
    profit: null,
    stopLoss: levels[0],
    takeProfit: levels[1],
    origin,
  };
}

export function liveClosedTradesFixture() {
  return [
    closed(
      1,
      'long',
      'Long',
      [T(2025, 1, 6, 10), 1.0312],
      [T(2025, 1, 8, 14), 1.0365, 'TakeProfit'],
      [1.0262, 1.0365],
      'warmup',
    ),
    closed(
      2,
      'short',
      'Short',
      [T(2025, 1, 15, 9), 1.03],
      [T(2025, 1, 16, 12), 1.034, 'StopLoss'],
      [1.034, 1.022],
      'warmup',
    ),
    closed(
      3,
      'long',
      'Long',
      [T(2025, 2, 3, 8), 1.025],
      [T(2025, 2, 10, 16), 1.04, 'TakeProfit'],
      [1.02, 1.04],
      'warmup',
    ),
    closed(
      4,
      'short',
      'Short',
      [T(2025, 3, 4, 10), 1.05],
      [T(2025, 3, 6, 15), 1.056, 'StopLoss'],
      [1.056, 1.04],
      'warmup',
    ),
    closed(
      5,
      'long',
      'Long',
      [T(2025, 4, 1, 7), 1.08],
      [T(2025, 4, 15, 18), 1.13, 'Trailing'],
      [1.07, null],
      'paper',
    ),
    closed(
      6,
      'short',
      'Short',
      [T(2025, 6, 2, 9), 1.14],
      [T(2025, 6, 3, 11), 1.1392, ''],
      [1.146, 1.13],
      'live',
    ),
  ];
}

/** The open trade #7 as the current engine sends it (DEC-18 lots, protective levels, origin). */
export function liveOpenTradeFixture() {
  return {
    tradeKey: 7,
    entryId: 'Long',
    direction: 'long',
    qty: 10_000,
    lots: 0.1,
    entryPrice: 1.17,
    entryTimeMs: T(2026, 1, 5, 8),
    entryBar: 6_146,
    openProfit: 35.4,
    stopLoss: 1.165,
    takeProfit: 1.18,
    mirrored: true,
    signalId: 901,
    origin: 'paper',
  };
}
