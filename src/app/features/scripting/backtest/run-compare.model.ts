/**
 * PE-I7: cross-market robustness and run comparison.
 *
 * - A basket backtest runs one strategy on several markets through the symbol override (one queued
 *   run per market); its matrix lines the runs up, and a strategy whose edge survives only on its
 *   own market is a fit to that market.
 * - Two runs compare by their metrics, their equity (rebased to the same start) and how they were
 *   made: the script hash, the inputs, the cost model, the market and the window.
 */
import type { EChartsOption } from 'echarts';

import type { BacktestRunDto } from '@core/api/api.types';
import type { BacktestRunCompareFields } from '@core/api/scripting.types';

import {
  inputDifferences,
  parseEngineRun,
  type InputDifference,
  type RunProvenance,
} from '../report/engine-run';
import { quantile } from '../report/r-analysis';
import { formatNumber, formatPercent, MINUS, NA } from '../report/report-format';
import type { ReportPalette } from '../report/report-charts';

export type CompareRun = BacktestRunDto & BacktestRunCompareFields;

/** The usual liquid majors a basket starts from (the strategy's own market is left out). */
export const MAJOR_PAIRS: readonly string[] = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
];

/** At most this many markets beside the strategy's own in one basket. */
export const MAX_BASKET = 12;

/**
 * The basket's other markets from free text ("GBPUSD, usdjpy  AUDUSD"): upper-cased, de-duplicated,
 * the strategy's own symbol left out (it is the basket's base run).
 */
export function parseBasket(
  text: string,
  ownSymbol: string,
): { symbols: string[]; error: string | null } {
  const own = ownSymbol.trim().toUpperCase();
  const symbols: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim().toUpperCase();
    if (!s) continue;
    if (!/^[A-Z0-9]{1,10}$/.test(s)) {
      return { symbols: [], error: `"${raw.trim()}" is not a symbol: 1–10 letters or digits.` };
    }
    if (s === own || symbols.includes(s)) continue;
    symbols.push(s);
  }
  if (symbols.length > MAX_BASKET) {
    return { symbols: [], error: `A basket runs on at most ${MAX_BASKET} other markets.` };
  }
  return { symbols, error: null };
}

