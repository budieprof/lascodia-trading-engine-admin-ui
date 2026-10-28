/**
 * Wire shapes of the engine's venue / exchange-traded console APIs (multi-asset WS7 7.5–7.10, engine branch
 * `ma/console-api`, plus exec-gateway's `execution/*`). Enums of exec-gateway's DTOs may arrive as names or numbers
 * (the engine has no global string-enum converter) — read them through the `*Name` helpers in `venues.logic.ts`.
 */

// ── execution/* (exec-gateway) ────────────────────────────────────────────────────────────────────

export interface ExecutionCapabilities {
  directOrderPlacement: boolean;
  entryModel: string;
  modifyOrder: boolean;
  cancelOrder: boolean;
  closePosition: boolean;
  partialClose: boolean;
  positionStops: boolean;
  nativeCancelAll: boolean;
  venueEnforcesClientOrderId: boolean;
  asynchronousOutcome: boolean;
  orderTypes: (string | number)[];
  timeInForce: (string | number)[];
  positionModel: string;
  quantityUnit: string | number;
}

export interface ExecutionAdapter {
  kind: string;
  requiresCredential: boolean;
  capabilities: ExecutionCapabilities;
}

export interface ExecutionCredentialStatus {
  executionAccountId: number;
  status: string;
  keyFingerprint: string;
  observedPermissions: string | null;
  verifiedAtUtc: string | null;
  lastUsedAtUtc: string | null;
  /** The engine's reason (e.g. the withdrawal-rights refusal); null when none. */
  reason: string | null;
}

export interface ExecutionAccount {
  id: number;
  name: string;
  adapterKind: string;
  venue: string;
  externalAccountId: string | null;
  tradingAccountId: number | null;
  mode: string;
  status: string;
  currency: string | null;
  lastConnectResult: string | null;
  lastConnectedAtUtc: string | null;
  createdAtUtc: string;
  credential: ExecutionCredentialStatus | null;
}

export interface CreateExecutionAccountBody {
  name: string;
  adapterKind: string;
  venue: string;
  externalAccountId?: string | null;
  tradingAccountId?: number | null;
  mode: 'Paper' | 'Live';
  currency?: string | null;
}

export interface ExecutionDrift {
  kind: string | number;
  symbol: string;
  venueId: string | null;
  engineId: number | null;
  engineQuantity: number | null;
  venueQuantity: number | null;
}

export interface ExecutionAccountReconciliation {
  adapterKind: string;
  executionAccountId: number | null;
  tradingAccountId: number | null;
  atUtc: string;
  enginePositions: number;
  venuePositions: number;
  engineOrders: number;
  venueOrders: number;
  drift: ExecutionDrift[];
  skipped: string | null;
  actions?: string[];
}

// ── execution-console/* (console-api) ─────────────────────────────────────────────────────────────

export type AccountHealth = 'ok' | 'idle' | 'attention' | 'off';

export interface ExecutionAccountHealth {
  executionAccountId: number;
  name: string;
  adapterKind: string;
  venue: string;
  mode: string;
  status: string;
  tradingAccountId: number | null;
  credentialStatus: string | null;
  credentialFingerprint: string | null;
  credentialVerifiedAtUtc: string | null;
  credentialLastUsedAtUtc: string | null;
  lastConnectResult: string | null;
  lastConnectedAtUtc: string | null;
  instructions24h: Record<string, number>;
  oldestUnsentAgeSeconds: number | null;
  lastFailure: string | null;
  lastFailureAtUtc: string | null;
  lastFillAtUtc: string | null;
  fills24h: number;
  fillsCursorUtc: string | null;
  protectiveLegsWorking: number;
  protectiveLegsFailed: number;
  health: AccountHealth;
  problems: string[];
}

export interface ExecutionWorkerHealth {
  workerName: string;
  isRunning: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  consecutiveFailures: number;
}

export interface ExecutionHealth {
  switches: Record<string, string>;
  accounts: ExecutionAccountHealth[];
  workers: ExecutionWorkerHealth[];
}

export type VenueOrderType = 'Market' | 'Limit' | 'Stop' | 'StopLimit';
export type VenueTif = 'Gtc' | 'Ioc' | 'Fok' | 'Day';
export type MarginMode = 'Isolated' | 'Cross';

