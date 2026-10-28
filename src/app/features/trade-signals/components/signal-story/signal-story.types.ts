/** Wire shape of GET trade-signal/{id}/story (engine pages program, 2026-10-28). */
export interface SignalStoryCounts {
  accountAttempts: number;
  accountsPassed: number;
  accountsBlocked: number;
  orders: number;
  ordersFilled: number;
  positions: number;
  positionsOpen: number;
  realizedPnL: number;
  eaRejections: number;
  engineRejections: number;
}

export type SignalStoryTone = 'ok' | 'warn' | 'bad' | 'info';

export interface SignalStoryEvent {
  at: string;
  kind: string;
  title: string;
  detail: string | null;
  tone: SignalStoryTone;
  route: string | null;
}

export interface SignalStoryGate {
  gate: string;
  verdict: string;
  detail: string | null;
  at: string | null;
  passed: boolean;
}

export interface SignalStoryOrigin {
  kind: 'recommendation' | 'patient-plan' | 'parked-rec' | 'analyser-decision' | string;
  recommendationId: number | null;
  pendingSignalRecId: number | null;
  patientTraderPlanId: number | null;
  analyserDecisionId: number | null;
  summary: string | null;
  rationale: string | null;
  confidence: number | null;
  at: string | null;
}

export interface SignalStoryReview {
  outcomeKind: string;
  outcome: string;
  closeReason: string;
  realizedPnL: number | null;
  realizedPips: number | null;
  resolvedAtUtc: string;
  status: string;
}

export interface SignalStoryCost {
  fills: number;
  avgTotalCostBps: number;
  totalCost: number;
  avgSignalToFillMs: number;
}

export interface SignalStory {
  id: number;
  exists: boolean;
  totalSignals: number;
  earliestId: number | null;
  earliestGeneratedAt: string | null;
  latestId: number | null;
  previousId: number | null;
  nextId: number | null;
  strategyName: string | null;
  strategyType: string | null;
  strategyStatus: string | null;
  llmInvocationId: number | null;
  analysisMonitorId: number | null;
  sweepRunId: string | null;
  gateBypassReason: string | null;
  atrAtGeneration: number | null;
  triggeredAt: string | null;
  ghostOutcome: string | null;
  ghostPnLPips: number | null;
  ghostResolvedAt: string | null;
  counts: SignalStoryCounts;
  timeline: SignalStoryEvent[];
  gates: SignalStoryGate[];
  origin: SignalStoryOrigin | null;
  review: SignalStoryReview | null;
  cost: SignalStoryCost | null;
}
