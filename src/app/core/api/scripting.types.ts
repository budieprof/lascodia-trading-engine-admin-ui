// ============================================================
// Pine v6 scripting — wire types (ADR-0027)
// ============================================================
//
// The shapes of the engine's scripting endpoints, exactly as the contract
// (`docs/api/scripting-api.md` in the engine repo) defines them. JSON is
// camelCase; lines and columns are 1-based; `…Ms` fields are Unix
// milliseconds. Kept out of api.types.ts so the scripting stream can evolve
// them without touching that shared file.

// ── §1 Language catalog — GET scripting/catalog ───────────────────────────

export interface PineCatalogParam {
  name: string;
  /** Qualified type as the reference prints it, e.g. `series int/float`. */
  type: string;
  qualifier?: 'const' | 'input' | 'simple' | 'series' | string | null;
  optional: boolean;
  /** How the default reads in docs, e.g. `close` or `barmerge.lookahead_off`. */
  defaultText?: string | null;
  doc?: string | null;
}

export interface PineCatalogOverload {
  /** Display signature, e.g. `ta.ema(source, length) → series float`. */
  signature: string;
  params: PineCatalogParam[];
  returns: string;
  /** `T` for generic functions such as `array.new<T>()`. */
  templateParam?: string | null;
  /** Callable as `receiver.method()` on its first parameter. */
  method?: boolean;
  variadic?: boolean;
  flags?: string[];
}

export interface PineCatalogFunction {
  name: string;
  doc?: string | null;
  deprecated?: boolean;
  overloads: PineCatalogOverload[];
}

export interface PineCatalogVariable {
  name: string;
  type: string;
  doc?: string | null;
}

export interface PineCatalogConstant {
  name: string;
  type: string;
  /** Literal value when it has one, e.g. `#089981` for `color.teal`. */
  valueText?: string | null;
  doc?: string | null;
}

export interface PineCatalogNamedDoc {
  name: string;
  doc?: string | null;
  generic?: boolean;
}

export interface PineCatalog {
  /** Hash of the engine's built-in registry; changes whenever the registry does. */
  version: string;
  languageVersion: number;
  keywords: string[];
  types: PineCatalogNamedDoc[];
  annotations: PineCatalogNamedDoc[];
  namespaces: string[];
  functions: PineCatalogFunction[];
  variables: PineCatalogVariable[];
  constants: PineCatalogConstant[];
}

// ── §2 Compile — POST scripting/compile ───────────────────────────────────

export type ScriptDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ScriptDiagnostic {
  /** Stable code: PS1xxx syntax … PS9xxx engine-specific. */
  code: string;
  severity: ScriptDiagnosticSeverity;
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  endLine: number;
  endColumn: number;
}

export type ScriptKind = 'indicator' | 'strategy' | 'library';

/** `strategy()` declaration parameters (Scripting `Hosting/Declarations.cs` StrategyProperties). */
export interface ScriptStrategyProperties {
  pyramiding?: number;
  calcOnOrderFills?: boolean;
  calcOnEveryTick?: boolean;
  calcOnEveryHistoryTick?: boolean;
  maxBarsBack?: number;
  backtestFillLimitsAssumption?: number;
  /** `Fixed` | `Cash` | `PercentOfEquity` (or its enum ordinal). */
  defaultQtyType?: string | number;
  defaultQtyValue?: number;
  initialCapital?: number;
  currency?: string;
  slippage?: number;
  /** `Percent` | `CashPerContract` | `CashPerOrder` (or its enum ordinal). */
  commissionType?: string | number;
  commissionValue?: number;
  processOrdersOnClose?: boolean;
  closeEntriesRule?: string;
  marginLong?: number;
  marginShort?: number;
  riskFreeRate?: number;
  useBarMagnifier?: boolean;
  fillOrdersOnStandardOhlc?: boolean;
}

