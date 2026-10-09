/**
 * Shapes for LLM analysis on the main chart (SP-I5) — `GET market-data/analysis-monitors/chart` (engine
 * `GetChartAnalysisMonitorsQuery`) and the Structure Watch fields of `POST market-data/analysis-monitors`.
 */
import type { CreateMonitorRequest } from '@features/analysis-monitors/analysis-monitors.types';

/** A price a watch waits at or guards, derived by the engine from its specs and plan. */
export interface ChartMonitorLevel {
  price: number;
  kind: 'trigger' | 'invalidation' | 'entry' | 'stop' | 'target';
  /** In words: "wakes when price goes above", "plan stop". */
  label: string;
}

/** One watch on the chart's symbol. */
export interface ChartMonitor {
  id: number;
  /** 'Active' | 'Paused' | 'Triggered' | 'Cancelled' | 'Expired' | 'Invalidated' | 'Error'. */
  status: string;
  /** 'operator' | 'assistant' | 'hunter' | 'spot-watch' | 'patient-trader' | … */
  origin: string;
  timeframe: string;
  intentText: string;
  plannedDirection?: string | null;
  createdAtUtc: string;
  expiresAtUtc: string;
  lastTriggeredAtUtc?: string | null;
  anchorLlmInvocationId?: number | null;
  lastResultLlmInvocationId?: number | null;
  lastEvalNote?: string | null;
  isStructureWatch: boolean;
  scriptStep?: number | null;
  scriptReadyAtUtc?: string | null;
  scriptLastReading?: string | null;
  levels: ChartMonitorLevel[];
}

/** Something a watch did inside the chart's window. */
export interface ChartMonitorEvent {
  monitorId: number;
  kind: 'Fired' | 'Touched' | 'Invalidated' | 'ScriptStep' | string;
  occurredAtUtc: string;
  fired: boolean;
  note?: string | null;
  observedMid?: number | null;
  resultLlmInvocationId?: number | null;
}

export interface ChartAnalysisMonitors {
  symbol: string;
  monitors: ChartMonitor[];
  events: ChartMonitorEvent[];
  monitorsTruncated: boolean;
  eventsTruncated: boolean;
}

/** `POST market-data/analysis-monitors` with a Structure Watch script ("Watch this"). */
export interface StructureWatchRequest extends CreateMonitorRequest {
  /** Pine v6 indicator following the watch contract (armedAt input; plots step / ready / broken). */
  scriptSource: string;
  /** The step the operator says the market is on now; the engine refuses a script that disagrees. */
  expectStepNow?: number;
  /** "Buy" | "Sell" — the trade the watch waits for, when there is one. */
  plannedDirection?: string | null;
  origin?: string;
  planEntryPrice?: number | null;
  planStopPrice?: number | null;
  planTargetPrice?: number | null;
}

/** What one analysis decided, in the patient analysis' three words. */
export type AnalysisOutcome = 'TRADE NOW' | 'WATCH' | 'STAND ASIDE';

/** How an analysis is asked for from the chart: free (spot) or directed at a side and an order type. */
export type AnalysisRequestMode = 'spot' | 'limitBuy' | 'limitSell' | 'stopBuy' | 'stopSell';
