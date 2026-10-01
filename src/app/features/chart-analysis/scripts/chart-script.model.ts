import { cssColor } from '@shared/pine-chart/core/color';
import { normalizeRunResult } from '@shared/pine-chart/model/normalize';
import type {
  PineOutputX,
  PinePlotOutput,
  PineRunResult,
  PineScriptOutputs,
} from '@shared/pine-chart/model/pine-outputs.types';
import {
  normalizeStrategyReport,
  type StrategyReport,
} from '@features/scripting/report/strategy-report.model';
import type {
  ScriptCompileResult,
  ScriptDiagnostic,
  ScriptInputDto,
} from '@core/api/scripting.types';
import { resolutionSource, type TvResolution } from '../datafeed/resolution';

/**
 * A Pine run reshaped for the chart-analysis page (lightweight-charts).
 *
 * <p>Every `time` here is a **UTC Unix timestamp in seconds** — lightweight-charts' `UTCTimestamp`,
 * the unit `chart-host.component.ts` (`asTime`) feeds its series. The engine sends milliseconds;
 * {@link toChartSeconds} is the one conversion. The chart's display-timezone shift is applied by
 * the renderer (`script-renderer.ts`, `shiftMs`), never here, so a result can be re-rendered when
 * the operator changes zone.</p>
 */

export type ScriptPane = 'overlay' | 'separate';

export type ScriptPlotStyle = 'line' | 'step' | 'histogram' | 'area' | 'points';

export interface ScriptPoint {
  time: number;
  value: number;
  /** Per-bar color (CSS) when the plot's color varies. */
  color?: string;
}

/** A plot sample, or a gap (whitespace — `linebr`-style plots break the line there). */
export type ScriptGap = { time: number; value?: undefined };
export type ScriptPlotDatum = ScriptPoint | ScriptGap;

export function isGap(d: ScriptPlotDatum): d is ScriptGap {
  return d.value === undefined;
}

export interface ScriptPlot {
  id: number;
  title: string;
  style: ScriptPlotStyle;
  color: string;
  lineWidth: number;
  /** `linebr` / `areabr`: na breaks the line instead of joining over it. */
  breaks: boolean;
  dashed: boolean;
  pane: ScriptPane;
  histBase: number;
  data: ScriptPlotDatum[];
}

export interface ScriptHline {
  price: number;
  title: string;
  color: string;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  pane: ScriptPane;
}

export type ScriptMarkerShape = 'arrowUp' | 'arrowDown' | 'circle' | 'square';
export type ScriptMarkerPosition = 'aboveBar' | 'belowBar' | 'inBar';

export interface ScriptMarker {
  time: number;
  position: ScriptMarkerPosition;
  shape: ScriptMarkerShape;
  color: string;
  text: string;
  pane: ScriptPane;
}

export interface ScriptLine {
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  color: string;
  width: number;
  style: 'solid' | 'dashed' | 'dotted';
  extend: 'none' | 'left' | 'right' | 'both';
}

export interface ScriptBox {
  t1: number;
  top: number;
  t2: number;
  bottom: number;
  borderColor: string | null;
  bgColor: string | null;
  text: string;
  textColor: string;
}

export interface ScriptLabel {
  time: number;
  price: number;
  text: string;
  color: string | null;
  textColor: string;
  /** `label_down` style labels sit above their point, `label_up` below. */
  above: boolean;
}

