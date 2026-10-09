/**
 * Trading from the chart (SP-I3 / SP-I4): the engine's manual-ticket contract (`POST trade-signal/preview`,
 * `POST trade-signal/manual`, engine `docs/api/manual-trading-api.md`). Kept here, not in the generated schema, until
 * the coordinator regenerates it.
 */

export type TicketMode = 'Paper' | 'Live';
export type TicketDirection = 'Buy' | 'Sell';

/** The body of both ticket endpoints. No lot field: lots come from the account's risk profile. */
export interface ManualTradeRequest {
  tradingAccountId: number;
  symbol: string;
  direction: TicketDirection;
  /** Null = at market (the ask for a buy, the bid for a sell). */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  mode: TicketMode;
}

/** One check of a manual action. `blocking: false` = shown for information. */
export interface TradeGate {
  key: string;
  name: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface ManualTradeAccount {
  id: number;
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  equity: number;
  balance: number;
  riskProfileId: number | null;
  riskProfileName: string | null;
}

export interface ManualTradeAtr {
  value: number;
  pips: number;
  timeframe: string;
  period: number;
  minStopMultiple: number;
  /** The closest stop level the guard allows for this entry; null without an ATR. */
  minStopLevel: number | null;
  stopInAtr: number | null;
}

export interface ManualTradeSwap {
  swapLong: number;
  swapShort: number;
  unit: string;
  /** One lot, one night, this side, account currency (negative = charged); null when not convertible. */
  perLotPerNight: number | null;
  perNight: number | null;
  source: string;
}

export interface ManualTradeExposure {
  openPositions: number;
  openPositionsAfter: number;
  symbolNetLots: number;
  symbolNetLotsAfter: number;
  currencies: { currency: string; before: number; after: number }[];
}

/** The dry run of a ticket. */
export interface ManualTradePreview {
  canSubmit: boolean;
  refusedReason: string | null;
  mode: TicketMode;
  account: ManualTradeAccount;
  manualStrategyId: number | null;
  symbol: string;
  direction: TicketDirection;
  digits: number;
  pipSize: number;
  quote: { bid: number; ask: number; spreadPips: number; ageSeconds: number } | null;
  entry: number;
  entryAtMarket: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
  stopPips: number | null;
  targetPips: number | null;
  rewardRisk: number | null;
  atr: ManualTradeAtr | null;
  lots: number | null;
  lotsAfterRiskCheck: number | null;
  pipValuePerLot: number | null;
  riskMoney: number | null;
  riskPctOfEquity: number | null;
  rewardMoney: number | null;
  swap: ManualTradeSwap | null;
  exposure: ManualTradeExposure | null;
  gates: TradeGate[];
  notes: string[];
}

/** What a submission did. */
export interface ManualTradeResult {
  mode: TicketMode;
  tradeSignalId: number | null;
  paperExecutionId: number | null;
  manualStrategyId: number;
  preview: ManualTradePreview;
  message: string;
}
