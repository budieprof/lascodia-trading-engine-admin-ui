import type { AlertChannel, StrategyDto } from '@core/api/api.types';
import type { ScriptStrategyProperties } from '@core/api/scripting.types';

/**
 * Wire types for the ADR-0027 scripting endpoints the report / screener / alerts / live /
 * execution pages use. Source of truth: `docs/api/scripting-api.md` in the engine repo (§ numbers
 * below refer to it) and the engine's account-binding / execution-policy endpoints.
 *
 * The §2 compile types are the pages' read of `ScriptingService.compile()`'s result
 * (`@core/api/scripting.types`): structurally compatible with it, with the optional fields a newer
 * engine build may add.
 */

// ── §2 Compile ────────────────────────────────────────────────────────────────

export type ScriptDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ScriptDiagnostic {
  code: string;
  severity: ScriptDiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export type ScriptKind = 'indicator' | 'strategy' | 'library';

export interface ScriptDeclaration {
  kind: ScriptKind | string;
  title: string;
  shortTitle?: string | null;
  overlay?: boolean;
  /** `strategy()` properties, camelCase — present for strategies only. */
  strategy?: ScriptStrategyProperties | null;
}

/** §9 InputDto. `kind` is camelCase on the wire; older builds may send PascalCase. */
export interface ScriptInputDef {
  id: string;
  kind: string;
  title: string;
  defaultValue: unknown;
  defaultText?: string | null;
  options?: unknown[] | null;
  optionTexts?: string[] | null;
  minValue?: number | null;
  maxValue?: number | null;
  step?: number | null;
  tooltip?: string | null;
  inline?: string | null;
  group?: string | null;
  confirm?: boolean;
  display?: string | null;
  activeWhenInputId?: string | null;
  enumName?: string | null;
  line?: number;
  column?: number;
}

export interface ScriptCompileResult {
  success: boolean;
  diagnostics: ScriptDiagnostic[];
  declaration: ScriptDeclaration | null;
  inputs: ScriptInputDef[];
  plotSlots?: number;
  requestCount?: number;
  /**
   * Not in the §2 contract yet: read when an engine build sends them, otherwise the alerts tab
   * falls back to reading `alertcondition(...)` / `plot(...)` titles out of the source.
   */
  alertConditions?: { title: string; message?: string | null }[] | null;
  plots?: { title: string }[] | null;
}

// ── §6 Screener ───────────────────────────────────────────────────────────────

export interface ScreenerRequest {
  source?: string;
  libraryId?: number;
  symbols: string[];
  timeframe: string;
  lastBars: number;
  inputs?: Record<string, unknown>;
}

export interface ScreenerAlert {
  title: string;
  message: string;
  barIndex: number;
}

export interface ScreenerRow {
  symbol: string;
  lastBarTimeMs: number | null;
  values: Record<string, number | null>;
  alerts: ScreenerAlert[];
  error?: string | null;
}

// ── §7 Libraries ──────────────────────────────────────────────────────────────

export interface ScriptLibrarySummary {
  id: number;
  publisher: string;
  name: string;
  version: number;
  visibility: 'Private' | 'Shared' | string;
  description?: string | null;
  updatedAt?: string | null;
}

// ── §8 Script strategies ──────────────────────────────────────────────────────

export type AuthoringMode = 'Dsl' | 'Script';

export type ExecutionPolicy = 'Standard' | 'Direct';

/** Fields `GET strategy/{id}` adds for ADR-0027 (all optional: older engines omit them). */
export interface ScriptStrategyFields {
  authoringMode?: AuthoringMode | string | null;
  scriptSource?: string | null;
  /** `{ inputId: value }` — some builds send the stored JSON text instead. */
  scriptInputs?: Record<string, unknown> | string | null;
  scriptLanguageVersion?: number | null;
  /** String on the wire; tolerate the enum's number (0 = Standard, 1 = Direct). */
  executionPolicy?: ExecutionPolicy | number | string | null;
  accountBindingCount?: number | null;
  accountBindings?: StrategyAccountBinding[] | null;
}

export type ScriptStrategyDto = StrategyDto & ScriptStrategyFields;

/** `GET strategy/{id}/script/live`. Sub-objects are emulator state and loosely typed on purpose. */
export interface ScriptLiveStatus {
  status: string;
  lastBarTimeMs: number | null;
  position: Record<string, unknown> | null;
  openTrades: Record<string, unknown>[];
  pendingOrders: Record<string, unknown>[];
  equity: number | Record<string, unknown> | null;
  /** The live emulator's StrategyReport. */
  report: unknown;
  divergences: ScriptDivergence[];
}

export interface ScriptDivergence {
  timeUtc: string;
  accountId: number | string | null;
  kind: string;
  detail: string;
}

/**
 * §4 — `POST backtest` for a script strategy. No `initialBalance`: every run of a script opens
 * with the script's `strategy(initial_capital=…)`, else the engine default
 * `ScriptBacktest:InitialCapital` — the engine ignores a run's own balance for scripts (D122).
 */
export interface ScriptBacktestRequest {
  strategyId: number;
  /** The strategy's own symbol / timeframe (the engine refuses a mismatch without an override). */
  symbol: string;
  timeframe: string;
  fromDate: string;
  toDate: string;
  symbolOverride?: string;
  timeframeOverride?: string;
  inputs?: Record<string, unknown>;
  /** Streaming mode, up to 2M bars. */
  deep?: boolean;
  /** Overrides the script's `use_bar_magnifier`; omitted = the script's own setting. */
  barMagnifier?: boolean;
}

// ── §10 Alerts ────────────────────────────────────────────────────────────────

/** `order-fills`, `alert()` or an alertcondition title. */
export type ScriptAlertKey = string;

export const ALERT_KEY_ALERT_CALLS = 'alert()';
export const ALERT_KEY_ORDER_FILLS = 'order-fills';

export interface ScriptAlertBinding {
  alertKey: ScriptAlertKey;
  enabled: boolean;
  channels: AlertChannel[];
  messageTemplate?: string | null;
  webhookUrl?: string | null;
}

// ── Account bindings / execution policy (A-EXEC) ──────────────────────────────

export interface StrategyAccountBinding {
  tradingAccountId: number;
  /** Display name of the bound account (empty when the account row is gone). */
  accountName: string;
  /** (0, 10] — applied to the lot resolved for this account before the Tier-2 clamps. */
  lotMultiplier: number;
  /** False pauses delivery while the strategy stays restricted to its bound set. */
  isEnabled: boolean;
}

export interface StrategyAccountBindingInput {
  tradingAccountId: number;
  lotMultiplier: number;
  isEnabled: boolean;
}

/** Upper bound the engine validates (`StrategyAccountRouting.MaxLotMultiplier`). */
export const MAX_LOT_MULTIPLIER = 10;
