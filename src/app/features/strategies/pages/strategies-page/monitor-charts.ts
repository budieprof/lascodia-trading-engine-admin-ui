import type { EChartsOption } from 'echarts';

import type {
  EquityCurveAccountKind,
  EquityCurvePointDto,
  EquityCurveUnit,
} from '@core/api/api.types';

/**
 * Strategy Monitor charts built from the strategy's REAL closed trades
 * (`POST strategy/{id}/equity-curve`: closed positions joined to their opening order's StrategyId,
 * oldest first). Until 2026-11-07 these four charts were `Math.random()` series labelled "sample
 * series" sitting under real KPIs. Each builder returns `null` when there is not enough data, and the
 * page shows an empty state instead — never a synthetic line.
 *
 * By default P&L is realised account-currency P&L summed over every account the strategy traded
 * (live and paper), exactly as the engine's equity-curve query returns it. The monitor can ask for
 * `accountKind` Live / Paper and `unit` R (one point per trade decision at its mean R); the
 * charts label what the engine SAYS it returned (`unit` / `accountKind` on the answer — an older
 * engine ignores the request fields and answers Currency / All).
 */

/** One line naming what the curve covers: "Live accounts · R per trade decision · newest 5,000". */
export function monitorCurveScope(
  unit: EquityCurveUnit,
  accountKind: EquityCurveAccountKind,
  truncated = false,
): string {
  const accounts =
    accountKind === 'Live'
      ? 'live accounts only'
      : accountKind === 'Paper'
        ? 'paper only'
        : 'all accounts, live + paper';
  const what = unit === 'R' ? 'R per trade decision' : 'account currency';
  return `${accounts} · ${what}${truncated ? ' · newest 5,000 (older trades not shown)' : ''}`;
}

/** Y-axis name for a P&L series in `unit`. */
export function pnlAxisName(unit: EquityCurveUnit): string {
  return unit === 'R' ? 'R' : 'P&L';
}

/** Trades in each rolling window for the win-rate and profit-factor charts. */
export const MONITOR_ROLLING_WINDOW = 20;

export interface MonitorTrade {
  closedAt: string;
  pnl: number;
}

export function toMonitorTrades(
  points: readonly EquityCurvePointDto[] | null | undefined,
): MonitorTrade[] {
  return (points ?? [])
    .filter((p) => p && p.closedAt && Number.isFinite(p.realizedPnL))
    .map((p) => ({ closedAt: p.closedAt, pnl: p.realizedPnL }))
    .sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
}

/** Cumulative realised P&L after each closed trade. */
export function cumulativePnl(trades: readonly MonitorTrade[]): [string, number][] {
  let running = 0;
  return trades.map((t) => {
    running += t.pnl;
    return [t.closedAt, round2(running)];
  });
}

/**
 * Rolling win rate in PERCENT over the last `window` trades, one point per trade from the
 * `window`-th on. A trade with P&L > 0 is a win (break-even is not).
 */
export function rollingWinRatePct(
  trades: readonly MonitorTrade[],
  window = MONITOR_ROLLING_WINDOW,
): [string, number][] {
  const out: [string, number][] = [];
  for (let i = window - 1; i < trades.length; i++) {
    let wins = 0;
    for (let j = i - window + 1; j <= i; j++) if (trades[j].pnl > 0) wins++;
    out.push([trades[i].closedAt, round2((wins / window) * 100)]);
  }
  return out;
}

/**
 * Rolling profit factor (gross profit / gross loss) over the last `window` trades. A window with
 * no losing trade has no finite profit factor: its point is `null` (a gap), never a made-up cap.
 */
export function rollingProfitFactor(
  trades: readonly MonitorTrade[],
  window = MONITOR_ROLLING_WINDOW,
): [string, number | null][] {
  const out: [string, number | null][] = [];
  for (let i = window - 1; i < trades.length; i++) {
    let gp = 0;
    let gl = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const p = trades[j].pnl;
      if (p > 0) gp += p;
      else if (p < 0) gl -= p;
    }
    out.push([trades[i].closedAt, gl > 0 ? round2(gp / gl) : null]);
  }
  return out;
}

/** Realised P&L per UTC calendar month ("2026-11"), chronological. */
export function monthlyPnl(trades: readonly MonitorTrade[]): { month: string; pnl: number }[] {
  const byMonth = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.closedAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + t.pnl);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, pnl]) => ({ month, pnl: round2(pnl) }));
}

// ── ECharts options ─────────────────────────────────────────────────────────

const GRID = { left: 60, right: 20, top: 20, bottom: 40 };

export function equityCurveChart(
  trades: readonly MonitorTrade[],
  unit: EquityCurveUnit = 'Currency',
): EChartsOption | null {
  if (trades.length < 2) return null;
  return {
    tooltip: { trigger: 'axis' },
    grid: GRID,
    xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: pnlAxisName(unit), axisLabel: { fontSize: 10 } },
    series: [
      {
        name: unit === 'R' ? 'Cumulative R' : 'Cumulative realised P&L',
        type: 'line',
        data: cumulativePnl(trades),
        showSymbol: trades.length <= 60,
        lineStyle: { color: '#0071E3', width: 2 },
        areaStyle: { color: 'rgba(0, 113, 227, 0.12)' },
      },
    ],
  } as EChartsOption;
}

export function rollingWinRateChart(
  trades: readonly MonitorTrade[],
  window = MONITOR_ROLLING_WINDOW,
): EChartsOption | null {
  const data = rollingWinRatePct(trades, window);
  if (data.length < 2) return null;
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v) => `${Number(v).toFixed(1)}%` },
    grid: GRID,
    xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } },
    series: [
      {
        name: `Win rate (last ${window} trades)`,
        type: 'line',
        data,
        showSymbol: false,
        lineStyle: { color: '#34C759', width: 2 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: 50 }],
          lineStyle: { type: 'dashed', color: '#8E8E93' },
        },
      },
    ],
  } as EChartsOption;
}

export function rollingProfitFactorChart(
  trades: readonly MonitorTrade[],
  window = MONITOR_ROLLING_WINDOW,
): EChartsOption | null {
  const data = rollingProfitFactor(trades, window);
  if (data.filter(([, v]) => v != null).length < 2) return null;
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (v == null ? 'no losing trade in window' : Number(v).toFixed(2)),
    },
    grid: GRID,
    xAxis: { type: 'time', axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', min: 0, axisLabel: { fontSize: 10 } },
    series: [
      {
        name: `Profit factor (last ${window} trades)`,
        type: 'line',
        data,
        connectNulls: false,
        showSymbol: false,
        lineStyle: { color: '#AF52DE', width: 2 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: 1 }],
          lineStyle: { type: 'dashed', color: '#8E8E93' },
        },
      },
    ],
  } as EChartsOption;
}

export function monthlyPnlChart(
  trades: readonly MonitorTrade[],
  unit: EquityCurveUnit = 'Currency',
): EChartsOption | null {
  const months = monthlyPnl(trades);
  if (months.length === 0) return null;
  return {
    tooltip: { trigger: 'axis' },
    grid: GRID,
    xAxis: { type: 'category', data: months.map((m) => m.month), axisLabel: { fontSize: 10 } },
    yAxis: { type: 'value', name: pnlAxisName(unit), axisLabel: { fontSize: 10 } },
    series: [
      {
        name: unit === 'R' ? 'R' : 'Realised P&L',
        type: 'bar',
        data: months.map((m) => ({
          value: m.pnl,
          itemStyle: { color: m.pnl >= 0 ? '#34C759' : '#FF3B30' },
        })),
      },
    ],
  } as EChartsOption;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
