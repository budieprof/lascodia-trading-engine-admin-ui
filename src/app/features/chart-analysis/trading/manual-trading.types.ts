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

/** `POST position/{id}/change-preview` — the confirm dialog of a stop / target move or a (partial) close (SP-I3). */
export interface PositionChangePreview {
  positionId: number;
  tradingAccountId: number;
  accountId: string;
  accountName: string;
  accountType: string;
  currency: string;
  symbol: string;
  isLong: boolean;
  openLots: number;
  entry: number;
  initialStop: number | null;
  currentStop: number | null;
  currentTarget: number | null;
  /** Bid for a long, ask for a short; null without a fresh quote. */
  triggerPrice: number | null;
  pipSize: number;
  pipValuePerLot: number | null;
  atr: ManualTradeAtr | null;
  newStop: number | null;
  stopDistancePips: number | null;
  stopDistanceAtr: number | null;
  pnlAtNewStop: number | null;
  rAtNewStop: number | null;
  newTarget: number | null;
  pnlAtNewTarget: number | null;
  rAtNewTarget: number | null;
  closeLots: number | null;
  closePnl: number | null;
  gates: TradeGate[];
  canApply: boolean;
  refusedReason: string | null;
}

/** `GET position/command-status?correlationId=` — the EA command an operator action queued. */
export interface EaCommandStatus {
  commandId: number;
  commandType: string;
  symbol: string;
  targetTicket: number | null;
  acknowledged: boolean;
  /** True = applied; false = refused (or retries ran out); null = not acknowledged yet. */
  succeeded: boolean | null;
  result: string | null;
  retryCount: number;
  createdAt: string;
  acknowledgedAt: string | null;
}
