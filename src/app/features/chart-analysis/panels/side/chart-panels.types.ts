/**
 * Wire shapes of the chart side panels (SP-I9): notes and ideas (`chart-note`), the pair's sentiment and the account
 * strip (`chart-panels/*`), and the broker's depth of book (`market-data/order-book/latest`).
 */

export type NoteBias = 'Long' | 'Short';

export interface ChartNote {
  id: number;
  symbol: string;
  timeframe: string | null;
  title: string | null;
  text: string;
  bias: NoteBias | null;
  hasSnapshot: boolean;
  /** Only on a single-note read. */
  snapshotDataUrl: string | null;
  layoutId: number | null;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNoteBody {
  symbol: string;
  text: string;
  timeframe?: string | null;
  title?: string | null;
  bias?: NoteBias | null;
  snapshotDataUrl?: string | null;
  layoutId?: number | null;
  isPinned?: boolean;
}

/** Null = unchanged; "" clears an optional field. */
export interface UpdateNoteBody {
  timeframe?: string | null;
  title?: string | null;
  text?: string | null;
  bias?: string | null;
  snapshotDataUrl?: string | null;
  layoutId?: number | null;
  clearLayout?: boolean;
  isPinned?: boolean | null;
}

export interface CurrencySentiment {
  currency: string;
  newsScore: number | null;
  newsConfidence: number | null;
  newsAsOfUtc: string | null;
  newsScore24hAgo: number | null;
  cotReportDate: string | null;
  cotSpeculatorsLong: number | null;
  cotSpeculatorsShort: number | null;
  cotSpeculatorsLongPct: number | null;
  cotNet: number | null;
  cotNetChangeWeekly: number | null;
  cotSmallTradersLong: number | null;
  cotSmallTradersShort: number | null;
  cotOpenInterest: number | null;
}

export interface PairSentiment {
  symbol: string;
  base: string | null;
  quote: string | null;
  baseSentiment: CurrencySentiment | null;
  quoteSentiment: CurrencySentiment | null;
  newsTilt: number | null;
  retailPositioningNote: string;
}

export interface StripPosition {
  id: number;
  tradingAccountId: number;
  symbol: string;
  direction: string;
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number;
  isPaper: boolean;
  openedAt: string;
}

export interface StripOrder {
  id: number;
  tradingAccountId: number;
  symbol: string;
  side: string;
  executionType: string;
  status: string;
  lots: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  tradeSignalId: number | null;
  createdAt: string;
}

export interface StripSignal {
  id: number;
  strategyId: number;
  strategyName: string | null;
  symbol: string;
  direction: string;
  status: string;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  isManual: boolean;
  generatedAt: string;
  expiresAt: string;
}

export interface StripPaperTrade {
  id: number;
  strategyId: number;
  strategyName: string | null;
  symbol: string;
  direction: string;
  lots: number;
  fillPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
}

export interface AccountStrip {
  tradingAccountId: number | null;
  accountName: string | null;
  accountCurrency: string | null;
  isPaperAccount: boolean | null;
  balance: number | null;
  equity: number | null;
  symbol: string;
  openPositions: number;
  unrealizedPnl: number;
  positionsOnSymbol: StripPosition[];
  workingOrders: number;
  ordersOnSymbol: StripOrder[];
  liveSignals: number;
  signalsOnSymbol: StripSignal[];
  openPaperTrades: number;
  paperTradesOnSymbol: StripPaperTrade[];
  asOfUtc: string;
}

/** `market-data/order-book/latest/{symbol}`. */
export interface OrderBookSnapshot {
  id: number;
  symbol: string;
  bidPrice: number;
  askPrice: number;
  bidVolume: number;
  askVolume: number;
  spreadPoints: number;
  /** `{"bids":[{"P":..,"V":..}],"asks":[{"P":..,"V":..}]}` — null for a top-of-book-only broker. */
  levelsJson: string | null;
  instanceId: string;
  capturedAt: string;
}

export type SidePanel = 'notes' | 'depth' | 'sentiment' | 'account';
