import type { EChartsOption } from 'echarts';
import type { CandleDto, MarketAnalysisRecommendationDto } from '@core/api/api.types';

/** Price decimals for a symbol (JPY pairs quote to 3, everything else 5). */
export function priceDecimals(symbol: string): number {
  return symbol.includes('JPY') ? 3 : 5;
}

/**
 * Builds the ECharts option for one recommendation's preview chart — candles +
 * entry/SL/TP horizontal lines + profit/risk zones + (when the engine shrank the
 * TP) the LLM's original TP as a dashed line. Returns null when there's nothing
 * to chart (no candles, a Hold, or no entry). Extracted verbatim from the
 * spot-analysis modal so the modal and the conversations page share one chart.
 */
export function buildRecPreviewChartOption(
  rec: MarketAnalysisRecommendationDto,
  candles: CandleDto[],
  symbol: string,
): EChartsOption | null {
  if (candles.length === 0) return null;
  if (rec.action === 'Hold' || rec.entryPrice == null) return null;

  const categories = candles.map((c) => c.timestamp);
  const lastIdx = candles.length - 1;
  const candleData: [number, number, number, number][] = candles.map((c) => [
    c.open,
    c.close,
    c.low,
    c.high,
  ]);

  const entry = rec.entryPrice;
  const sl = rec.stopLoss;
  const tp = rec.takeProfit;
  const originalTp = rec.originalTakeProfit ?? null;
  const showShrinkage = originalTp !== null && originalTp !== tp;

  const isJpy = symbol.includes('JPY');
  const fmt = (n: number) => n.toFixed(isJpy ? 3 : 5);

  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const allYs = [
    ...lows,
    ...highs,
    entry,
    ...(sl !== null ? [sl] : []),
    ...(tp !== null ? [tp] : []),
    ...(originalTp !== null ? [originalTp] : []),
  ];
  const yMin = Math.min(...allYs);
  const yMax = Math.max(...allYs);
  const yPad = (yMax - yMin) * 0.15 || entry * 0.001;

  const markAreaData: unknown[] = [];
  if (tp !== null) {
    markAreaData.push([
      { yAxis: entry, xAxis: 0, itemStyle: { color: 'rgba(31, 138, 61, 0.10)' } },
      { yAxis: tp, xAxis: lastIdx },
    ]);
  }
  if (sl !== null) {
    markAreaData.push([
      { yAxis: entry, xAxis: 0, itemStyle: { color: 'rgba(196, 41, 10, 0.10)' } },
      { yAxis: sl, xAxis: lastIdx },
    ]);
  }
  if (showShrinkage) {
    markAreaData.push([
      { yAxis: tp ?? originalTp!, xAxis: 0, itemStyle: { color: 'rgba(255, 149, 0, 0.18)' } },
      { yAxis: originalTp!, xAxis: lastIdx },
    ]);
  }

  const label = (text: string, bg: string, fontSize = 10) => ({
    show: true,
    position: 'insideEndTop' as const,
    formatter: text,
    backgroundColor: bg,
    color: '#fff',
    padding: [2, 6] as [number, number],
    borderRadius: 3,
    fontSize,
    fontWeight: 'bold' as const,
  });

  const markLineData: unknown[] = [
    {
      yAxis: entry,
      lineStyle: { color: '#000', width: 1.6, type: 'solid' },
      label: label(`ENTRY ${fmt(entry)}`, '#000'),
    },
  ];
  if (sl !== null)
    markLineData.push({
      yAxis: sl,
      lineStyle: { color: '#c4290a', width: 1.4, type: 'solid' },
      label: label(`SL ${fmt(sl)}`, '#c4290a'),
    });
  if (tp !== null)
    markLineData.push({
      yAxis: tp,
      lineStyle: { color: '#1f8a3d', width: 1.6, type: 'solid' },
      label: label(`TP ${fmt(tp)}`, '#1f8a3d'),
    });
  if (showShrinkage)
    markLineData.push({
      yAxis: originalTp!,
      lineStyle: { color: '#1f8a3d', width: 1.2, type: 'dashed', opacity: 0.75 },
      label: {
        ...label(`LLM TP ${fmt(originalTp!)}`, '#1f8a3d', 9),
        offset: [0, 14] as [number, number],
      },
    });

  return {
    animation: false,
    grid: { left: 56, right: 96, top: 8, bottom: 24 },
    xAxis: {
      type: 'category',
      data: categories,
      boundaryGap: true,
      axisLabel: {
        fontSize: 9,
        color: '#888',
        hideOverlap: true,
        formatter: (v: string) => {
          const d = new Date(v);
          const p = (n: number) => String(n).padStart(2, '0');
          return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        },
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      min: yMin - yPad,
      max: yMax + yPad,
      axisLabel: { fontSize: 9, color: '#888', formatter: (v: number) => fmt(v) },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const candle = arr.find((p: { seriesType?: string }) => p.seriesType === 'candlestick') as
          | { dataIndex: number }
          | undefined;
        if (!candle) return '';
        const c = candles[candle.dataIndex];
        if (!c) return '';
        return `<b>${new Date(c.timestamp).toLocaleString()}</b><br/>
          O ${fmt(c.open)} · H ${fmt(c.high)}<br/>
          L ${fmt(c.low)} · C ${fmt(c.close)}`;
      },
    },
    series: [
      {
        type: 'candlestick',
        data: candleData,
        itemStyle: {
          color: '#1f8a3d',
          color0: '#c4290a',
          borderColor: '#1f8a3d',
          borderColor0: '#c4290a',
        },
        markArea: { silent: true, z: 0, data: markAreaData },
        markLine: { silent: true, symbol: 'none', animation: false, data: markLineData },
      },
    ],
  } as EChartsOption;
}