export interface ScriptDeclaration {
  kind: ScriptKind;
  title: string;
  shortTitle?: string | null;
  overlay?: boolean;
  format?: string | null;
  precision?: number | null;
  scale?: string | null;
  maxBarsBack?: number;
  timeframe?: string | null;
  timeframeGaps?: boolean;
  maxLinesCount?: number;
  maxLabelsCount?: number;
  maxBoxesCount?: number;
  maxPolylinesCount?: number;
  calcBarsCount?: number;
  dynamicRequests?: boolean;
  languageVersion?: number;
  strategyAlertMessage?: string | null;
  strategy?: ScriptStrategyProperties | null;
}

export type ScriptInputKind =
  | 'int'
  | 'float'
  | 'bool'
  | 'string'
  | 'textArea'
  | 'symbol'
  | 'timeframe'
  | 'session'
  | 'source'
  | 'color'
  | 'time'
  | 'price'
  | 'enum';

/** An input value on the wire: numbers, booleans, strings; colors `#RRGGBBAA`; time in ms. */
export type ScriptInputValue = number | boolean | string;

/** `{ inputId: value }` — how a strategy's input overrides travel (§8, §9). */
export type ScriptInputValues = Record<string, ScriptInputValue>;

/** §9 InputDto — one `input.*()` call, extracted at compile time. */
export interface ScriptInputDto {
  /** Stable across edits that keep the title; overrides are keyed by it. */
  id: string;
  kind: ScriptInputKind;
  title: string;
  defaultValue: ScriptInputValue | null;
  defaultText?: string | null;
  options?: ScriptInputValue[] | null;
  optionTexts?: string[] | null;
  minValue?: number | null;
  maxValue?: number | null;
  step?: number | null;
  tooltip?: string | null;
  inline?: string | null;
  group?: string | null;
  confirm?: boolean;
  display?: string | null;
  /** Id of the bool input that enables this one (`active = someBoolInput`). */
  activeWhenInputId?: string | null;
  enumName?: string | null;
  line?: number;
  column?: number;
}

export interface ScriptExportDto {
  kind: 'function' | 'method' | 'type' | 'enum' | 'const' | string;
  name: string;
  signature?: string | null;
  doc?: string | null;
}

export interface ScriptCompileRequest {
  source: string;
  /** Refines warnings only (e.g. a higher-timeframe request that is not higher). */
  symbol?: string | null;
  /** Engine `M1`…`D1` or a Pine timeframe string. */
  timeframe?: string | null;
}

export interface ScriptCompileResult {
  /** No error-severity diagnostics. */
  success: boolean;
  /** Every error and warning of the compile, sorted by position. */
  diagnostics: ScriptDiagnostic[];
  declaration: ScriptDeclaration | null;
  inputs: ScriptInputDto[];
  /** Plot slots used, of 64. */
  plotSlots?: number;
  /** `request.*` calls, of 40. */
  requestCount?: number;
  /** Libraries only. */
  exports?: ScriptExportDto[];
}

// ── §3 Run / preview — POST scripting/run ─────────────────────────────────

export type ScriptChartType =
  | 'standard'
  | 'heikinashi'
  | 'renko'
  | 'linebreak'
  | 'kagi'
  | 'pointfigure';

export interface ScriptRunRequest {
  source?: string;
  strategyId?: number;
  symbol: string;
  timeframe: string;
  fromUtc?: string;
  toUtc?: string;
  /** Default 2000, max 20000 for a preview. */
  lastBars?: number;
  inputs?: ScriptInputValues;
  mode?: 'preview' | 'backtest';
  trace?: { fromBar: number; toBar: number };
  profile?: boolean;
  chartType?: ScriptChartType;
}

export interface ScriptRunBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface ScriptRuntimeError {
  code: string;
  message: string;
  line?: number | null;
  column?: number | null;
  barIndex?: number | null;
}

/** One side (all / long / short) of the Strategy Tester's performance summary. */
export interface ScriptReportSplit {
  netProfit?: number;
  netProfitPercent?: number | null;
  grossProfit?: number;
  grossLoss?: number;
  profitFactor?: number | null;
  totalClosedTrades?: number;
  totalOpenTrades?: number;
  winningTrades?: number;
  losingTrades?: number;
  percentProfitable?: number | null;
  avgTrade?: number | null;
  maxContractsHeld?: number;
}

