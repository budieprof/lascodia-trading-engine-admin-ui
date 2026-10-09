import { normalizeRunResult } from '@shared/pine-chart/model/normalize';
import type { PineCallFrame, PineRunResult } from '@shared/pine-chart/model/pine-outputs.types';
import {
  normalizeStrategyReport,
  type StrategyReport,
} from '@features/scripting/report/strategy-report.model';
import type {
  ScriptCompileResult,
  ScriptDiagnostic,
  ScriptInputDto,
  ScriptRunSession,
} from '@core/api/scripting.types';
import { resolutionSource, type TvResolution } from '../datafeed/resolution';

/**
 * A Pine run as the chart-analysis page holds it: the run itself in the shared renderer's shape
 * (`run` — what `script-renderer.ts` paints, through `script-model-cache.ts`), plus what the page,
 * the chips and the Strategy Tester read without building a render model: the declaration, the
 * inputs, the failure, and the strategy report.
 *
 * <p>Every `time` here is a **UTC Unix timestamp in seconds** — lightweight-charts' `UTCTimestamp`,
 * the unit `chart-host.component.ts` (`asTime`) feeds its series. The engine sends milliseconds;
 * {@link toChartSeconds} is the one conversion. The chart's display-timezone shift is applied by
 * the renderer (`script-renderer.ts`, `shiftMs`), never here, so a result can be re-rendered when
 * the operator changes zone.</p>
 */

/** A point of a strategy's equity curve (chart seconds). */
export interface ScriptPoint {
  time: number;
  value: number;
}

export interface ChartTrade {
  number: number;
  side: 'long' | 'short';
  isOpen: boolean;
  entryTime: number;
  entryPrice: number;
  entrySignal: string;
  exitTime: number | null;
  exitPrice: number | null;
  exitSignal: string | null;
  qty: number;
  profit: number;
  profitPercent: number | null;
  cumulativeProfit: number | null;
}

/**
 * Headline Strategy Tester figures, straight from the engine report — NO rescaling.
 * Units (verified against a live `scripting/run` 2026-10-01): every `…Percent` field is already a
 * percentage (41.67 means 41.67 %), including `winRatePercent` (`percentProfitable`), which is
 * NOT a fraction. Money is in `currency`.
 */
export interface ChartStrategyMetrics {
  currency: string;
  initialCapital: number | null;
  netProfit: number | null;
  netProfitPercent: number | null;
  grossProfit: number | null;
  grossLoss: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  maxDrawdownPercent: number | null;
  winRatePercent: number | null;
  totalClosedTrades: number | null;
  winningTrades: number | null;
  losingTrades: number | null;
  avgTrade: number | null;
  finalEquity: number | null;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
}

export interface ChartStrategyResult {
  trades: ChartTrade[];
  metrics: ChartStrategyMetrics;
  equity: ScriptPoint[];
  /** The full normalised report (performance splits etc.) for the summary tab. */
  report: StrategyReport;
  warnings: string[];
}

export interface ChartScriptResult {
  title: string;
  kind: 'indicator' | 'strategy' | 'library';
  /** Declaration `overlay` — where plots without `force_overlay` go. */
  overlay: boolean;
  compile: ScriptCompileResult | null;
  inputs: ScriptInputDto[];
  diagnostics: ScriptDiagnostic[];
  /** A compile or runtime failure, one line; null on success. */
  error: string | null;
  /**
   * Where in the source the failure is (1-based): the first error diagnostic, else the runtime
   * error's line. Null when the failure has no position (or there is none) — the chip's "Line N"
   * opens the editor there.
   */
  errorAt: { line: number; column: number } | null;
  /**
   * The imported library `errorAt` is in (`publisher/name/version`) — not this script's source, so
   * the editor cannot open it there; null in the script's own code.
   */
  errorUnit: string | null;
  /** A runtime error's user-function calls, innermost first; empty otherwise. */
  errorStack: readonly PineCallFrame[];
  strategy: ChartStrategyResult | null;
  /**
   * The run as the shared Pine renderer reads it (`@shared/pine-chart` normaliser): what
   * `script-renderer.ts` paints, and what the status line, the data window and the trade detail
   * read — through the render model (`script-model-cache.ts`), never a second copy of the outputs.
   */
  run: PineRunResult | null;
  /**
   * PC-I1: the run's warm session on the engine (a run that asked `keepWarm`): its frames keep `run` current. Absent
   * or null when none is kept (`note` says why).
   */
  session?: ScriptRunSession | null;
}

