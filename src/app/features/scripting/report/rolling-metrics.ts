import type { EChartsOption } from 'echarts';

import type { ReportPalette } from './report-charts';
import { formatDateTime, formatNumber } from './report-format';
import { priceR } from './r-analysis';
import { closedTrades, type StrategyReport } from './strategy-report.model';

/**
 * U08 — rolling expectancy and rolling Sharpe over the last N closed trades, both in R (each trade's result in units of
 * what it risked at its entry stop). A strategy whose edge decays shows it here long before the whole-run figures move.
 *
 * Pure: the chart component renders what these return. Trades without an R (no stop on the losing side) are left out —
 * never filled with a guess — and the caption says how many were.
 */

/** One closed trade's R at the time it closed (unix ms). */
export interface RPoint {
  time: number;
  r: number;
}

export interface RollingPoint {
  /** Unix ms of the window's last trade. */
  time: number;
  /** 1-based index of the window's last trade among the R trades. */
  trade: number;
  /** Mean R of the window. */
  expectancy: number;
  /** Mean ÷ sample standard deviation of the window (per-trade Sharpe in R); null when R never varies. */
  sharpe: number | null;
}

export const ROLLING_WINDOWS = [10, 20, 30, 50, 100] as const;
export const DEFAULT_ROLLING_WINDOW = 20;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The report's closed trades as R points, in close order: its own `rMultiple`, else the price R against its stop. */
export function rPointsFromReport(report: StrategyReport): { points: RPoint[]; closed: number } {
  const closed = closedTrades(report);
  const points: RPoint[] = [];
  for (const t of closed) {
    const r = finite(t.rMultiple)
      ? t.rMultiple
      : priceR(t.direction, t.entryPrice, t.exitPrice, t.initialStopPrice);
    const time = t.exitTime ?? t.entryTime;
    if (finite(r) && finite(time)) points.push({ time, r });
  }
  points.sort((a, b) => a.time - b.time);
  return { points, closed: closed.length };
}

/**
 * The rolling series: one point per trade from the `window`-th on (a window is always full — a half window is a
 * different statistic). Empty when there are fewer R trades than the window.
 */
export function rollingR(points: readonly RPoint[], window: number): RollingPoint[] {
  const n = Math.max(2, Math.floor(window));
  const out: RollingPoint[] = [];
  if (points.length < n) return out;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < points.length; i++) {
    const r = points[i].r;
    sum += r;
    sumSq += r * r;
    if (i >= n) {
      const old = points[i - n].r;
      sum -= old;
      sumSq -= old * old;
    }
    if (i < n - 1) continue;
    const mean = sum / n;
    // Sample variance; clamp the floating-point residue of the running sums at zero.
    const variance = Math.max(0, (sumSq - n * mean * mean) / (n - 1));
    const sd = Math.sqrt(variance);
    out.push({
      time: points[i].time,
      trade: i + 1,
      expectancy: mean,
      sharpe: sd > 1e-12 ? mean / sd : null,
    });
  }
  return out;
}

/** Two stacked panels on one time axis: rolling expectancy (R) above, rolling per-trade Sharpe below. */
export function buildRollingROptions(
  series: readonly RollingPoint[],
  window: number,
  palette: ReportPalette,
): EChartsOption | null {
  if (series.length < 2) return null;
  const axisLabel = { color: palette.textMuted, fontSize: 10 };
  const xAxis = {
    type: 'time' as const,
    min: 'dataMin' as const,
    max: 'dataMax' as const,
    axisLine: { lineStyle: { color: palette.gridLine } },
    axisLabel,
    splitLine: { show: false },
  };
  const yAxis = {
    type: 'value' as const,
    scale: true,
    axisLabel,
    splitLine: { lineStyle: { color: palette.gridLine } },
  };
  const zero = {
    silent: true,
    symbol: 'none',
    lineStyle: { color: palette.deEmphasis, type: 'dashed' as const, width: 1 },
    label: { show: false },
    data: [{ yAxis: 0 }],
  };
  return {
    animation: false,
    grid: [
      { left: 56, right: 16, top: 28, height: '38%' },
      { left: 56, right: 16, top: '60%', bottom: 28 },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { dataIndex: number } | undefined;
        const p = first ? series[first.dataIndex] : undefined;
        if (!p) return '';
        return (
          `${formatDateTime(p.time)} · trades ${p.trade - window + 1}–${p.trade}<br/>` +
          `Expectancy ${formatNumber(p.expectancy, 3)} R<br/>` +
          `Sharpe in R ${p.sharpe === null ? 'not defined' : formatNumber(p.sharpe, 3)}`
        );
      },
    },
    xAxis: [
      { ...xAxis, gridIndex: 0, axisLabel: { show: false } },
      { ...xAxis, gridIndex: 1 },
    ],
    yAxis: [
      { ...yAxis, gridIndex: 0, name: 'R / trade', nameTextStyle: axisLabel },
      { ...yAxis, gridIndex: 1, name: 'Sharpe (R)', nameTextStyle: axisLabel },
    ],
    series: [
      {
        name: `Expectancy, last ${window} trades`,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        lineStyle: { color: palette.accent, width: 1.6 },
        itemStyle: { color: palette.accent },
        data: series.map((p) => [p.time, p.expectancy]),
        markLine: zero,
      },
      {
        name: `Sharpe in R, last ${window} trades`,
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: palette.position, width: 1.4 },
        itemStyle: { color: palette.position },
        data: series.map((p) => [p.time, p.sharpe]),
        markLine: zero,
      },
    ],
  } as EChartsOption;
}
