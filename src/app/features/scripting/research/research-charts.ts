import type { EChartsOption } from 'echarts';

import { formatDateTime, formatMoney, formatNumber, formatPercent } from '../report/report-format';
import { withAlpha, type ReportPalette } from '../report/report-charts';
import type { WalkForwardEquityPoint } from './research.types';

/**
 * ECharts options for the research views — pure functions of the engine's numbers and a theme palette, so they can be
 * tested without a canvas. Every number drawn is one the engine reported; nothing is estimated here except a
 * least-squares line through points the engine gave.
 */

/** Plain text for tooltips: echarts renders the string as HTML. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

export interface IsOosPoint {
  inSample: number;
  outOfSample: number;
  label: string;
}

/** Least-squares slope and intercept of y on x; null below three points or without spread in x. */
export function leastSquares(
  points: readonly { x: number; y: number }[],
): { slope: number; intercept: number } | null {
  if (points.length < 3) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx <= 1e-12) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * In-sample against out-of-sample: one dot per point, the y = x line (OOS as good as IS) dashed, zero lines, and the
 * least-squares line through the dots. Dots under the diagonal lost edge out of sample; a falling line means the better
 * the in-sample result, the worse out of sample — the overfitting signature. Null without a point.
 */
export function isOosScatterOptions(
  points: readonly IsOosPoint[],
  palette: ReportPalette,
  names: { x: string; y: string },
): EChartsOption | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.inSample);
  const ys = points.map((p) => p.outOfSample);
  const lo = Math.min(0, ...xs, ...ys);
  const hi = Math.max(0, ...xs, ...ys);
  const pad = (hi - lo) * 0.08 || 0.5;
  const min = lo - pad;
  const max = hi + pad;
  const fit = leastSquares(points.map((p) => ({ x: p.inSample, y: p.outOfSample })));
  const series: unknown[] = [
    {
      name: 'Points',
      type: 'scatter',
      symbolSize: 9,
      data: points.map((p) => ({ value: [p.inSample, p.outOfSample], name: p.label })),
      itemStyle: {
        color: withAlpha(palette.accent, 0.75),
        borderColor: palette.surface,
        borderWidth: 1,
      },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: palette.deEmphasis, type: 'dashed', width: 1 },
        data: [[{ coord: [min, min] }, { coord: [max, max] }]] as never,
      },
    },
  ];
  if (fit) {
    series.push({
      name: 'Least-squares line',
      type: 'line',
      showSymbol: false,
      silent: true,
      data: [
        [min, fit.intercept + fit.slope * min],
        [max, fit.intercept + fit.slope * max],
      ],
      lineStyle: { color: fit.slope < 0 ? palette.lossPole : palette.gainPole, width: 2 },
    });
  }
  return {
    animation: false,
    grid: { left: 56, right: 20, top: 16, bottom: 44 },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (p: unknown) => {
        const item = p as {
          seriesName?: string;
          data?: { value?: [number, number]; name?: string };
        };
        if (item.seriesName !== 'Points' || !item.data?.value) return '';
        const [x, y] = item.data.value;
        return (
          `<div style="font-weight:600;margin-bottom:4px">${esc(item.data.name ?? '')}</div>` +
          `<div>${esc(names.x)}: <strong>${esc(formatNumber(x, 3))}</strong></div>` +
          `<div>${esc(names.y)}: <strong>${esc(formatNumber(y, 3))}</strong></div>`
        );
      },
    },
    xAxis: {
      type: 'value',
      min,
      max,
      name: names.x,
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: palette.textMuted, fontSize: 11 },
      axisLabel: { color: palette.textMuted, formatter: (v: number) => formatNumber(v, 2) },
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    yAxis: {
      type: 'value',
      min,
      max,
      name: names.y,
      nameLocation: 'middle',
      nameGap: 40,
      nameTextStyle: { color: palette.textMuted, fontSize: 11 },
      axisLabel: { color: palette.textMuted, formatter: (v: number) => formatNumber(v, 2) },
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: series as EChartsOption['series'],
  };
}

/**
 * The PBO's distribution: how the in-sample winner ranked out of sample on each split, as the logit of its rank
 * (below 0 = at or below the median). The share of splits at or below 0 IS the PBO.
 */
