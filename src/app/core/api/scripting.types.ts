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
  /** The imported library the position is in (`publisher/name/version`); absent: the script's own. */
  unit?: string | null;
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
  /**
   * The compiler's word on whether `strategy()` passes `initial_capital`, whatever its value — a
   * declared 1,000,000 is declared (engine D122). Null or absent: not reported (properties a host
   * built itself, or an engine from before D122). Never infer it from `initialCapital`.
   */
  initialCapitalSpecified?: boolean | null;
  currency?: string;
  slippage?: number;
  /** `Percent` | `CashPerContract` | `CashPerOrder` (or its enum ordinal). */
  commissionType?: string | number;
  commissionValue?: number;
  processOrdersOnClose?: boolean;
  closeEntriesRule?: string;
  marginLong?: number;
  marginShort?: number;
  /**
   * Whether `strategy()` passes `margin_long` or `margin_short` (set by the compiler; null or
   * absent: not reported). Pine: without one, `strategy.margin_liquidation_price` is na.
   */
  marginSpecified?: boolean | null;
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
  /**
   * The chart's forming bar (preview only): the engine runs it as the realtime bar so the last
   * value sits on the bar the chart is forming. Ignored for backtests and ranges.
   */
  liveBar?: ScriptRunBar | null;
  /**
   * The console's theme when the run is requested — the chart the outputs are drawn on. Pine's
   * `chart.bg_color` / `chart.fg_color` answer #131722 / #D1D4DC for `dark`, white / #131722
   * otherwise (the engine's default is light).
   */
  theme?: ScriptChartTheme;
  /**
   * SS-I2 (scripting API §3c): keep this run warm on the engine — new candles and quotes advance it, its changes are
   * pushed as `scriptFrame` (`/api/hubs/scripting`), and a later run can ask for a delta. Indicators on a live,
   * standard chart only (the engine says why in `session.note` otherwise).
   */
  keepWarm?: boolean;
  /** SS-I2: continue this warm session — answered with what changed since {@link sinceBar}. */
  sessionId?: string;
  /** SS-I2: the first bar_index the caller needs (with `sessionId`). */
  sinceBar?: number;
}

export type ScriptChartTheme = 'light' | 'dark';

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
  /** The imported library the error is in; absent: the script's own code. */
  unit?: string | null;
  /** The user-function calls it happened inside, innermost first (call line/column, unit). */
  callStack?: {
    function: string;
    line?: number | null;
    column?: number | null;
    unit?: string | null;
  }[];
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
 * Scripting `Broker/StrategyReport` — only the headline fields are typed here. The whole report
 * (trades, equity curve, monthly returns) is read casing-tolerantly by `app-strategy-report`
 * (`@features/scripting`, `normalizeStrategyReport`).
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

/** Scripting `Output/ScriptOutputs` — loosely typed here; the Pine chart (`@shared/pine-chart`) normalises and renders it. */
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
  /** SS-I2: the warm session of a run that asked for one (`keepWarm` / `sessionId` / `sinceBar`). */
  session?: ScriptRunSession | null;
}

// ── Chart bars on the session grid — POST scripting/chart-bars ────────────
//
// The bars a run computes on, for the chart to draw: built by the engine on the symbol's session
// layout (FX: `1700-1700:23456` in America/New_York — days roll at 17:00 New York, weeks are
// Monday–Friday sessions, DST moves the UTC open). The client never works out where one of these
// periods starts or ends: every bar carries both.

export interface ChartBarsRequest {
  symbol: string;
  /** Pine timeframe — `120`, `240`, `1D`, `1W`, `1M` (engine codes are accepted too). */
  timeframe: string;
  /** Bars whose OPEN is before this, epoch ms (paging back); null = up to now. */
  to?: number | null;
  /** The last `count` bars before `to`. Engine default 1500, max 20000. */
  count?: number | null;
  /**
   * The last bar may be the period still forming (built by the engine from closed H1 and closed
   * M1). Engine default: true when `to` is null.
   */
  includeForming?: boolean | null;
}

export interface ChartBarDto {
  /** The period's open, epoch ms. */
  t: number;
  /** The period's exclusive close, epoch ms. */
  tc: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** True only on a last bar that is the current period. */
  forming: boolean;
}

