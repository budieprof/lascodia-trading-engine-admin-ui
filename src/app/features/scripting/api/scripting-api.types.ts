import type { AlertChannel, StrategyDto } from '@core/api/api.types';
import type { ScriptStrategyProperties } from '@core/api/scripting.types';

import type { TradeOrigin } from '../report/trade-origin';

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

/** `Dsl` marks a legacy row on the retired JSON rules DSL — it never runs. */
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

/**
 * `GET strategy/{id}/script/live`. Sub-objects are emulator state and loosely typed on purpose.
 * The emulator's quantities (`position.size`, `openTrades[].qty`, `pendingOrders[].qty`) are Pine
 * units of the underlying; `position.lots` and `openTrades[].lots` are the broker lots they come
 * to (engine DEC-18); `orphanedPositions` are broker positions, in lots.
 *
 * Each open and closed trade carries its `origin` (`warmup` | `paper` | `live`): the session's
 * warm-up replays history before it goes live, and those trades sit in the same lists — and the
 * same report — as the real ones. An engine build that predates the tag sends no `origin` and no
 * `closedTrades`; the console then shows the origin as unknown.
 */
export interface ScriptLiveStatus {
  status: string;
  /** Why the session is in its status (bound accounts, not bound, errors…); '' when not said. */
  reason: string;
  /** `live` | `paper` | `exitsOnly` | `alertsOnly` | `none` — what the session does (PE-08). */
  mode: ScriptLiveMode;
  lastBarTimeMs: number | null;
  /** Unix ms the live worker last advanced the session; null before the first. */
  lastHeartbeatMs: number | null;
  startedAtMs: number | null;
  /** Unix ms the emulator state shown was captured. */
  stateAtMs: number | null;
  /**
   * What the running session was compiled with that deserves a look: compiler warnings for the
   * strategy's chart and saved inputs that were NOT applied (PS9301 — the default runs — and PS9302
   * unknown ids). Empty on an older engine.
   */
  warnings: ScriptLiveWarning[];
  position: Record<string, unknown> | null;
  openTrades: Record<string, unknown>[];
  /** The emulator's closed trades, oldest first (the newest 500); empty on an older engine. */
  closedTrades: ScriptLiveClosedTrade[];
  pendingOrders: Record<string, unknown>[];
  equity: number | Record<string, unknown> | null;
  /** The live emulator's StrategyReport. */
  report: unknown;
  divergences: ScriptDivergence[];
  /** Account positions a previous script version opened, left to the operator (engine D90). */
  orphanedPositions: ScriptOrphanedPosition[];
}

/** What a live session does (`GET strategy/{id}/script/live` → `mode`). */
export type ScriptLiveMode = 'live' | 'paper' | 'exitsOnly' | 'alertsOnly' | 'none' | string;

/** One compile finding of the running session (`warnings[]`). */
export interface ScriptLiveWarning {
  code: string;
  /** `warning` | `info`. */
  severity: string;
  message: string;
  /** 1-based; 0 when not about a source position. */
  line: number;
  column: number;
}

/**
 * One of the live emulator's closed trades (`closedTrades[]`). `qty` is Pine units, `lots` the
 * broker lots it comes to; SL/TP are the protective levels the trade carried; times are unix ms.
 */
export interface ScriptLiveClosedTrade {
  tradeKey: number | null;
  entryId: string;
  /** `long` | `short`. */
  direction: string;
  qty: number | null;
  lots: number | null;
  entryPrice: number | null;
  entryTimeMs: number | null;
  exitPrice: number | null;
  exitTimeMs: number | null;
  /** `TakeProfit` | `StopLoss` | `Trailing` | '' — the strategy.exit leg that filled. */
  exitLeg: string;
  exitComment: string;
  profit: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Null when the engine did not say. */
  origin: TradeOrigin | null;
}

/**
 * A broker position opened under a previous version of the script: the running script never
 * closes or manages it — the operator decides (engine D90).
 */
export interface ScriptOrphanedPosition {
  positionId: number | null;
  accountId: number | string | null;
  symbol: string;
  /** `long` | `short`. */
  direction: string;
  /** Open size in broker lots. */
  lots: number | null;
  entryId: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** `Open` | `Closing`. */
  status: string;
  orphanedAtUtc: string;
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
