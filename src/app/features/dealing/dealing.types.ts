/**
 * Wire shapes of the broker dealing desk (engine `docs/api/dealing-api.md`, enterprise program wave 2). Served by the
 * engine's research process (`dealing/*`). Markouts are pips, POSITIVE = the price moved in the client's favour after
 * the fill. Every A/B-book field is ADVISORY: the platform never acts on it.
 */

export type DealingSide = 'Buy' | 'Sell' | number;
export type DealingLeg = 'Open' | 'Close' | number;
export type MarkoutStatus = 'Complete' | 'Partial' | 'Pending' | 'NoQuotes' | 'NotEntitled' | 'UnknownSymbol' | number;

export type Classification = 'insufficient-data' | 'benign' | 'watch' | 'toxic';
export type Suggestion = 'none' | 'a-book-candidate' | 'b-book-candidate' | 'no-change';

export interface HorizonStat {
  horizonMs: number;
  n: number;
  mean: number | null;
  volumeWeightedMean: number | null;
  stdDev: number | null;
  ci95: number | null;
  tStat: number | null;
}

export interface ClientFlowProfile {
  feedId: string;
  login: string;
  group: string | null;
  fills: number;
  markedFills: number;
  volumeLots: number;
  markouts: HorizonStat[];
  meanFillVsMidPips: number | null;
  latencyArbFills: number;
  latencyArbShare: number;
  closedTrades: number;
  shortHolds: number;
  shortHoldShare: number;
  medianHoldSeconds: number | null;
  firstFillUtc: string | null;
  lastFillUtc: string | null;
  toxicity: number | null;
  classification: Classification | string;
  suggestion: Suggestion | string;
  reasons: string[];
}

export interface ToxicityParameters {
  minFills: number;
  aBookThreshold: number;
  shortHoldSeconds: number;
}

export interface DealingClientRow {
  profile: ClientFlowProfile;
  openTrades: number;
  openNetLots: Record<string, number>;
  realisedProfit: number | null;
}

export interface DealingClients {
  rows: DealingClientRow[];
  totalClients: number;
  fillsRead: number;
  truncated: boolean;
  parameters: ToxicityParameters;
  methodology: string;
  disclaimer: string;
}

export interface DealingFill {
  id: number;
  origin: string | number;
  leg: DealingLeg;
  symbol: string;
  side: DealingSide;
  volumeLots: number;
  fillTimeUtc: string;
  fillPrice: number;
  holdSeconds: number | null;
  sourceId: string | null;
  midAtFill: number | null;
  fillVsMidPips: number | null;
  markout1s: number | null;
  markout5s: number | null;
  markout30s: number | null;
  markout60s: number | null;
  markout300s: number | null;
  leadGapPips: number | null;
  leadSourceId: string | null;
  latencyArbFlag: boolean;
  status: MarkoutStatus;
  note: string | null;
}

export interface HoldBucket {
  label: string;
  upToSeconds: number;
  trades: number;
  meanCloseMarkout60s: number | null;
}

export interface DealingClientDetail {
  profile: ClientFlowProfile;
  symbols: { symbol: string; fills: number; volumeLots: number; markouts: HorizonStat[] }[];
  holdHistogram: HoldBucket[];
  recentFills: DealingFill[];
  latencyArbFills: DealingFill[];
  openTrades: { externalId: string; symbol: string; side: DealingSide; volumeLots: number; openPrice: number; openTimeUtc: string }[];
  truncated: boolean;
  parameters: ToxicityParameters;
  methodology: string;
  disclaimer: string;
}

export type CurveDimension = 'client' | 'group' | 'symbol' | 'feed' | 'leg';

export interface CurveSeries {
  key: string;
  fills: number;
  volumeLots: number;
  markouts: HorizonStat[];
}

export interface DealingCurves {
  dimension: CurveDimension | string;
  all: CurveSeries;
  series: CurveSeries[];
  truncated: boolean;
  methodology: string;
}

export interface DealingAbBookReport {
  advisory: boolean;
  disclaimer: string;
  methodology: string;
  generatedAtUtc: string;
  fromUtc: string;
  toUtc: string;
  parameters: ToxicityParameters;
  countsBySuggestion: Record<string, number>;
  rows: ClientFlowProfile[];
  truncated: boolean;
}

export interface DealingAlert {
  severity: 'critical' | 'warning' | 'info' | string;
  kind: string;
  key: string;
  message: string;
  atUtc: string | null;
}

export interface LpSourceStats {
  sourceId: string;
  displayName: string | null;
  kind: string | null;
  samples: number;
  liveShare: number;
  atBestBidShare: number;
  atBestAskShare: number;
  atBestEitherShare: number;
  meanSpreadPips: number | null;
  meanInsideContributionPips: number | null;
  meanQuoteAgeMs: number | null;
  p95QuoteAgeMs: number | null;
  staleShare: number;
  ticks: number;
}

export interface DealingLpAnalytics {
  symbol: string;
  from: number;
  to: number;
  sampleMs: number;
  staleMs: number;
  pipSize: number;
  sources: LpSourceStats[];
  window: { samples: number; multiSourceSamples: number; meanInsideSpreadPips: number | null; crossedOrLockedSamples: number };
  dispersion: { sourceId: string; minutes: number; meanAbsDevPips: number | null; meanArrivalLagMs: number | null; maxArrivalLagMs: number | null }[];
  ownOrders: { sourceId: string; brokerServer: string; orders: number; filled: number; rejected: number; rejectRate: number; meanSubmitToFillMs: number | null }[];
  denied: string[];
  notes: string[];
  rejectLastLook: string;
  methodology: string;
}

export interface DealingFeed {
  feedId: string;
  displayName: string;
  serverName: string | null;
  writerInstanceIds: string[];
  priceSourceId: string | null;
  enabled: boolean;
  createdAtUtc: string;
  updatedAtUtc: string | null;
  lastIngestAtUtc: string | null;
  trades: number;
  openTrades: number;
}

export interface UpsertDealingFeedBody {
  feedId: string;
  displayName?: string;
  serverName?: string;
  writerInstanceIds?: string[];
  /** '' clears it (the default rule). */
  priceSourceId?: string;
  enabled?: boolean;
}

/** The window + filters every read takes. */
export interface DealingWindow {
  fromUtc: string;
  toUtc: string;
  feedId?: string | null;
  group?: string | null;
  symbol?: string | null;
  minFills?: number | null;
  aBookThreshold?: number | null;
  shortHoldSeconds?: number | null;
}
