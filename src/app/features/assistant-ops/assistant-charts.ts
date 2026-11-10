/**
 * ECharts options for the Evals and Quality trends. Colours are a validated categorical set
 * (dataviz `validate_palette.js`: light and dark each pass lightness, chroma, CVD and normal-vision
 * separation; contrast relief = legend + tooltip + the table beside each chart; end labels collided
 * where the lines run close). Fixed order,
 * never cycled; text stays in the theme's ink colours, not the series colour.
 */
import type { EChartsOption } from 'echarts';

import type { AssistantQualityPoint } from './assistant-ops.types';
import { RUBRIC, type TrendPoint } from './assistant-quality.logic';

const LIGHT = ['#0071E3', '#E8710A', '#1F9D6B', '#B0359A'];
const DARK = ['#3D8EF0', '#D9680A', '#23A673', '#C24FAC'];

export function seriesColors(dark: boolean): string[] {
  return dark ? DARK : LIGHT;
}

function ink(dark: boolean): { text: string; muted: string; grid: string } {
  return dark
    ? { text: '#F5F5F7', muted: '#A1A1A6', grid: 'rgba(255,255,255,0.08)' }
    : { text: '#1D1D1F', muted: '#6E6E73', grid: 'rgba(0,0,0,0.06)' };
}

function line(name: string, color: string, data: [string, number | null][], dark: boolean) {
  return {
    name,
    type: 'line' as const,
    data,
    connectNulls: true,
    showSymbol: true,
    symbol: 'circle',
    symbolSize: 8,
    lineStyle: { width: 2, color },
    itemStyle: { color, borderColor: dark ? '#1C1C1E' : '#FFFFFF', borderWidth: 2 },
    emphasis: { focus: 'series' as const },
  };
}

/** Nightly suite: share of test cases passed and the mean check score, both as percentages. */
export function evalTrendOptions(points: readonly TrendPoint[], dark: boolean): EChartsOption {
  const [c1, c2] = seriesColors(dark);
  const k = ink(dark);
  const pctOf = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 10);
  return {
    animation: false,
    grid: { left: 44, right: 24, top: 36, bottom: 28 },
    legend: { top: 0, left: 0, textStyle: { color: k.muted }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      valueFormatter: (v) => (v == null ? '—' : `${v}%`),
    },
    xAxis: {
      type: 'time',
      axisLabel: { color: k.muted, formatter: '{MMM} {d}', hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: k.muted, formatter: '{value}%' },
      splitLine: { lineStyle: { color: k.grid } },
    },
    series: [
      line(
        'Cases passed',
        c1,
        points.map((p) => [p.at, pctOf(p.passRate)]),
        dark,
      ),
      line(
        'Mean score',
        c2,
        points.map((p) => [p.at, pctOf(p.meanScore)]),
        dark,
      ),
    ],
  };
}

/** Answer spot checks: the four rubric scores (1-5) per judging pass. */
export function qualityTrendOptions(
  points: readonly AssistantQualityPoint[],
  dark: boolean,
): EChartsOption {
  const colors = seriesColors(dark);
  const k = ink(dark);
  return {
    animation: false,
    grid: { left: 36, right: 24, top: 36, bottom: 28 },
    legend: { top: 0, left: 0, textStyle: { color: k.muted }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      valueFormatter: (v) => (v == null ? '—' : `${v} / 5`),
    },
    xAxis: {
      type: 'time',
      axisLabel: { color: k.muted, formatter: '{MMM} {d}', hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 1,
      max: 5,
      interval: 1,
      axisLabel: { color: k.muted },
      splitLine: { lineStyle: { color: k.grid } },
    },
    series: RUBRIC.map((r, i) =>
      line(
        r.label,
        colors[i],
        points.map((p) => [p.gradedAtUtc, p[r.key]]),
        dark,
      ),
    ),
  };
}
