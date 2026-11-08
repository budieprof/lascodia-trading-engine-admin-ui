import type { EChartsOption } from 'echarts';

import type { ExecutionQualityLogDto, StrategyLifecycleTransitionDto } from '@core/api/api.types';

import type { ReportPalette } from '../report/report-charts';
import { withAlpha } from '../report/report-charts';
import { formatDateTime, formatNumber } from '../report/report-format';
import type { ScriptDivergence, ScriptLiveClosedTrade } from '../api/scripting-api.types';
import { isoMs } from './parity.model';
import { tradeR } from './live.model';

/**
 * U09 — what the session actually did against what its backtest said it would: cumulative R of the paper and live
 * trades next to the backtest's expectation (mean R × trades taken, with the ±1σ and ±2σ band of a sum of that many
 * backtest trades), the fills' slippage over time, the strategy's path backtest → walk-forward → paper → live, and
 * the divergence markers (BarRevised and the rest) on the same time axis. Pure.
 *
 * Expected is a statement about the AVERAGE path: a realised line inside the 2σ band is consistent with the backtest;
 * one persistently outside it is not. Nothing here is fitted or smoothed — every point is a closed trade or a fill.
 */

export type SessionOrigin = 'paper' | 'live';

/** The backtest the session is compared with: its per-trade R. */
export interface ExpectationSource {
  backtestRunId: number;
  /** R of its closed trades with a stop, in order. */
  rValues: readonly number[];
  fromDate: string | null;
  toDate: string | null;
}

export interface Expectation {
  backtestRunId: number;
  trades: number;
  meanR: number;
  /** Sample sd of the backtest R; null below two trades. */
  sdR: number | null;
}

export function expectationOf(src: ExpectationSource): Expectation | null {
  const v = src.rValues.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd =
    v.length > 1
      ? Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (v.length - 1))
      : null;
  return { backtestRunId: src.backtestRunId, trades: v.length, meanR: mean, sdR: sd };
}

export interface CumulativePoint {
  time: number;
  /** Trades taken so far (1-based). */
  n: number;
  realised: number;
  expected: number | null;
  /** ±1σ and ±2σ of a sum of n backtest trades around `expected`. */
  band1: [number, number] | null;
  band2: [number, number] | null;
}

/** The session's closed trades of one origin with an R, in close order, cumulated against the expectation. */
export function cumulativeVsExpected(
  trades: readonly ScriptLiveClosedTrade[],
  origin: SessionOrigin,
  expectation: Expectation | null,
): { points: CumulativePoint[]; closed: number; withR: number } {
  const mine = trades
    .filter((t) => t.origin === origin && t.exitTimeMs !== null)
    .sort((a, b) => (a.exitTimeMs ?? 0) - (b.exitTimeMs ?? 0));
  const points: CumulativePoint[] = [];
  let cum = 0;
  let n = 0;
  for (const t of mine) {
    const r = tradeR(t);
    if (r === null) continue;
    n++;
    cum += r;
    const expected = expectation ? expectation.meanR * n : null;
    const spread = expectation?.sdR != null ? expectation.sdR * Math.sqrt(n) : null;
    points.push({
      time: t.exitTimeMs!,
      n,
      realised: cum,
      expected,
      band1: expected !== null && spread !== null ? [expected - spread, expected + spread] : null,
      band2:
        expected !== null && spread !== null
          ? [expected - 2 * spread, expected + 2 * spread]
          : null,
    });
  }
  return { points, closed: mine.length, withR: n };
}

/** How the last realised point sits against the band — words, never a colour alone. */
export function overlayVerdict(points: readonly CumulativePoint[]): string | null {
  const last = points[points.length - 1];
  if (!last || last.expected === null) return null;
  const gap = last.realised - last.expected;
  const where =
    last.band2 && (last.realised < last.band2[0] || last.realised > last.band2[1])
      ? 'outside the 2σ band — not consistent with the backtest'
      : last.band1 && (last.realised < last.band1[0] || last.realised > last.band1[1])
        ? 'between 1σ and 2σ — watch it'
        : 'inside the 1σ band — consistent with the backtest so far';
  return `After ${last.n} trade${last.n === 1 ? '' : 's'}: realised ${formatNumber(last.realised, 2, true)} R vs expected ${formatNumber(last.expected, 2, true)} R (${formatNumber(gap, 2, true)} R), ${where}.`;
}

export interface SlippagePoint {
  time: number;
  /** Rolling median of the last `window` fills' slippage, in pips as the execution-quality log records it. */
  median: number;
  fills: number;
}

