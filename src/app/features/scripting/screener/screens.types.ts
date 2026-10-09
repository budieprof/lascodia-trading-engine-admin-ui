import type { ScreenerAlert, ScreenerRow } from '../api/scripting-api.types';

// ============================================================
// Screener v2 and saved screens — wire types (scripting API §6, §6a)
// ============================================================

/** §6 request with the options added for saved screens (chart script / strategy by id, extra timeframes, forming bar). */
export interface ScreenerRequestV2 {
  source?: string;
  libraryId?: number;
  chartScriptId?: number;
  strategyId?: number;
  symbols: string[];
  timeframe: string;
  /** Up to three more timeframes, returned per row (multi-timeframe columns). */
  timeframes?: string[];
  lastBars: number;
  /** Run each timeframe's bar still forming as the last bar. */
  formingBar?: boolean;
  inputs?: Record<string, unknown>;
}

/** One extra timeframe's results for a row. */
export interface ScreenerTimeframeResult {
  timeframe: string;
  lastBarTimeMs: number | null;
  lastBarForming: boolean;
  values: Record<string, number | null>;
  metrics: Record<string, number | null> | null;
  alerts: ScreenerAlert[];
  error: string | null;
  notes: string[];
}

/** A §6 row with its strategy figures and extra timeframes. */
export interface ScreenerResultRow extends ScreenerRow {
  lastBarForming: boolean;
  /** A strategy() script's report figures (null for an indicator). */
  metrics: Record<string, number | null> | null;
  timeframes: ScreenerTimeframeResult[];
  notes: string[];
}

export type ScreenFilterOp =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'ne'
  | 'between'
  | 'outside'
  | 'isna'
  | 'notna';

/** A condition a symbol must meet to match (a plot title, `metric:{key}`, `alerts` or `alert:{title}`). */
export interface ScreenFilter {
  column: string;
  /** One of the screen's extra timeframes; null = its own. */
  timeframe?: string | null;
  op: ScreenFilterOp;
  value?: number | null;
  value2?: number | null;
}

export type ScreenSourceKind = 'Source' | 'Strategy' | 'ChartScript' | 'Library';

export interface ScriptScreenDto {
  id: number;
  name: string;
  sourceKind: ScreenSourceKind | string;
  sourceId: number | null;
  sourceName: string | null;
  sourceHash: string;
  /** The strategy or chart script the script was copied from changed since (null: cannot change). */
  sourceChanged: boolean | null;
  sourceMissing: boolean;
  pineSource?: string | null;
  inputs: Record<string, unknown> | null;
  symbols: string[];
  timeframe: string;
  extraTimeframes: string[];
  lastBars: number;
  formingBar: boolean;
  filters: ScreenFilter[];
  scheduleEnabled: boolean;
  alertOnEnter: boolean;
  alertOnLeave: boolean;
  channels: string[];
  severity: string;
  statusReason: string | null;
  scheduleNote: string | null;
  matched: string[];
  lastScheduledBarMs: number | null;
  lastRunAt: string | null;
  lastRunId: number | null;
  lastRunError: string | null;
  nextRunAtUtc: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST scripting/screens` and `PUT scripting/screens/{id}`. */
export interface SaveScreenRequest {
  name: string;
  source?: string;
  libraryId?: number;
  chartScriptId?: number;
  strategyId?: number;
  inputs?: Record<string, unknown>;
  symbols: string[];
  timeframe: string;
  timeframes: string[];
  lastBars: number;
  formingBar: boolean;
  filters: ScreenFilter[];
  scheduleEnabled: boolean;
  alertOnEnter: boolean;
  alertOnLeave: boolean;
  channels: string[];
  severity: string;
  /** PUT only: copy the strategy's or chart script's current script again. */
  refreshSource?: boolean;
}

export type ScreenVerdict = 'matched' | 'unmatched' | 'unknown';

/** One symbol of a screen run: the screener row and the screen's verdict on it. */
export interface ScreenRowDto {
  row: ScreenerResultRow;
  status: ScreenVerdict;
  reason: string | null;
  entered: boolean;
  left: boolean;
}

export interface ScreenRunDto {
  id: number;
  screenId: number;
  trigger: 'Scheduled' | 'Manual' | string;
  barTimeMs: number | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  symbols: number;
  matched: number;
  errors: number;
  entered: number;
  left: number;
  matchedSymbols: string[];
  enteredSymbols: string[];
  leftSymbols: string[];
  hasRows: boolean;
  notes: string[];
  error: string | null;
  alertsQueued: number;
  rows?: ScreenRowDto[] | null;
}

export interface ScreenAlertDto {
  id: number;
  screenId: number;
  runId: number;
  symbol: string;
  timeframe: string;
  kind: 'Entered' | 'Left' | string;
  barTimeMs: number;
  channel: string;
  title: string;
  message: string;
  status: 'Pending' | 'Delivered' | 'Skipped' | 'Failed' | 'Expired' | string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}