export interface VenueTicketPreviewRequest {
  executionAccountId?: number | null;
  tradingAccountId?: number | null;
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: VenueOrderType;
  quantity: number;
  price?: number | null;
  stopPrice?: number | null;
  timeInForce: VenueTif;
  postOnly: boolean;
  reduceOnly: boolean;
  leverage?: number | null;
  marginMode?: MarginMode | null;
  stopLossTicks?: number | null;
  takeProfitTicks?: number | null;
}

/**
 * `POST trade-signal/venue-ticket` (engine exec-polish, `SubmitVenueTicketCommand`): the preview body with the venue
 * execution account REQUIRED. `leverage` / `marginMode` are accepted for shape parity but preview-only (the dispatcher
 * applies the account's `Risk:MultiAsset:Crypto:*`).
 */
export interface VenueTicketSendRequest extends Omit<
  VenueTicketPreviewRequest,
  'executionAccountId' | 'tradingAccountId'
> {
  executionAccountId: number;
}

/** `VenueTicketResultDto`: `-11` refused (reason in `message`), `-14` account not found, `00` placed. */
export interface VenueTicketResult {
  placed: boolean;
  message: string;
  tradeSignalId: number | null;
  manualStrategyId: number | null;
  preview: VenueTicketPreview | null;
}

export interface VenueTicketCheck {
  name: string;
  ok: boolean;
  blocking: boolean;
  message: string;
}

export interface VenueTicketMargin {
  model: string;
  initialMargin: number;
  maintenanceMargin: number;
  liquidationPrice: number | null;
  leverage: number | null;
  basis: string;
  refusal: string | null;
}

export interface VenueTicketPreview {
  symbol: string;
  assetClass: string;
  instrumentKind: string;
  quantityUnit: string;
  tickSize: number;
  tickValue: number;
  multiplier: number;
  quantityStep: number;
  minQuantity: number;
  maxQuantity: number;
  priceDecimals: number;
  quoteCurrency: string;
  accountCurrency: string;
  accountEquity: number | null;
  quoteToAccountRate: number | null;
  referencePrice: number | null;
  referencePriceSource: string;
  bid: number | null;
  ask: number | null;
  notionalQuote: number | null;
  notionalAccount: number | null;
  margin: VenueTicketMargin | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  riskMoney: number | null;
  rewardMoney: number | null;
  riskPctOfEquity: number | null;
  feeEstimate: number | null;
  feeBasis: string | null;
  accountLeverage: number | null;
  accountMarginMode: string | null;
  multiAssetRiskEnabled: boolean;
  sessionOpen: boolean;
  sessionKind: string | null;
  valid: boolean;
  checks: VenueTicketCheck[];
  notes: string[];
}

// ── reference/* (console-api) ─────────────────────────────────────────────────────────────────────

export type FeeAssetClass = 'Future' | 'Crypto' | 'Equity' | 'Etf';

export interface FeeScheduleFields {
  code: string;
  assetClass: FeeAssetClass;
  venue: string;
  scope: string | null;
  currency: string;
  commissionPerContract: number | null;
  exchangeFeePerContract: number | null;
  clearingFeePerContract: number | null;
  regulatoryFeePerContract: number | null;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  tierMinVolume30d: number | null;
  commissionPerShare: number | null;
  commissionBps: number | null;
  minCommissionPerOrder: number | null;
  maxCommissionPctOfNotional: number | null;
  secFeePerMillion: number | null;
  finraTafPerShare: number | null;
  finraTafMaxPerTrade: number | null;
  borrowFeeAnnualPct: number | null;
  slippageTicks: number | null;
  effectiveFromUtc: string;
  effectiveToUtc: string | null;
  source: string;
  notes: string | null;
}

export interface FeeSchedule extends FeeScheduleFields {
  id: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  isDeleted: boolean;
  inForce: boolean;
}

export type MarginKind = 'FuturesContract' | 'CryptoLeverageTier' | 'Equity';

export interface MarginRequirementFields {
  kind: MarginKind;
  symbol: string;
  venue: string;
  currency: string;
  initialMargin: number | null;
  maintenanceMargin: number | null;
  intradayInitialMargin: number | null;
  intradayMaintenanceMargin: number | null;
  notionalFloor: number | null;
  notionalCap: number | null;
  maxLeverage: number | null;
  initialMarginRate: number | null;
  maintenanceMarginRate: number | null;
  maintenanceAmount: number | null;
  effectiveFromUtc: string;
  source: string;
}