export interface RunSummary {
  id: number;
  symbol: string;
  timeframe: string;
  status: string;
  /** Run on another market or timeframe than the strategy's own. */
  override: boolean;
  fromDate: string;
  toDate: string;
  totalTrades: number | null;
  /** Percent (the engine stores TotalReturn already ×100). */
  totalReturn: number | null;
  /** 0–1. */
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  sharpeRatio: number | null;
  expectancyR: number | null;
  provenance: RunProvenance | null;
  /** The equity curve as % change from its first point. */
  equity: { time: number; pct: number }[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number | null => (finite(v) ? v : null);

export function summarizeRun(run: CompareRun): RunSummary {
  const engine = parseEngineRun(run.resultJson);
  const curve = (run.equityCurve ?? [])
    .map((p) => ({ time: Date.parse(p.time), equity: Number(p.equity) }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.equity));
  const start = curve[0]?.equity;
  return {
    id: run.id,
    symbol: run.symbol ?? '',
    timeframe: String(run.timeframe ?? ''),
    status: String(run.status ?? ''),
    override: !!run.symbolOverride || !!run.timeframeOverride,
    fromDate: run.fromDate,
    toDate: run.toDate,
    totalTrades: num(run.totalTrades),
    totalReturn: num(run.totalReturn),
    winRate: num(run.winRate),
    profitFactor: num(run.profitFactor),
    maxDrawdownPct: num(run.maxDrawdownPct),
    sharpeRatio: num(run.sharpeRatio),
    expectancyR: engine?.expectancyR ?? null,
    provenance: engine?.provenance ?? null,
    equity:
      start && start > 0
        ? curve.map((p) => ({ time: p.time, pct: (p.equity / start - 1) * 100 }))
        : [],
  };
}

export const isFinished = (status: string) => status === 'Completed' || status === 'Failed';

export interface BasketSummary {
  runs: number;
  completed: number;
  /** Completed runs with a positive return. */
  profitable: number;
  medianReturn: number | null;
  medianExpectancyR: number | null;
}

export function basketSummary(rows: readonly RunSummary[]): BasketSummary {
  const done = rows.filter((r) => r.status === 'Completed');
  const returns = done
    .map((r) => r.totalReturn)
    .filter(finite)
    .sort((a, b) => a - b);
  const rs = done
    .map((r) => r.expectancyR)
    .filter(finite)
    .sort((a, b) => a - b);
  return {
    runs: rows.length,
    completed: done.length,
    profitable: done.filter((r) => (r.totalReturn ?? 0) > 0).length,
    medianReturn: returns.length ? quantile(returns, 0.5) : null,
    medianExpectancyR: rs.length ? quantile(rs, 0.5) : null,
  };
}

/** A plain reading of a basket — whether the edge travels beyond the strategy's own market. */
export function basketVerdict(s: BasketSummary, ownProfitable: boolean | null): string {
  if (s.completed < 2) return 'Waiting for the runs to finish.';
  const share = s.profitable / s.completed;
  if (ownProfitable === true && s.profitable <= 1) {
    return 'Only the strategy’s own market makes money: the rules look fitted to it.';
  }
  if (share >= 0.7)
    return `Profitable on ${s.profitable} of ${s.completed} markets: the rules travel.`;
  if (share >= 0.4)
    return `Profitable on ${s.profitable} of ${s.completed} markets: a mixed result.`;
  return `Profitable on ${s.profitable} of ${s.completed} markets: the rules do not travel.`;
}

// ── Two-run comparison ─────────────────────────────────────────────────────────

export interface MetricRow {
  label: string;
  a: string;
  b: string;
  /** b − a, as text. */
  delta: string;
  /** Which run is better on this metric; null when equal or not comparable. */
  better: 'a' | 'b' | null;
}

interface MetricSpec {
  label: string;
  get: (r: RunSummary) => number | null;
  text: (v: number | null) => string;
  /** Higher is better (false: lower is better, e.g. drawdown). */
  higher: boolean;
}

const pctText = (v: number | null) => formatPercent(v, { decimals: 2, signed: true });
const METRICS: readonly MetricSpec[] = [
  { label: 'Return', get: (r) => r.totalReturn, text: pctText, higher: true },
  { label: 'Trades', get: (r) => r.totalTrades, text: (v) => formatNumber(v, 0), higher: true },
  {
    label: 'Win rate',
    get: (r) => (r.winRate === null ? null : r.winRate * 100),
    text: (v) => formatPercent(v, { decimals: 1 }),
    higher: true,
  },
  {
    label: 'Profit factor',
    get: (r) => r.profitFactor,
    text: (v) => formatNumber(v, 2),
    higher: true,
  },
  {
    label: 'Max drawdown',
    get: (r) => r.maxDrawdownPct,
    text: (v) => formatPercent(v, { decimals: 2 }),
    higher: false,
  },
  { label: 'Sharpe', get: (r) => r.sharpeRatio, text: (v) => formatNumber(v, 2), higher: true },
  {
    label: 'Expectancy (R)',
    get: (r) => r.expectancyR,
    text: (v) => (v === null ? NA : `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(2)}R`),
    higher: true,
  },
];

export function compareMetrics(a: RunSummary, b: RunSummary): MetricRow[] {
  return METRICS.map((m) => {
    const va = m.get(a);
    const vb = m.get(b);
    let better: 'a' | 'b' | null = null;
    let delta = NA;
    if (va !== null && vb !== null) {
      const d = vb - va;
      delta = d === 0 ? '0' : `${d < 0 ? MINUS : '+'}${formatNumber(Math.abs(d), 2)}`;
      if (d !== 0) better = d > 0 === m.higher ? 'b' : 'a';
    }
    return { label: m.label, a: m.text(va), b: m.text(vb), delta, better };
  });
}

export interface SetupRow {
  label: string;
  a: string;
  b: string;
  same: boolean;
}

export interface SetupComparison {
  /** Same script source (hash); null when either run carries no hash. */
  sameScript: boolean | null;
  inputDiffs: InputDifference[];
  rows: SetupRow[];
}

/** How the two runs were made, side by side: what differs explains a difference in results. */
export function compareSetup(a: RunSummary, b: RunSummary): SetupComparison {
  const pa = a.provenance;
  const pb = b.provenance;
  const row = (label: string, x: string, y: string): SetupRow => ({
    label,
    a: x,
    b: y,
    same: x === y,
  });
  const rows: SetupRow[] = [
    row('Market', `${a.symbol} ${a.timeframe}`, `${b.symbol} ${b.timeframe}`),
    row(
      'Window',
      `${a.fromDate.slice(0, 10)} → ${a.toDate.slice(0, 10)}`,
      `${b.fromDate.slice(0, 10)} → ${b.toDate.slice(0, 10)}`,
    ),
  ];
  if (pa || pb) {
    rows.push(row('Script', pa?.sourceHash.slice(0, 12) || NA, pb?.sourceHash.slice(0, 12) || NA));
    rows.push(row('Cost model', pa?.costModel || NA, pb?.costModel || NA));
    rows.push(
      row(
        'Fills',
        pa
          ? [pa.deep ? 'deep' : 'standard', pa.barMagnifier ? 'magnifier' : 'OHLC path'].join(', ')
          : NA,
        pb
          ? [pb.deep ? 'deep' : 'standard', pb.barMagnifier ? 'magnifier' : 'OHLC path'].join(', ')
          : NA,
      ),
    );
  }
  return {
    sameScript: pa?.sourceHash && pb?.sourceHash ? pa.sourceHash === pb.sourceHash : null,
    inputDiffs: pa && pb ? inputDifferences(pa.inputs, pb.inputs) : [],
    rows,
  };
}

/** Both runs' equity rebased to 0% at their start, on one time axis. Null without two curves. */
export function equityOverlayOptions(
  a: RunSummary,
  b: RunSummary,
  palette: ReportPalette,
): EChartsOption | null {
  if (a.equity.length < 2 || b.equity.length < 2) return null;
  const series = (r: RunSummary, color: string, dashed: boolean) => ({
    type: 'line' as const,
    name: `#${r.id} ${r.symbol}`,
    showSymbol: false,
    sampling: 'lttb' as const,
    lineStyle: { width: 1.6, color, type: dashed ? ('dashed' as const) : ('solid' as const) },
    itemStyle: { color },
    data: r.equity.map((p) => [p.time, +p.pct.toFixed(3)]),
  });
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 28, bottom: 32 },
    legend: { top: 0, textStyle: { color: palette.textMuted } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) =>
        typeof v === 'number' ? `${v >= 0 ? '+' : MINUS}${Math.abs(v).toFixed(2)}%` : String(v),
    },
    xAxis: { type: 'time', axisLabel: { color: palette.textMuted } },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.textMuted, formatter: (v: number) => `${v}%` },
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: [series(a, palette.accent, false), series(b, palette.deEmphasis, true)],
  };
}