/** Rolling median slippage of a strategy's fills (execution-quality rows), oldest first. */
export function rollingSlippage(
  rows: readonly ExecutionQualityLogDto[],
  window = 20,
): SlippagePoint[] {
  const fills = rows
    .map((r) => ({ time: isoMs(r.recordedAt), pips: r.slippagePips }))
    .filter((f): f is { time: number; pips: number } => f.time !== null && Number.isFinite(f.pips))
    .sort((a, b) => a.time - b.time);
  const out: SlippagePoint[] = [];
  const w = Math.max(1, Math.floor(window));
  for (let i = 0; i < fills.length; i++) {
    const slice = fills.slice(Math.max(0, i - w + 1), i + 1).map((f) => f.pips);
    if (slice.length < Math.min(w, 5)) continue; // a median of fewer than 5 fills says nothing
    slice.sort((a, b) => a - b);
    const mid = slice.length >> 1;
    const median = slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
    out.push({ time: fills[i].time, median, fills: slice.length });
  }
  return out;
}

/** One milestone of the strategy's research → paper → live path, from records the engine holds. */
export interface StageMilestone {
  stage: 'backtest' | 'walk-forward' | 'paper' | 'live' | 'current' | 'transition';
  label: string;
  time: number;
  detail: string;
}

export interface StageInputs {
  /** The compared backtest: completed time + window. */
  backtest: {
    id: number;
    completedAt: string | null;
    fromDate: string | null;
    toDate: string | null;
  } | null;
  /** The newest completed walk-forward. */
  walkForward: { id: number; completedAt: string | null } | null;
  trades: readonly ScriptLiveClosedTrade[];
  lifecycleStage: string | null;
  lifecycleStageEnteredAt: string | null;
  /**
   * The engine's recorded stage / status transitions (CONTRACT K1, any order). When there are any they replace the
   * "entered the current stage" milestone — the newest transition IS that record, with where it came from.
   */
  transitions?: readonly StrategyLifecycleTransitionDto[] | null;
}

/** "Approved → Active", "status Active → Paused", or both; a first row with no `from` reads "→ Draft". */
export function transitionLabel(t: StrategyLifecycleTransitionDto): string {
  const parts: string[] = [];
  if (t.toStage && t.fromStage !== t.toStage)
    parts.push(`${t.fromStage ?? ''} → ${t.toStage}`.trim());
  if (t.toStatus && t.fromStatus !== t.toStatus)
    parts.push(`status ${`${t.fromStatus ?? ''} → ${t.toStatus}`.trim()}`);
  return parts.length > 0 ? parts.join(' · ') : `${t.toStage} (re-recorded)`;
}

/** "Reason · by Operator (alice) · config 3f9a1c2b" — every part the row has, nothing invented. */
export function transitionDetail(t: StrategyLifecycleTransitionDto): string {
  const who = t.actor ? `${t.source} (${t.actor})` : t.source;
  const parts = [
    t.reason?.trim(),
    who ? `by ${who}` : '',
    t.source === 'Backfill' ? 'reconstructed from older records' : '',
  ];
  if (t.strategyConfigHash) parts.push(`config ${t.strategyConfigHash.slice(0, 8)}`);
  return parts.filter((p) => !!p).join(' · ');
}