export interface MarginRequirement extends MarginRequirementFields {
  id: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  isDeleted: boolean;
  inForce: boolean;
}

/** `POST reference/margin-requirements/import` — all or nothing; existing rows are never overwritten. */
export interface MarginImportResult {
  dryRun: boolean;
  /** Rows added (dry run: rows that would be added). */
  inserted: number;
  /** Rows whose kind, symbol, venue, start and notional floor already exist (live or deleted) — left alone. */
  alreadyPresent: number;
  /** One line per problem ("line 4: …"); any error means nothing was imported. */
  errors: string[];
  rows: MarginRequirement[];
}

// ── instrument-candles/state ──────────────────────────────────────────────────────────────────────

export interface InstrumentCandleCursor {
  id: number;
  symbol: string;
  kind: string;
  sourceId: string | null;
  root: string | null;
  builtFromUtc: string | null;
  builtToUtc: string | null;
  status: string;
  note: string | null;
  barsWritten: number;
  tradesRead: number;
  tradesExcluded: number;
  updatedAtUtc: string;
  lagMinutes: number | null;
}

export interface ContinuousFutureRoll {
  id: number;
  continuousSymbol: string;
  root: string;
  fromContract: string;
  toContract: string;
  rollUtc: string;
  fromPrice: number | null;
  toPrice: number | null;
  gap: number;
  ratio: number;
  priceSource: string;
  observedAtUtc: string | null;
  computedAtUtc: string;
}

export interface InstrumentCandleState {
  builderEnabled: boolean;
  continuousAdjustment: string | null;
  cursors: InstrumentCandleCursor[];
  rolls: ContinuousFutureRoll[];
  statusCounts: Record<string, number>;
}

// ── instrument-fundamentals/* ─────────────────────────────────────────────────────────────────────

export interface EquityCorporateAction {
  kind: string;
  exDate: string;
  ratio: number | null;
  cashAmount: number | null;
  currency: string | null;
  newSymbol: string | null;
  source: string;
  upcoming: boolean;
}

export interface EquityFundamentals {
  symbol: string;
  description: string | null;
  primaryExchange: string | null;
  shortable: boolean | null;
  currency: string;
  trailingDividendsPerShare: number;
  lastPrice: number | null;
  lastPriceAtUtc: string | null;
  trailingYieldPct: number | null;
  nextExDate: EquityCorporateAction | null;
  lastSplit: EquityCorporateAction | null;
  actions: EquityCorporateAction[];
  earningsAvailable: boolean;
  notes: string[];
}

export interface FuturesCurvePoint {
  contract: string;
  expiryUtc: string | null;
  lastTradeUtc: string | null;
  firstNoticeUtc: string | null;
  rollUtc: string | null;
  isFront: boolean;
  daysToLastTrade: number | null;
  tradeDate: string | null;
  sourceId: string | null;
  settlement: number | null;
  settlementFinal: boolean | null;
  openInterest: number | null;
  openInterestChange: number | null;
  volume: number | null;
}

export interface FuturesTermStructure {
  root: string;
  exchange: string | null;
  description: string | null;
  currency: string | null;
  multiplier: number | null;
  continuousSymbol: string | null;
  contractSource: 'master' | 'catalog';
  curve: FuturesCurvePoint[];
  slopeAnnualPct: number | null;
  totalOpenInterest: number | null;
  entitledSources: string[];
  notes: string[];
}

export interface CryptoFundamentals {
  symbol: string;
  sourceId: string;
  kind: string | null;
  fundingIntervalHours: number | null;
  mark: number | null;
  index: number | null;
  basisBps: number | null;
  fundingRate: number | null;
  fundingAnnualPct: number | null;
  fundingMean24h: number | null;
  nextFundingT: number | null;
  openInterest: number | null;
  openInterestChange24hPct: number | null;
  liquidationBuyNotional24h: number;
  liquidationSellNotional24h: number;
  liquidationCount24h: number;
  ageMs: number | null;
  notes: string[];
}
