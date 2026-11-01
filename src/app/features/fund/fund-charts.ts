import type { EChartsOption, LineSeriesOption } from 'echarts';

type MarkPointData = NonNullable<NonNullable<LineSeriesOption['markPoint']>['data']>;

import { dayLabel, money } from './fund.logic';
import type { PerformanceDay } from './fund.types';

const AXIS = '#8E8E93';
const SPLIT = 'rgba(127,127,127,0.14)';
const ACCENT = '#0071e3';
const LOSS = '#ff3b30';

/**
 * The statement chart: cumulative time-weighted return (top) and drawdown from the running peak
 * (bottom) on one date axis, so a fall in the top line lines up with the dip below it. Days with an
 * external cash flow are marked on the return line — those moves are not performance.
 */
export function performanceChart(days: readonly PerformanceDay[], currency: string): EChartsOption {
  const x = days.map((d) => d.dayUtc.slice(0, 10));
  const base = days[0]?.index || 1;
  const ret = days.map((d) => round((d.index / base - 1) * 100));
  const dd = days.map((d) => round(-Math.abs(d.drawdown) * 100));
  const flowPoints = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.flow !== 0)
    .map(({ d, i }) => ({ coord: [x[i], ret[i]], value: d.flow })) as MarkPointData;

  return {
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: AXIS, type: 'dashed' } },
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const i = (list[0] as { dataIndex?: number })?.dataIndex ?? -1;
        const d = days[i];
        if (!d) return '';
        const lines = [
          `<b>${dayLabel(d.dayUtc)}</b>`,
          `Return since start: <b>${sign(ret[i])} %</b>`,
          `Below peak: <b>${dd[i] === 0 ? '0.00' : dd[i].toFixed(2)} %</b>`,
          `Equity: ${money(d.equity, currency)}`,
        ];
        if (d.return !== null) lines.push(`Day: ${sign(round(d.return * 100))} %`);
        if (d.flow !== 0) lines.push(`Cash flow: ${money(d.flow, currency)} (not performance)`);
        return lines.join('<br/>');
      },
    },
    grid: [
      { left: 52, right: 16, top: 14, height: '52%' },
      { left: 52, right: 16, top: '66%', bottom: 26 },
    ],
    xAxis: [
      {
        type: 'category',
        data: x,
        boundaryGap: false,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: SPLIT } },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: x,
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: SPLIT } },
        axisLabel: {
          color: AXIS,
          fontSize: 10,
          hideOverlap: true,
          formatter: (v: string) => dayLabel(v, false),
        },
      },
    ],
    yAxis: [
      {
        type: 'value',
        scale: true,
        splitNumber: 4,
        axisLabel: { color: AXIS, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: SPLIT } },
      },
      {
        type: 'value',
        gridIndex: 1,
        max: 0,
        splitNumber: 2,
        axisLabel: { color: AXIS, fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { color: SPLIT } },
      },
    ],
    series: [
      {
        name: 'Return',
        type: 'line',
        data: ret,
        showSymbol: false,
        lineStyle: { width: 2, color: ACCENT },
        itemStyle: { color: ACCENT },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: AXIS, type: 'dashed', opacity: 0.6 },
          data: [{ yAxis: 0 }],
        },
        markPoint: flowPoints.length
          ? {
              symbol: 'circle',
              symbolSize: 7,
              itemStyle: { color: '#ff9500' },
              label: { show: false },
              data: flowPoints,
            }
          : undefined,
      },
      {
        name: 'Drawdown',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: dd,
        showSymbol: false,
        lineStyle: { width: 1.5, color: LOSS },
        itemStyle: { color: LOSS },
        areaStyle: { color: LOSS, opacity: 0.16 },
      },
    ],
  };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function sign(v: number): string {
  return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}