export interface ChartBarsResult {
  symbol: string;
  timeframe: string;
  /** The session the bars are laid out on, e.g. `1700-1700:23456`. */
  session: string;
  /** Its time zone, e.g. `America/New_York`. */
  timeZone: string;
  /** Ascending by `t`. */
  bars: ChartBarDto[];
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

// ── §7b Chart scripts — scripting/indicators ──────────────────────────────

/** A Pine script saved from the chart-analysis editor ("My scripts"); private to its owner. */
export interface ChartIndicatorScriptDto {
  id: number;
  name: string;
  kind: 'indicator' | 'strategy';
  pineSource: string;
  inputs?: ScriptInputValues | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST scripting/indicators` and `PUT scripting/indicators/{id}`. */
export interface SaveChartIndicatorScriptRequest {
  name: string;
  pineSource: string;
  inputs?: ScriptInputValues | null;
}

// ── §8 Script strategies — strategy endpoints ─────────────────────────────

export type ScriptExecutionPolicy = 'Standard' | 'Direct';

/** `Dsl` marks a legacy row on the retired JSON rules DSL — it never runs. */
export type StrategyAuthoringMode = 'Dsl' | 'Script';

/** Body for `PUT strategy/{id}/script`. */
export interface UpdateStrategyScriptRequest {
  source: string;
  inputs: ScriptInputValues;
  /** Recorded on the pre-edit version snapshot. */
  changeReason?: string | null;
}

/** `GET strategy/{id}/export` — a `.pine` file for scripts, a JSON bundle for legacy DSL rows. */
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

// ── Editor vertical (2026-10-09): revisions, versions, sharing, import, library usage ──────────
// Appended (not edited above) so other verticals' additions merge cleanly. Wire contract: the
// engine's docs/api/scripting-api.md §7, §7b (contract C4) and §8.

/** C4 fields of a chart script (`scripting/indicators`); an older engine omits them. */
export interface ChartIndicatorScriptLifecycleFields {
  /** Digest of name + source + inputs: send it back as `expectedRevision` (stale → `-409`). */
  revision?: string | null;
  /** `Private` (its owner only) or `Shared` (listed and readable for every operator). */
  visibility?: ScriptLibraryVisibility | string | null;
  /** The caller owns it: only the owner saves, restores, shares or deletes it. */
  ownedByMe?: boolean | null;
  /** Newest version number; 0 = saved before version history existed and unchanged since. */
  latestVersion?: number | null;
  /** The TradingView script an imported script came from. */
  sourceUrl?: string | null;
  licence?: string | null;
  author?: string | null;
}

/** A chart script with its C4 fields. */
export type ChartIndicatorScriptDetailDto = ChartIndicatorScriptDto &
  ChartIndicatorScriptLifecycleFields;

/** Body of `POST scripting/indicators` (C4 additions optional). */
export interface CreateChartScriptRequest extends SaveChartIndicatorScriptRequest {
  visibility?: ScriptLibraryVisibility | null;
  /** Recorded on version 1. */
  note?: string | null;
  /** An import from TradingView: the script page it came from (and what the import reported). */
  sourceUrl?: string | null;
  licence?: string | null;
  author?: string | null;
}

/** Body of `PUT scripting/indicators/{id}` (C4 additions optional). */
export interface UpdateChartScriptRequest extends SaveChartIndicatorScriptRequest {
  /** The `revision` the edit started from; a newer saved state answers `-409`. */
  expectedRevision?: string | null;
  /** Omitted keeps the current visibility. */
  visibility?: ScriptLibraryVisibility | null;
  /** Recorded on the version this save writes. */
  note?: string | null;
}

export type ChartScriptVersionAction = 'Created' | 'Saved' | 'Restored' | 'Imported' | 'Baseline';

/** `GET scripting/indicators/{id}/versions` rows (newest first, no source). */
export interface ChartScriptVersionDto {
  id: number;
  scriptId: number;
  versionNumber: number;
  name: string;
  kind: 'indicator' | 'strategy' | string;
  inputs?: ScriptInputValues | null;
  revision: string;
  action: ChartScriptVersionAction | string;
  note?: string | null;
  createdBy?: string | null;
  createdAt: string;
  /** The script's current state (same revision). */
  isCurrent: boolean;
}

/** `GET scripting/indicators/{id}/versions/{versionId}`. */
export interface ChartScriptVersionDetailDto extends ChartScriptVersionDto {
  pineSource: string;
}

/** A script licence as read from its header comments. */
export interface PineLicenceDto {
  name: string;
  spdx?: string | null;
  /** False when it forbids this engine's (commercial) use — such an import is refused. */
  allowsReuse: boolean;
  notice?: string | null;
}

/** `POST scripting/indicators/import/tradingview` — a fetched script, NOT saved. */
export interface TradingViewScriptImportDto {
  name: string;
  pineSource: string;
  kind: 'indicator' | 'strategy' | 'library' | string;
  sourceUrl: string;
  publicationId: string;
  version?: string | null;
  author?: string | null;
  licence: PineLicenceDto;
  updatedAt?: string | null;
}

/** `PUT strategy/{id}/script` with the revision check (§8). */
export interface UpdateStrategyScriptRequestV2 extends UpdateStrategyScriptRequest {
  /** The strategy's `scriptRevision` the edit started from; a newer saved script answers `-409`. */
  expectedScriptRevision?: string | null;
}

/** What a script save returns. */
export interface StrategyScriptSaveResult {
  /** The saved script's revision — the next save's `expectedScriptRevision`. */
  scriptRevision: string | null;
  /** The engine's message ("Saved — …", "Unchanged"). */
  message: string;
  /** Nothing changed: no version written, the session not restarted. */
  unchanged: boolean;
}

/** `GET strategy/{id}` script fields this editor reads beyond {@link StrategyScriptFields}. */
export interface StrategyScriptRevisionField {
  /** Digest of the saved script + inputs (not the row's RowVersion). */
  scriptRevision?: string | null;
}

/** `GET strategy/{id}/versions` script fields (PE-02; the engine has sent them since ADR-0027). */
export interface StrategyVersionScriptFields {
  scriptSource?: string | null;
  /** The input overrides as stored (JSON object text). */
  scriptInputsJson?: string | null;
}

/** `POST scripting/libraries` with the stale-version guard (PE-I12). */
export interface CreateScriptLibraryRequestV2 extends CreateScriptLibraryRequest {
  /** The newest version the editor knew about (0 for a new library); a newer one answers `-409`. */
  basedOnVersion?: number | null;
}

/** `GET scripting/libraries/{id}/usage` (PE-I12). */
export interface ScriptLibraryUsageDto {
  libraryId: number;
  importPath: string;
  strategies: {
    id: number;
    name: string;
    symbol: string;
    timeframe: string;
    status: string;
    lifecycleStage: string;
    /** Imports the version itself (false: through another library). */
    direct: boolean;
    /** Live, approved, shadow-live or paper trading: a delete needs force. */
    blocksDelete: boolean;
  }[];
  chartScripts: {
    id: number;
    name: string;
    ownedByMe: boolean;
    createdBy?: string | null;
    direct: boolean;
  }[];
  libraries: { id: number; publisher: string; name: string; version: number; direct: boolean }[];
}

/**
 * `GET strategy-feedback/{strategyId}/trials` — the strategy lineage's multiple-testing ledger
 * (engine BT-I4). `effectiveTrials` is the count the promotion gates deflate the Sharpe by.
 */
export interface StrategyTrialLedgerDto {
  strategyId: number;
  lineageRootStrategyId: number;
  rowsByKind: Record<string, number>;
  distinctConfigurations: number;
  foldSearchCandidates: number;
  ledgerTrials: number;
  peerStrategies: number;
  effectiveTrials: number;
  optimizationRuns: {
    optimizationRunId: number;
    status: string;
    completedAt?: string | null;
    candidates: number;
    candidatesWithFolds: number;
    pbo?: number | null;
    whyNot?: string | null;
  }[];
}

/**
 * Fields of the engine's `BacktestRunDto` the shared UI type does not carry yet (PE-I7): the
 * override a run was made with, and the equity curve `GET backtest/{id}` fills (≤ 2,000 points).
 */
export interface BacktestRunCompareFields {
  /** Set when the run tested the strategy on another symbol (`symbol` then holds it). */
  symbolOverride?: string | null;
  timeframeOverride?: string | null;
  equityCurve?: { time: string; equity: number; drawdownPct: number }[] | null;
}

// ── Warm chart sessions — scripting API §3c (SS-I2, SS-I3) ──────────────────

/** A run's warm session (`session` on the run response). */
export interface ScriptRunSession {
  /** Subscribe to `script:{id}` frames on `/api/hubs/scripting`; null when no session is kept. */
  id: string | null;
  /** The run is kept warm. */
  warm: boolean;
  /** This response is a delta (bars and per-bar outputs from `fromBar`). */
  delta: boolean;
  fromBar: number;
  /** bar_index of the last bar (the forming one when `lastBarForming`). */
  barIndex: number;
  lastBarForming: boolean;
  /** The session's last pushed frame number. */
  seq: number;
  /** Why no session is kept, or why the run was full, in plain words. */
  note?: string | null;
}

/**
 * SignalR `scriptFrame` (room `script:{sessionId}`) and `GET scripting/sessions/{id}/frame?sinceSeq=`: what changed in a
 * warm session, in the replay frame format — keep the bars and per-bar values before `fromBar`, replace everything
 * from it (drawings, tables, alerts and logs come whole).
 */
export interface ScriptSessionFrame {
  sessionId: string;
  /** Consecutive per session: a gap means frames were missed (resync with `sinceSeq`). */
  seq: number;
  fromBar: number;
  barIndex: number;
  lastBarForming: boolean;
  bars: ScriptRunBar[];
  outputsDelta?: ScriptOutputs | null;
  report?: ScriptStrategyReport | null;
  runtimeError?: ScriptRuntimeError | null;
  /** The session ended (idle, retired, a runtime error, or the engine reset it): run the script again. */
  reset: boolean;
  note?: string | null;
}

/** `SubscribeScriptSession` on `/api/hubs/scripting`: where the session stands (null for an unknown one). */
export interface ScriptSessionSubscription {
  sessionId: string;
  seq: number;
  barIndex: number;
}

// ── runtime2: diagnostic hints and quick fixes (engine PR-I4, `ScriptDiagnosticDto.hint/fixes`) ──

/** A quick fix: replace the located text (1-based, end column exclusive) with `replacement`. */
export interface ScriptDiagnosticFix {
  /** What the fix does, as the editor offers it ("Change to 'ta.sma'"). */
  title: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  replacement: string;
}

/** The engine's suggestion and quick fixes on a diagnostic (merged into `ScriptDiagnostic`). */
export interface ScriptDiagnostic {
  /** A short suggestion shown with the message ("Did you mean 'ta.sma'?"); absent when there is none. */
  hint?: string | null;
  /** Text edits that apply the hint; absent when there are none. */
  fixes?: readonly ScriptDiagnosticFix[] | null;
}

// ── runtime2: strategy() property overrides (PC-I5, scripting API §3d) ──

/**
 * The Strategy Tester's Properties for one run, over the script's `strategy()`: every field optional
 * (absent = the script's own). The engine refuses a bad value or an unknown field (`-11`, naming it).
 */
export interface ScriptStrategyPropertyOverrides {
  initialCapital?: number;
  /** ISO code or `NONE` (the symbol's currency). */
  currency?: string;
  defaultQtyType?: 'fixed' | 'cash' | 'percent_of_equity';
  defaultQtyValue?: number;
  pyramiding?: number;
  commissionType?: 'percent' | 'cash_per_contract' | 'cash_per_order';
  commissionValue?: number;
  /** "Verify price for limit orders", ticks. */
  backtestFillLimitsAssumption?: number;
  /** Ticks. */
  slippage?: number;
  marginLong?: number;
  marginShort?: number;
  processOrdersOnClose?: boolean;
  calcOnOrderFills?: boolean;
  calcOnEveryTick?: boolean;
  useBarMagnifier?: boolean;
  fillOrdersOnStandardOhlc?: boolean;
  closeEntriesRule?: 'FIFO' | 'ANY';
  riskFreeRate?: number;
}

/** `scripting/run` / `scripting/replay` accept the overrides (merged into `ScriptRunRequest`). */
export interface ScriptRunRequest {
  strategyProperties?: ScriptStrategyPropertyOverrides;
}
