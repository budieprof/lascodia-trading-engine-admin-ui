/**
 * Execution algorithms and block allocation (gaps program, execution) — the engine's
 * `execution/*` DTOs (engine `docs/api/execution-algo-api.md`).
 */

export type ExecutionAlgorithm = 'Direct' | 'TWAP' | 'VWAP' | 'Iceberg' | 'Adaptive';
export type AlgoOrderStatus = 'Working' | 'Paused' | 'Completed' | 'Cancelled' | 'Failed' | 'Expired';
export type AllocationMethod = 'ProRataEquity' | 'EqualRisk' | 'FixedRatio' | 'Kelly';

export interface AlgoOrderSummary {
  id: number;
  tradingAccountId: number;
  accountName: string | null;
  strategyId: number;
  tradeSignalId: number | null;
  blockOrderId: number | null;
  symbol: string;
  side: 'Buy' | 'Sell';
  algorithm: ExecutionAlgorithm;
  status: AlgoOrderStatus;
  statusReason: string | null;
  source: string;
  totalQuantity: number;
  sentQuantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  arrivalPrice: number | null;
  slippagePips: number | null;
  childrenSent: number;
  childrenFilled: number;
  childrenRefused: number;
  startAtUtc: string;
  endAtUtc: string;
  nextSliceAtUtc: string | null;
  completedAtUtc: string | null;
  cancelRequested: boolean;
}

export interface AlgoChild {
  orderId: number;
  sliceIndex: number;
  status: string;
  quantity: number;
  filledQuantity: number | null;
  filledPrice: number | null;
  brokerOrderId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  filledAt: string | null;
}

export interface AlgoPlanSlice {
  index: number;
  quantity: number;
  atUtc: string;
  actedOn: boolean;
}

export interface AlgoEvent {
  id: number;
  kind: string;
  message: string;
  orderId: number | null;
  tradeSignalId: number | null;
  data: Record<string, unknown> | null;
  occurredAtUtc: string;
}

export interface AlgoOrderDetail {
  order: AlgoOrderSummary;
  executionType: string | null;
  limitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  params: Record<string, unknown> | null;
  plan: AlgoPlanSlice[];
  children: AlgoChild[];
  timeline: AlgoEvent[];
}

export interface AlgoOrderPage {
  items: AlgoOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** Engine ConfigDataType: 0 String, 1 Int, 2 Decimal, 3 Bool. */
export type ConfigDataType = 0 | 1 | 2 | 3 | 'String' | 'Int' | 'Decimal' | 'Bool';

export interface ExecutionKey {
  key: string;
  value: string | null;
  default: string;
  dataType: ConfigDataType;
  description: string;
  lastChangedAtUtc: string | null;
  lastChangedBy: string | null;
}

export interface JobStatus {
  jobName: string;
  lastStartedAtUtc: string | null;
  lastFinishedAtUtc: string | null;
  lastOutcome: string | null;
  lastMessage: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  nextRunAtUtc: string | null;
  runRequestedAtUtc: string | null;
  runRequestedBy: string | null;
}

export interface ExecutionSettings {
  keys: ExecutionKey[];
  canEdit: boolean;
  worker: JobStatus;
  workingParents: number;
  pausedParents: number;
  openBlocks: number;
  routerDecisions24h: number;
  routerWouldUseAlgo24h: number;
  operatorNotes: string[];
}

export interface RouterDecisionPage {
  items: AlgoEvent[];
  total: number;
}

export interface AllocationMember {
  tradingAccountId: number;
  accountName?: string | null;
  accountId?: string | null;
  currency?: string | null;
  equity?: number;
  ratio: number;
  isActive: boolean;
}

export interface AllocationGroup {
  id: number;
  name: string;
  description: string | null;
  strategyId: number;
  strategyName: string | null;
  method: AllocationMethod;
  blockLotMultiplier: number;
  riskFraction: number;
  maxKellyFraction: number;
  averagePriceAllocation: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAtUtc: string;
  updatedBy: string | null;
  members: AllocationMember[];
  blocks: number;
  allocationEnabled: boolean;
}

export interface SaveAllocationGroup {
  name: string;
  description: string | null;
  strategyId: number;
  method: AllocationMethod;
  blockLotMultiplier: number;
  riskFraction: number;
  maxKellyFraction: number;
  averagePriceAllocation: boolean;
  isActive: boolean;
  members: AllocationMember[];
}

export interface AllocationPreviewRequest {
  draft?: SaveAllocationGroup | null;
  symbol: string;
  direction: 'Buy' | 'Sell';
  lots: number;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  mlConfidence: number | null;
}

export interface AllocationShare {
  tradingAccountId: number;
  accountName: string | null;
  equity: number;
  fraction: number;
  lots: number;
  note: string | null;
}

export interface AllocationPreview {
  methodUsed: AllocationMethod;
  totalLots: number;
  note: string | null;
  shares: AllocationShare[];
}

export interface BlockAllocation {
  tradingAccountId: number;
  accountName: string | null;
  fraction: number;
  targetLots: number;
  accountEquity: number;
  orderId: number | null;
  algoOrderId: number | null;
  filledLots: number;
  venueAveragePrice: number | null;
  allocatedAveragePrice: number | null;
  priceAdjustment: number | null;
  fairnessAmount: number | null;
  status: string;
  reason: string | null;
}

export interface BlockOrder {
  id: number;
  allocationGroupId: number;
  groupName: string | null;
  tradeSignalId: number;
  symbol: string;
  direction: 'Buy' | 'Sell';
  method: AllocationMethod;
  totalLots: number;
  filledLots: number;
  averagePrice: number | null;
  contractSize: number | null;
  status: 'Open' | 'Allocated' | 'Unfilled';
  notes: string | null;
  createdAt: string;
  allocatedAtUtc: string | null;
  allocations: BlockAllocation[];
  allocationNote: string;
}
