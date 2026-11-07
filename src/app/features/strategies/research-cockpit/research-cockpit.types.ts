import type { PromotionGateRowDto } from '@core/api/api.types';

/**
 * Wire shapes of the strategy program's research endpoints (engine master after batch 1-3), camelCase as the API
 * serialises them. Enums arrive as their NAMES (the API's JsonStringEnumConverter). Every field the console does not
 * strictly need is optional so an older engine answer still reads.
 */

// ── S13 ──────────────────────────────────────────────────────────────────
export type PipelineStatus =
  | 'Queued'
  | 'Running'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'
  | 'Skipped';

export interface PipelineStepDto {
  /** `Backtest` | `WalkForward` | `Gates` | `Paper`. */
  name: string;
  status: PipelineStatus | string;
  startedAtUtc?: string | null;
  finishedAtUtc?: string | null;
  runId?: number | null;
  outcome?: string | null;
}

export interface ValidationPipelineDto {
  id: number;
  strategyId: number;
  strategyConfigHash?: string | null;
  status: PipelineStatus | string;
  currentStep: string;
  steps: PipelineStepDto[];
  options?: {
    startPaper?: boolean;
    fromDate?: string | null;
    toDate?: string | null;
    reOptimizePerFold?: boolean | null;
    familyStrategyIds?: number[] | null;
  };
  backtestRunId?: number | null;
  walkForwardRunId?: number | null;
  gatesPassed?: boolean | null;
  /** `{ passed, failureSummary, evidenceBacktestRunId, rows, diagnostics }` — the gate dry run. */
  gateResult?: {
    passed?: boolean;
    failureSummary?: string | null;
    evidenceBacktestRunId?: number | null;
    rows?: PromotionGateRowDto[] | null;
    diagnostics?: string[] | null;
  } | null;
  cancelRequested?: boolean;
  errorMessage?: string | null;
  createdAtUtc?: string;
  updatedAtUtc?: string;
  completedAtUtc?: string | null;
}

export interface StartValidationPipelineRequest {
  startPaper: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  reOptimizePerFold?: boolean | null;
  familyStrategyIds?: number[] | null;
}

// ── V03 ──────────────────────────────────────────────────────────────────
export interface StrategyHoldoutResultDto {
  holdoutId?: number;
  fromUtc?: string;
  toUtc?: string;
  scoredAtUtc?: string;
  strategyId?: number;
  configHash?: string | null;
  trigger?: string;
  bars?: number;
  totalTrades?: number;
  rTrades?: number;
  netProfit?: number;
  sharpeRatio?: number;
  expectancyR?: number | null;
  sharpeR?: number | null;
  /** PERCENT. */
  maxDrawdownPct?: number;
  /** FRACTION 0..1. */
  winRate?: number;
  /** 9999 = no losing trades. */
  profitFactor?: number;
  touchedByRuns?: number;
  unscorable?: string | null;
}

export interface StrategyHoldoutDto {
  id: number;
  lineageRootStrategyId: number;
  createdForStrategyId?: number;
  symbol?: string;
  timeframe?: string;
  fromUtc: string;
  toUtc: string;
  /** `Locked` | `Spent`. */
  status: string;
  /** `Record` | `Enforce`. */
  mode: string;
  modeReason?: string | null;
  createdAtUtc?: string;
  spentAtUtc?: string | null;
  spentByStrategyId?: number | null;
  spentConfigHash?: string | null;
  spentTrigger?: string | null;
  result?: StrategyHoldoutResultDto | null;
  spentOnCurrentConfiguration?: boolean | null;
}

// ── V16 ──────────────────────────────────────────────────────────────────
export interface LabTrialDto {
  label?: string | null;
  inputs?: Record<string, unknown> | null;
  inputsByTitle?: Record<string, unknown> | null;
  windowFromUtc: string;
  windowToUtc: string;
  tradeR: number[];
  dataHash: string;
  codeHash: string;
}

export interface ImportLabTrialsResultDto {
  lineageRootStrategyId: number;
  imported: number;
  duplicates: number;
  reproductionsQueued: number;
  trialIds: number[];
  notes: string[];
}

// ── C9 ───────────────────────────────────────────────────────────────────
export interface BacktestRunDiffDto {
  leftId: number;
  rightId: number;
  sameDataFingerprint: boolean;
  sameManifestInputs: boolean;
  /** `identical` | `reproduced` | `inputs differ` | `results differ`. */
  verdict: string;
  manifest: { path: string; left: string | null; right: string | null }[];
  /** Units as on the result: TotalReturn / MaxDrawdownPct PERCENT, WinRate FRACTION. */
  metrics: { metric: string; left: number | null; right: number | null; delta: number | null }[];
  trades: {
    leftTrades: number;
    rightTrades: number;
    identical: number;
    changed: number;
    onlyLeft: number;
    onlyRight: number;
    firstDivergenceUtc: string | null;
    differences: {
      entryTime: string;
      direction: string;
      leftExitTime: string | null;
      rightExitTime: string | null;
      leftExitPrice: number | null;
      rightExitPrice: number | null;
      leftPnL: number | null;
      rightPnL: number | null;
      kind: string;
    }[];
  } | null;
  notes: string[];
}