export interface ScriptBackground {
  time: number;
  color: string;
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
  plots: ScriptPlot[];
  hlines: ScriptHline[];
  markers: ScriptMarker[];
  lines: ScriptLine[];
  boxes: ScriptBox[];
  labels: ScriptLabel[];
  backgrounds: ScriptBackground[];
  strategy: ChartStrategyResult | null;
  /**
   * The run as the shared Pine renderer reads it (`@shared/pine-chart` normaliser) — what
   * `script-renderer.ts` paints. The flattened fields above are for legends, panels and tests.
   */
  run: PineRunResult | null;
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

/** `strategy(` anywhere at the start of a line → strategy; otherwise indicator. */
export function detectScriptKind(source: string): 'indicator' | 'strategy' {
  return /^\s*strategy\s*\(/m.test(source) ? 'strategy' : 'indicator';
}

// ── Normalisation ────────────────────────────────────────────────────────────

const FALLBACK = '#2962FF';
const css = (c: string | null | undefined, dflt = FALLBACK): string => cssColor(c) ?? dflt;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const lineStyle = (s: string | null | undefined): 'solid' | 'dashed' | 'dotted' =>
  s === 'dashed' || s === 'dotted' ? s : 'solid';
const shown = (display: readonly string[] | undefined): boolean =>
  !display || !display.includes('none');

function plotStyle(style: string): { style: ScriptPlotStyle; breaks: boolean } {
  switch (style) {
    case 'histogram':
    case 'columns':
      return { style: 'histogram', breaks: false };
    case 'area':
      return { style: 'area', breaks: false };
    case 'areabr':
      return { style: 'area', breaks: true };
    case 'stepline':
    case 'stepline_diamond':
      return { style: 'step', breaks: false };
    case 'steplinebr':
      return { style: 'step', breaks: true };
    case 'circles':
    case 'cross':
      return { style: 'points', breaks: true };
    case 'linebr':
      return { style: 'line', breaks: true };
    default:
      return { style: 'line', breaks: false };
  }
}

function timeAt(times: readonly number[], i: number, step: number): number | null {
  if (i >= 0 && i < times.length) return times[i];
  if (!times.length || !step) return null;
  return i < 0 ? times[0] + i * step : times[times.length - 1] + (i - times.length + 1) * step;
}

function toPlot(p: PinePlotOutput, times: readonly number[], step: number, overlay: boolean): ScriptPlot {
  const { style, breaks } = plotStyle(String(p.style));
  const uniform = css(p.color);
  const data: ScriptPlotDatum[] = [];
  const offset = finite(p.offset) ? p.offset : 0;
  const start = finite(p.showLast) && p.showLast > 0 ? Math.max(0, p.values.length - p.showLast) : 0;
  for (let i = start; i < p.values.length; i++) {
    const v = p.values[i];
    const t = timeAt(times, i + offset, step);
    if (t === null) continue;
    if (!finite(v)) {
      if (breaks && data.length) data.push({ time: toChartSeconds(t) });
      continue;
    }
    const pt: ScriptPoint = { time: toChartSeconds(t), value: v };
    if (p.colors) {
      const c = p.colors[i];
      if (c === null || c === undefined) {
        // na color = not drawn on that bar
        if (data.length) data.push({ time: pt.time });
        continue;
      }
      pt.color = css(c, uniform);
    }
    data.push(pt);
  }
  return {
    id: p.id,
    title: p.title ?? `Plot ${p.plotNumber}`,
    style,
    color: uniform,
    lineWidth: Math.max(1, Math.min(4, Math.round(p.lineWidth || 1))),
    breaks,
    dashed: p.lineStyle === 'dashed' || p.lineStyle === 'dotted',
    pane: overlay || p.forceOverlay ? 'overlay' : 'separate',
    histBase: finite(p.histBase) ? p.histBase : 0,
    data,
  };
}

function xTime(x: PineOutputX | null | undefined, times: readonly number[], step: number): number | null {
  if (finite(x?.time)) return toChartSeconds(x!.time);
  if (finite(x?.barIndex)) {
    const t = timeAt(times, x!.barIndex, step);
    return t === null ? null : toChartSeconds(t);
  }
  return null;
}

function markerShape(shape: string | null | undefined, kind: string, dir: string | null | undefined): ScriptMarkerShape {
  if (kind === 'arrow') return dir === 'down' ? 'arrowDown' : 'arrowUp';
  switch (shape) {
    case 'triangleup':
    case 'arrowup':
    case 'labelup':
      return 'arrowUp';
    case 'triangledown':
    case 'arrowdown':
    case 'labeldown':
      return 'arrowDown';
    case 'square':
    case 'diamond':
      return 'square';
    default:
      return 'circle';
  }
}

function markerPosition(location: string | null | undefined): ScriptMarkerPosition {
  if (location === 'belowbar' || location === 'bottom') return 'belowBar';
  if (location === 'absolute') return 'inBar';
  return 'aboveBar';
}

function outputsToChart(o: PineScriptOutputs | null, overlay: boolean) {
  const empty = {
    plots: [] as ScriptPlot[],
    hlines: [] as ScriptHline[],
    markers: [] as ScriptMarker[],
    lines: [] as ScriptLine[],
    boxes: [] as ScriptBox[],
    labels: [] as ScriptLabel[],
    backgrounds: [] as ScriptBackground[],
  };
  if (!o) return empty;
  const times = o.bars.times;
  const offset = o.bars.firstIndex || 0;
  const step = times.length > 1 ? times[1] - times[0] : 0;
  // Drawing bar indexes are absolute bar_index; per-bar arrays are relative to firstIndex.
  const rel = (x: PineOutputX | null | undefined): PineOutputX | null | undefined =>
    x && finite(x.barIndex) ? { ...x, barIndex: x.barIndex - offset } : x;

  empty.plots = o.plots.filter((p) => shown(p.display)).map((p) => toPlot(p, times, step, overlay));

  empty.hlines = o.hlines
    .filter((h) => finite(h.price) && shown(h.display))
    .map((h) => ({
      price: h.price as number,
      title: h.title ?? '',
      color: css(h.color, '#787B86'),
      lineStyle: lineStyle(h.lineStyle),
      pane: overlay ? ('overlay' as const) : ('separate' as const),
    }));

  for (const m of o.markers) {
    if (!shown(m.display)) continue;
    const pane: ScriptPane = overlay || m.forceOverlay ? 'overlay' : 'separate';
    for (const pt of m.points) {
      const t = finite(pt.time) ? pt.time : timeAt(times, pt.barIndex - offset, step);
      if (t === null) continue;
      empty.markers.push({
        time: toChartSeconds(t),
        position: markerPosition(m.location),
        shape: markerShape(m.shape, String(m.kind), pt.direction),
        color: css(pt.color, '#2962FF'),
        text: m.kind === 'char' ? (m.char ?? m.text ?? '') : (m.text ?? ''),
        pane,
      });
    }
  }

  for (const l of o.lines) {
    const t1 = xTime(rel(l.x1), times, step);
    const t2 = xTime(rel(l.x2), times, step);
    if (t1 === null || t2 === null || !finite(l.y1) || !finite(l.y2)) continue;
    empty.lines.push({
      t1,
      p1: l.y1,
      t2,
      p2: l.y2,
      color: css(l.color),
      width: l.width || 1,
      style: lineStyle(l.style),
      extend: (['left', 'right', 'both'].includes(l.extend) ? l.extend : 'none') as ScriptLine['extend'],
    });
  }

  for (const b of o.boxes) {
    const t1 = xTime(rel(b.left), times, step);
    const t2 = xTime(rel(b.right), times, step);
    if (t1 === null || t2 === null || !finite(b.top) || !finite(b.bottom)) continue;
    empty.boxes.push({
      t1,
      top: b.top,
      t2,
      bottom: b.bottom,
      borderColor: cssColor(b.borderColor),
      bgColor: cssColor(b.bgColor),
      text: b.text ?? '',
      textColor: css(b.textColor, '#131722'),
    });
  }

  for (const l of o.labels) {
    const t = xTime(rel(l.x), times, step);
    if (t === null || !finite(l.y)) continue;
    empty.labels.push({
      time: t,
      price: l.y,
      text: l.text ?? '',
      color: cssColor(l.color),
      textColor: css(l.textColor, '#FFFFFF'),
      above: !String(l.style).includes('up'),
    });
  }

  for (const bg of o.backgrounds) {
    if (!shown(bg.display)) continue;
    bg.colors.forEach((c, i) => {
      const color = cssColor(c);
      const t = timeAt(times, i + (bg.offset || 0), step);
      if (color && t !== null) empty.backgrounds.push({ time: toChartSeconds(t), color });
    });
  }

  for (const list of [empty.markers, empty.labels, empty.backgrounds] as { time: number }[][]) {
    list.sort((a, b) => a.time - b.time);
  }
  return empty;
}

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
  const compile = ((raw as { compile?: ScriptCompileResult } | null)?.compile ?? null) as ScriptCompileResult | null;
  const decl = run?.compile?.declaration ?? null;
  const kind = (String(decl?.kind ?? 'indicator').toLowerCase() as ChartScriptResult['kind']) || 'indicator';
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
  const out = outputsToChart(run?.outputs ?? null, overlay);
  const rawReport = (raw as { report?: unknown } | null)?.report;
  return {
    title: decl?.shortTitle || decl?.title || 'Script',
    kind,
    overlay,
    compile,
    inputs: compile?.inputs ?? [],
    diagnostics,
    error,
    ...out,
    strategy: kind === 'strategy' && rawReport ? strategyToChart(rawReport) : null,
    run,
  };
}