/** Milestones in time order. Each comes from a stored record; a stage without one is simply absent. */
export function stageTimeline(input: StageInputs): StageMilestone[] {
  const out: StageMilestone[] = [];
  const bt = input.backtest;
  const btAt = isoMs(bt?.completedAt);
  if (bt && btAt !== null) {
    out.push({
      stage: 'backtest',
      label: `Backtest #${bt.id}`,
      time: btAt,
      detail:
        bt.fromDate && bt.toDate
          ? `window ${bt.fromDate.slice(0, 10)} → ${bt.toDate.slice(0, 10)}`
          : 'completed',
    });
  }
  const wf = input.walkForward;
  const wfAt = isoMs(wf?.completedAt);
  if (wf && wfAt !== null) {
    out.push({
      stage: 'walk-forward',
      label: `Walk-forward #${wf.id}`,
      time: wfAt,
      detail: 'completed',
    });
  }
  for (const origin of ['paper', 'live'] as const) {
    const first = input.trades
      .filter((t) => t.origin === origin && t.entryTimeMs !== null)
      .reduce<
        number | null
      >((m, t) => (m === null || t.entryTimeMs! < m ? t.entryTimeMs! : m), null);
    if (first !== null) {
      out.push({
        stage: origin,
        label: origin === 'paper' ? 'First paper trade' : 'First live trade',
        time: first,
        detail: 'entry of the session’s first trade of this kind (newest 500 trades kept)',
      });
    }
  }
  const transitions = (input.transitions ?? [])
    .map((t) => ({ t, time: isoMs(t.occurredAtUtc) }))
    .filter((x): x is { t: StrategyLifecycleTransitionDto; time: number } => x.time !== null);
  for (const { t, time } of transitions) {
    out.push({ stage: 'transition', label: transitionLabel(t), time, detail: transitionDetail(t) });
  }
  const enteredAt = isoMs(input.lifecycleStageEnteredAt);
  if (transitions.length === 0 && input.lifecycleStage && enteredAt !== null) {
    out.push({
      stage: 'current',
      label: `Stage: ${input.lifecycleStage}`,
      time: enteredAt,
      detail: 'entered the current lifecycle stage',
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Divergence markers: the time and kind of each, BarRevised first among equals. */
export function divergenceMarkers(
  divergences: readonly ScriptDivergence[],
): { time: number; kind: string; detail: string }[] {
  return divergences
    .map((d) => ({ time: isoMs(d.timeUtc), kind: d.kind || 'Divergence', detail: d.detail }))
    .filter((d): d is { time: number; kind: string; detail: string } => d.time !== null)
    .sort((a, b) => a.time - b.time);
}

/** Cumulative R (paper and live) against the expectation band, divergences as vertical markers. */
export function buildOverlayOptions(
  series: { origin: SessionOrigin; points: readonly CumulativePoint[] }[],
  markers: readonly { time: number; kind: string; detail: string }[],
  milestones: readonly StageMilestone[],
  palette: ReportPalette,
): EChartsOption | null {
  const withData = series.filter((s) => s.points.length > 0);
  if (withData.length === 0) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 10 };
  const out: unknown[] = [];
  // The band is drawn once, for the series with more trades (paper or live share one backtest expectation).
  const main = [...withData].sort((a, b) => b.points.length - a.points.length)[0];
  const banded = main.points.filter((p) => p.band2 !== null);
  if (banded.length > 0) {
    const bandSeries = (key: 'band1' | 'band2', alpha: number, name: string) => [
      {
        name: `${name} lower`,
        type: 'line',
        stack: key,
        symbol: 'none',
        lineStyle: { opacity: 0 },
        tooltip: { show: false },
        data: banded.map((p) => [p.time, p[key]![0]]),
      },
      {
        name,
        type: 'line',
        stack: key,
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color: withAlpha(palette.deEmphasis, alpha) },
        tooltip: { show: false },
        data: banded.map((p) => [p.time, p[key]![1] - p[key]![0]]),
      },
    ];
    out.push(
      ...bandSeries('band2', 0.12, 'Expected ±2σ'),
      ...bandSeries('band1', 0.18, 'Expected ±1σ'),
    );
    out.push({
      name: 'Expected (backtest mean R × trades)',
      type: 'line',
      symbol: 'none',
      lineStyle: { color: palette.deEmphasis, type: 'dashed', width: 1.4 },
      data: banded.map((p) => [p.time, p.expected]),
    });
  }
  for (const s of withData) {
    const colour = s.origin === 'live' ? palette.accent : palette.position;
    out.push({
      name: s.origin === 'live' ? 'Live trades (cumulative R)' : 'Paper trades (cumulative R)',
      type: 'line',
      step: 'end',
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { color: colour, width: 1.8 },
      itemStyle: { color: colour },
      data: s.points.map((p) => [p.time, p.realised]),
      markLine:
        s === main
          ? {
              silent: true,
              symbol: 'none',
              label: {
                show: true,
                formatter: '{b}',
                fontSize: 9,
                color: palette.textMuted,
                position: 'insideEndTop',
              },
              lineStyle: { color: palette.lossPole, type: 'dotted', width: 1 },
              data: [
                ...markers.map((m) => ({ xAxis: m.time, name: m.kind })),
                ...milestones.map((m) => ({
                  xAxis: m.time,
                  name: m.label,
                  lineStyle: { color: palette.deEmphasis, type: 'solid' as const, width: 1 },
                })),
              ],
            }
          : undefined,
    });
  }
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    legend: { top: 0, textStyle: { color: palette.textMuted, fontSize: 10 } },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) =>
        typeof v === 'number' ? `${formatNumber(v, 2, true)} R` : '',
    },
    xAxis: {
      type: 'time',
      axisLabel,
      axisLine: { lineStyle: { color: palette.gridLine } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'Cumulative R',
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: out,
  } as EChartsOption;
}

export function buildSlippageOptions(
  points: readonly SlippagePoint[],
  palette: ReportPalette,
): EChartsOption | null {
  if (points.length < 2) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 10 };
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 16, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const i = (list[0] as { dataIndex: number } | undefined)?.dataIndex ?? -1;
        const p = points[i];
        return p
          ? `${formatDateTime(p.time)}<br/>median slippage ${formatNumber(p.median, 2)} pips over the last ${p.fills} fills`
          : '';
      },
    },
    xAxis: { type: 'time', axisLabel, splitLine: { show: false } },
    yAxis: {
      type: 'value',
      name: 'slippage (pips)',
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        lineStyle: { color: palette.accent, width: 1.4 },
        data: points.map((p) => [p.time, p.median]),
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: palette.deEmphasis, type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
    ],
  } as EChartsOption;
}