export function logitHistogramOptions(
  logits: readonly number[],
  palette: ReportPalette,
): EChartsOption | null {
  if (logits.length === 0) return null;
  const lo = Math.floor(Math.min(...logits, -1) * 2) / 2;
  const hi = Math.ceil(Math.max(...logits, 1) * 2) / 2;
  const width = 0.5;
  const bins: { from: number; to: number; count: number }[] = [];
  for (let from = lo; from < hi; from += width) bins.push({ from, to: from + width, count: 0 });
  for (const l of logits) {
    const i = Math.min(bins.length - 1, Math.max(0, Math.floor((l - lo) / width)));
    bins[i].count++;
  }
  return {
    animation: false,
    grid: { left: 40, right: 16, top: 12, bottom: 44 },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (p: unknown) => {
        const list = Array.isArray(p) ? p : [p];
        const idx = (list[0] as { dataIndex?: number }).dataIndex ?? -1;
        const b = bins[idx];
        if (!b) return '';
        return `${esc(formatNumber(b.from, 1))} to ${esc(formatNumber(b.to, 1))}: <strong>${b.count}</strong> split${b.count === 1 ? '' : 's'}`;
      },
    },
    xAxis: {
      type: 'category',
      data: bins.map((b) => formatNumber(b.from, 1)),
      name: 'Logit of the out-of-sample rank (below 0 = median or worse)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: palette.textMuted, fontSize: 11 },
      axisLabel: { color: palette.textMuted, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: palette.textMuted },
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: [
      {
        type: 'bar',
        barCategoryGap: '10%',
        data: bins.map((b) => ({
          value: b.count,
          itemStyle: {
            color: b.to <= 0 ? palette.lossPole : palette.gainPole,
            borderRadius: [3, 3, 0, 0],
          },
        })),
      },
    ],
  };
}

/**
 * The walk-forward's stitched out-of-sample equity (or cumulative R) with its drawdown underneath, the folds told apart
 * by alternating shading and a marker at each fold's start. Null with fewer than two points.
 */
export function stitchedEquityOptions(
  points: readonly WalkForwardEquityPoint[],
  palette: ReportPalette,
  mode: 'money' | 'r',
): EChartsOption | null {
  const curve = points.filter((p) => (mode === 'r' ? p.cumulativeR !== null : true));
  if (curve.length < 2) return null;
  const t = (p: WalkForwardEquityPoint) => new Date(p.time).getTime();
  const main = curve.map((p) => [t(p), mode === 'r' ? p.cumulativeR : p.equity]);
  const dd = curve.map((p) => [t(p), p.drawdownPct === 0 ? 0 : -Math.abs(p.drawdownPct)]);

  const foldStarts: { fold: number; time: number }[] = [];
  for (let i = 0; i < curve.length; i++) {
    if (i === 0 || curve[i].fold !== curve[i - 1].fold)
      foldStarts.push({ fold: curve[i].fold, time: t(curve[i]) });
  }
  const areas = foldStarts
    .map((f, i) => ({ f, end: foldStarts[i + 1]?.time ?? t(curve[curve.length - 1]) }))
    .filter((_, i) => i % 2 === 1)
    .map(({ f, end }) => [{ xAxis: f.time }, { xAxis: end }]);

  return {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const idx = (list[0] as { dataIndex?: number } | undefined)?.dataIndex ?? -1;
        const p = curve[idx];
        if (!p) return '';
        return (
          `<div style="font-weight:600;margin-bottom:4px">${esc(formatDateTime(t(p)))} UTC · fold ${p.fold + 1}</div>` +
          `<div>Equity: <strong>${esc(formatMoney(p.equity, ''))}</strong></div>` +
          (p.cumulativeR !== null
            ? `<div>Cumulative R: <strong>${esc(formatNumber(p.cumulativeR, 2))}</strong></div>`
            : '') +
          `<div>Drawdown: <strong>${esc(formatPercent(p.drawdownPct))}</strong></div>`
        );
      },
    },
    grid: [
      { left: 64, right: 20, top: 16, height: 200 },
      { left: 64, right: 20, top: 236, height: 64 },
    ],
    xAxis: [
      {
        type: 'time',
        gridIndex: 0,
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      {
        type: 'time',
        gridIndex: 1,
        axisLabel: { color: palette.textMuted, hideOverlap: true },
        splitLine: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        name: mode === 'r' ? 'R' : undefined,
        nameTextStyle: { color: palette.textMuted, fontSize: 10, align: 'left' },
        axisLabel: { color: palette.textMuted },
        splitLine: { lineStyle: { color: palette.gridLine } },
      },
      {
        type: 'value',
        gridIndex: 1,
        max: 0,
        splitNumber: 2,
        name: 'Drawdown',
        nameTextStyle: { color: palette.textMuted, fontSize: 10, align: 'left' },
        axisLabel: { color: palette.textMuted, formatter: '{value}%' },
        splitLine: { lineStyle: { color: palette.gridLine } },
      },
    ],
    series: [
      {
        name: mode === 'r' ? 'Cumulative R' : 'Equity',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: main,
        showSymbol: false,
        step: 'end',
        lineStyle: { width: 2, color: palette.accent },
        itemStyle: { color: palette.accent },
        markArea: {
          silent: true,
          itemStyle: { color: withAlpha(palette.deEmphasis, 0.08) },
          data: areas as never,
        },
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: palette.deEmphasis, type: 'dotted', width: 1 },
          label: {
            show: true,
            formatter: (p: { name?: string }) => p.name ?? '',
            color: palette.textMuted,
            fontSize: 10,
          },
          data: foldStarts.map((f) => ({ xAxis: f.time, name: `Fold ${f.fold + 1}` })) as never,
        },
      },
      {
        name: 'Drawdown',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: dd,
        showSymbol: false,
        step: 'end',
        lineStyle: { width: 1, color: palette.lossPole },
        areaStyle: { color: withAlpha(palette.lossPole, 0.18) },
      },
    ],
  } as EChartsOption;
}
