import type { EChartsOption } from 'echarts';

import type { ReportPalette } from '../report/report-charts';
import { withAlpha } from '../report/report-charts';
import { formatNumber } from '../report/report-format';
import type { MonteCarloEquityCone } from './research.types';

/**
 * U07 — the Monte Carlo cone: the engine's percentile bands of the resampled equity paths, trade by trade. Only the
 * ENGINE's numbers are drawn (`GET backtest|walk-forward/{id}/monte-carlo` → `result.equityCone`); a cone that is
 * missing or malformed is not drawn at all — never approximated in the browser.
 */

const finiteArray = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** The cone when every required array is present, finite and as long as `trades`; else null. */
export function validCone(raw: unknown): MonteCarloEquityCone | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const trades = c['trades'];
  if (!Array.isArray(trades) || trades.length < 2) return null;
  const n = trades.length;
  if (!finiteArray(trades, n)) return null;
  for (const key of ['p5', 'p50', 'p95']) if (!finiteArray(c[key], n)) return null;
  const optional = (key: string) => (finiteArray(c[key], n) ? (c[key] as number[]) : null);
  return {
    trades: trades as number[],
    p5: c['p5'] as number[],
    p25: optional('p25'),
    p50: c['p50'] as number[],
    p75: optional('p75'),
    p95: c['p95'] as number[],
    observed: optional('observed'),
  };
}

/** Bands as stacked areas (lower edge + width), the median and the run's own path as lines. */
export function buildConeOptions(
  cone: MonteCarloEquityCone,
  palette: ReportPalette,
): EChartsOption {
  const x = cone.trades;
  const band = (lo: number[], hi: number[], key: string, alpha: number, name: string) => [
    {
      name: `${name} (lower)`,
      type: 'line',
      stack: key,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      tooltip: { show: false },
      data: x.map((t, i) => [t, lo[i]]),
    },
    {
      name,
      type: 'line',
      stack: key,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      areaStyle: { color: withAlpha(palette.accent, alpha) },
      tooltip: { show: false },
      data: x.map((t, i) => [t, hi[i] - lo[i]]),
    },
  ];
  const series: unknown[] = [...band(cone.p5, cone.p95, 'outer', 0.12, '5th–95th percentile')];
  if (cone.p25 && cone.p75)
    series.push(...band(cone.p25, cone.p75, 'inner', 0.22, '25th–75th percentile'));
  series.push({
    name: 'Median path',
    type: 'line',
    symbol: 'none',
    lineStyle: { color: palette.accent, width: 1.6 },
    itemStyle: { color: palette.accent },
    data: x.map((t, i) => [t, cone.p50[i]]),
  });
  if (cone.observed) {
    series.push({
      name: 'This run’s order',
      type: 'line',
      symbol: 'none',
      lineStyle: { color: palette.text, width: 1.2, type: 'dashed' },
      itemStyle: { color: palette.text },
      data: x.map((t, i) => [t, cone.observed![i]]),
    });
  }
  const axisLabel = { color: palette.textMuted, fontSize: 10 };
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 36, bottom: 36 },
    legend: {
      top: 0,
      textStyle: { color: palette.textMuted, fontSize: 10 },
      data: ['5th–95th percentile', '25th–75th percentile', 'Median path', 'This run’s order'],
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const i = (list[0] as { dataIndex: number } | undefined)?.dataIndex ?? -1;
        if (i < 0 || i >= x.length) return '';
        const pct = (v: number | undefined) =>
          v === undefined ? '—' : `${formatNumber(v, 1, true)} %`;
        return (
          `After ${x[i]} trades<br/>P95 ${pct(cone.p95[i])}` +
          (cone.p75 ? `<br/>P75 ${pct(cone.p75[i])}` : '') +
          `<br/>Median ${pct(cone.p50[i])}` +
          (cone.p25 ? `<br/>P25 ${pct(cone.p25[i])}` : '') +
          `<br/>P5 ${pct(cone.p5[i])}` +
          (cone.observed ? `<br/>This run ${pct(cone.observed[i])}` : '')
        );
      },
    },
    xAxis: {
      type: 'value',
      name: 'trades',
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: axisLabel,
      min: 'dataMin',
      max: 'dataMax',
      axisLabel,
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'equity change %',
      nameTextStyle: axisLabel,
      axisLabel,
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series,
  } as EChartsOption;
}