// ── Time & timeframe ─────────────────────────────────────────────────────────

/** Engine Unix ms → lightweight-charts UTC seconds (same floor as chart-host `asTime`). */
export function toChartSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * The `timeframe` to send `scripting/run` for a chart resolution. The engine's run endpoint takes
 * Pine timeframe strings (`30`, `240`, `1W`, `1M` verified live) and builds non-stored ones itself,
 * so every resolution the chart offers passes through unchanged; anything else falls back to its
 * engine source timeframe (`resolution.ts`), then to H1.
 */
export function runTimeframeFor(resolution: TvResolution): string {
  if (resolutionSource(resolution)) return resolution;
  const engine = /^(M1|M5|M15|H1|H4|D1)$/.test(resolution) ? resolution : null;
  return engine ?? 'H1';
}

/** The bars a run is computed on for the chart (`scripting/run` `chartType`). */
export type ScriptBasis = 'standard' | 'heikinashi';

/** Styles drawn from bricks built by price movement rather than time. */
const PRICE_BASED_STYLES = new Set(['renko', 'kagi', 'pnf', 'line-break', 'range']);

/**
 * The chart type a run must be made on to sit on a chart of `style` (PC-09, PC-I8). Heikin-Ashi
 * candles are the engine's `heikinashi` bars — the same builder as the chart's (each open the
 * previous HA bar's midpoint, the same bar times), so the script computes on what is drawn, as
 * TradingView's does; it used to run on the standard OHLC under Heikin-Ashi candles. Every other
 * time-based style (candles, bars, line, area, …) draws the standard bars. The price-based styles —
 * Renko, Kagi, Point & Figure, Line break, Range — build their bricks in the browser by the chart's
 * own box (an ATR multiple or pips, sequenced a second apart), which the engine's bricks (ATR(14),
 * tick-rounded) do not reproduce: a run cannot be placed on them — null, "not available on this
 * chart type" — rather than hidden silently or drawn on the wrong bricks.
 */
export function scriptBasisOf(style: string): ScriptBasis | null {
  if (style === 'heikin-ashi') return 'heikinashi';
  return PRICE_BASED_STYLES.has(style) ? null : 'standard';
}

/** `strategy(` anywhere at the start of a line → strategy; otherwise indicator. */
export function detectScriptKind(source: string): 'indicator' | 'strategy' {
  return /^\s*strategy\s*\(/m.test(source) ? 'strategy' : 'indicator';
}

// ── Normalisation ────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function strategyToChart(rawReport: unknown): ChartStrategyResult | null {
  const report = normalizeStrategyReport(rawReport);
  if (!report) return null;
  const all = report.performance.all;
  const metrics: ChartStrategyMetrics = {
    currency: report.meta.accountCurrency || '',
    initialCapital: report.meta.initialCapital,
    netProfit: all.netProfit,
    netProfitPercent: all.netProfitPercent,
    grossProfit: all.grossProfit,
    grossLoss: all.grossLoss,
    profitFactor: all.profitFactor,
    maxDrawdown: report.equity.maxDrawdown,
    maxDrawdownPercent: report.equity.maxDrawdownPercent,
    winRatePercent: all.percentProfitable,
    totalClosedTrades: all.totalClosedTrades,
    winningTrades: all.winningTrades,
    losingTrades: all.losingTrades,
    avgTrade: all.avgTrade,
    finalEquity: report.equity.finalEquity,
    sharpeRatio: report.returns.sharpeRatio,
    sortinoRatio: report.returns.sortinoRatio,
  };
  const trades: ChartTrade[] = report.trades
    .filter((t) => finite(t.entryTime) && finite(t.entryPrice))
    .map((t) => ({
      number: t.number ?? 0,
      side: t.direction === 'short' ? 'short' : 'long',
      isOpen: t.isOpen,
      entryTime: toChartSeconds(t.entryTime as number),
      entryPrice: t.entryPrice as number,
      entrySignal: t.entrySignal || t.entryId,
      exitTime: finite(t.exitTime) ? toChartSeconds(t.exitTime) : null,
      exitPrice: finite(t.exitPrice) ? t.exitPrice : null,
      exitSignal: t.exitSignal || t.exitId || null,
      qty: t.qty ?? 0,
      profit: t.profit ?? 0,
      profitPercent: t.profitPercent,
      cumulativeProfit: t.cumulativeProfit,
    }));
  const equity: ScriptPoint[] = [];
  for (const p of report.equityCurve) {
    if (!finite(p.time) || !finite(p.equity)) continue;
    const time = toChartSeconds(p.time);
    if (equity.length && equity[equity.length - 1].time >= time) continue; // strictly ascending
    equity.push({ time, value: p.equity });
  }
  return { trades, metrics, equity, report, warnings: report.warnings };
}