/**
 * Scripting `Broker/StrategyReport` — only the headline fields the console reads today are typed;
 * the full report (trades, equity curve, monthly returns) belongs to the report stream.
 */
export interface ScriptStrategyReport {
  meta?: {
    symbol?: string;
    timeframe?: string;
    accountCurrency?: string;
    initialCapital?: number;
    bars?: number;
    riskHalted?: boolean;
    riskHaltReason?: string;
  };
  performance?: { all?: ScriptReportSplit; long?: ScriptReportSplit; short?: ScriptReportSplit };
  equity?: {
    finalEquity?: number;
    maxDrawdown?: number;
    maxDrawdownPercent?: number;
    maxRunup?: number;
    maxRunupPercent?: number;
  };
  returns?: { sharpeRatio?: number | null; sortinoRatio?: number | null; cagr?: number | null };
  capital?: { marginCalls?: number };
  trades?: unknown[];
  warnings?: string[];
}

/** Scripting `Output/ScriptOutputs` — rendered by the chart-overlay stream; counted here. */
export interface ScriptOutputs {
  plots?: unknown[];
  shapes?: unknown[];
  drawings?: unknown;
  tables?: unknown[];
  alerts?: unknown[];
  logs?: unknown[];
  [key: string]: unknown;
}

export interface ScriptTraceItem {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
  value: string;
}

export interface ScriptRunResult {
  compile: ScriptCompileResult;
  bars?: ScriptRunBar[];
  outputs?: ScriptOutputs | null;
  report?: ScriptStrategyReport | null;
  trace?: { bar: number; timeMs: number; items: ScriptTraceItem[] }[] | null;
  profile?: { line: number; executions: number; totalMicros: number }[] | null;
  runtimeError?: ScriptRuntimeError | null;
  elapsedMs?: number;
}

// ── §7 Libraries — scripting/libraries ────────────────────────────────────

export type ScriptLibraryVisibility = 'Private' | 'Shared';

export interface ScriptLibraryDto {
  id: number;
  publisher: string;
  name: string;
  version: number;
  visibility: ScriptLibraryVisibility | string;
  description?: string | null;
  updatedAt?: string | null;
  exports?: ScriptExportDto[];
}

export interface ScriptLibraryDetailDto extends ScriptLibraryDto {
  source: string;
}

export interface CreateScriptLibraryRequest {
  name: string;
  description?: string | null;
  visibility: ScriptLibraryVisibility;
  source: string;
}

export interface ScriptLibraryFilter {
  publisher?: string | null;
  name?: string | null;
}

export interface ScriptPublisherDto {
  publisher: string;
}

// ── §8 Script strategies — strategy endpoints ─────────────────────────────

export type ScriptExecutionPolicy = 'Standard' | 'Direct';

export type StrategyAuthoringMode = 'Dsl' | 'Script';

/** Body for `PUT strategy/{id}/script`. */
export interface UpdateStrategyScriptRequest {
  source: string;
  inputs: ScriptInputValues;
}

/** `GET strategy/{id}/export` — a `.pine` file for scripts, a JSON bundle for DSL strategies. */
export interface StrategyExportDto {
  fileName: string;
  content: string;
}

/** Body for `POST strategy/import`. */
export interface ImportStrategyRequest {
  content: string;
  symbol: string;
  timeframe: string;
  name?: string | null;
}

/** The script fields `GET strategy/{id}` adds for RuleBased strategies. */
export interface StrategyScriptFields {
  authoringMode?: StrategyAuthoringMode | null;
  scriptSource?: string | null;
  scriptInputs?: ScriptInputValues | string | null;
  scriptLanguageVersion?: number | null;
  executionPolicy?: ScriptExecutionPolicy | null;
  accountBindingCount?: number | null;
}