/** `POST scripting/run` `data` (any casing the shared normaliser accepts) → {@link ChartScriptResult}. */
export function toChartScriptResult(raw: unknown): ChartScriptResult {
  const run = normalizeRunResult(raw);
  const compile = ((raw as { compile?: ScriptCompileResult } | null)?.compile ??
    null) as ScriptCompileResult | null;
  const decl = run?.compile?.declaration ?? null;
  const kind =
    (String(decl?.kind ?? 'indicator').toLowerCase() as ChartScriptResult['kind']) || 'indicator';
  const overlay = decl?.overlay === true;
  const diagnostics = (compile?.diagnostics ?? []) as ScriptDiagnostic[];
  const firstError = diagnostics.find((d) => d.severity === 'error');
  const rt = run?.runtimeError;
  const error = firstError
    ? `Line ${firstError.line}: ${firstError.message}`
    : rt
      ? `${rt.message}${rt.line ? ` (line ${rt.line})` : ''}`
      : run
        ? null
        : 'The engine did not return a run result.';
  const errorAt = firstError
    ? firstError.line > 0
      ? { line: firstError.line, column: Math.max(1, firstError.column || 1) }
      : null
    : rt && finite(rt.line) && rt.line > 0
      ? { line: rt.line, column: finite(rt.column) && rt.column > 0 ? rt.column : 1 }
      : null;
  const rawReport = (raw as { report?: unknown } | null)?.report;
  return {
    title: decl?.shortTitle || decl?.title || 'Script',
    kind,
    overlay,
    compile,
    inputs: compile?.inputs ?? [],
    diagnostics,
    error,
    errorAt,
    errorUnit: firstError ? (firstError.unit ?? null) : (rt?.unit ?? null),
    errorStack: firstError ? [] : (rt?.callStack ?? []),
    strategy: kind === 'strategy' && rawReport ? strategyToChart(rawReport) : null,
    run,
    session: ((raw as { session?: ScriptRunSession | null } | null)?.session ?? null) as ScriptRunSession | null,
  };
}

/**
 * What the Pine Editor shows for a run of its text that failed on the chart ("Update on chart",
 * PC-06): the compile diagnostics, and a runtime error as one more error at its line — the editor
 * marks and lists them. Null when the run did not fail or carries no compile response.
 */
export function editorReport(result: ChartScriptResult): ScriptCompileResult | null {
  const compile = result.compile;
  if (!result.error || !compile) return null;
  const rt = result.run?.runtimeError;
  if (!rt || result.diagnostics.some((d) => d.severity === 'error')) return compile;
  const line = rt.line && rt.line > 0 ? rt.line : 1;
  const column = rt.column && rt.column > 0 ? rt.column : 1;
  const where = rt.unit ? ` (in library ${rt.unit})` : '';
  const bar = typeof rt.barIndex === 'number' ? ` on bar ${rt.barIndex}` : '';
  return {
    ...compile,
    diagnostics: [
      ...compile.diagnostics,
      {
        code: rt.code,
        severity: 'error',
        message: `Runtime error${bar}${where}: ${rt.message}`,
        line,
        column,
        endLine: line,
        endColumn: column + 1,
        unit: rt.unit ?? null,
      },
    ],
  };
}
