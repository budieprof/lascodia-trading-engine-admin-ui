import type { EChartsOption } from 'echarts';

import {
  maxDrawdownWindow,
  maxRunupWindow,
  type ReportEquityPoint,
  type ReportTrade,
  type StrategyReport,
} from './strategy-report.model';
import { formatDateTime, formatMoney, formatPercent, formatQty } from './report-format';

/**
 * ECharts options for the Strategy report — pure functions of the report and a theme palette so
 * they can be unit-tested without a canvas.
 *
 * Colour follows the job (see the dataviz method): the strategy's equity is the emphasised series
 * (accent) and buy & hold is context (de-emphasis gray); polarity (gain vs loss) uses a blue ↔ red
 * diverging pair, validated for colour-vision deficiency — green ↔ red fails deuteranopia
 * (ΔE 5.0) — and every gain/loss value also carries its sign as text. Different units never
 * share an axis: equity, drawdown and position are stacked panels on one time axis.
 */

export interface ReportPalette {
  accent: string;
  deEmphasis: string;
  gainPole: string;
  lossPole: string;
  position: string;
  gridLine: string;
  /** The card surface the heatmap cells sit on (`--bg-secondary`), for text-contrast picks. */
  surface: string;
  /** Primary text colours for light and dark fills. */
  inkOnLight: string;
  inkOnDark: string;
}

export function reportPalette(theme: 'light' | 'dark'): ReportPalette {
  return theme === 'dark'
    ? {
        accent: '#0A84FF',
        deEmphasis: '#8E8E93',
        gainPole: '#0A84FF',
        lossPole: '#FF453A',
        position: '#AEAEB2',
        gridLine: 'rgba(255,255,255,0.08)',
        surface: '#1C1C1E',
        inkOnLight: '#1D1D1F',
        inkOnDark: '#F5F5F7',
      }
    : {
        accent: '#0071E3',
        deEmphasis: '#8E8E93',
        gainPole: '#0071E3',
        lossPole: '#D70015',
        position: '#636366',
        gridLine: 'rgba(0,0,0,0.06)',
        surface: '#F5F5F7',
        inkOnLight: '#1D1D1F',
        inkOnDark: '#FFFFFF',
      };
}

function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `#RRGGBB` at an opacity, for washes under lines and shaded windows. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = rgbOf(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

/** Drawdown of a curve point as a negative percentage of the peak it fell from. */
export function underwaterPercent(p: ReportEquityPoint): number | null {
  if (p.drawdownPercent !== null) return p.drawdownPercent === 0 ? 0 : -Math.abs(p.drawdownPercent);
  if (p.drawdown === null || p.equity === null) return null;
  const peak = p.equity + p.drawdown;
  return peak > 0 ? -(Math.abs(p.drawdown) / peak) * 100 : null;
}

/** Plain text for tooltips: echarts renders the string as HTML. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const LARGE_SERIES = 2000;

/**
 * Equity (with buy & hold), underwater drawdown and position size as three stacked panels that
 * share one time axis, one crosshair and one tooltip. The largest close-to-close drawdown is
 * shaded on the equity panel and the largest run-up's peak is pinned. Null when the curve has
 * fewer than two points — the caller shows an empty state instead of a bare axis.
 */
export function buildEquityChartOptions(
  report: StrategyReport,
  palette: ReportPalette,
  currency: string,
): EChartsOption | null {
  const curve = report.equityCurve.filter((p) => p.time !== null && p.equity !== null);
  if (curve.length < 2) return null;

  const large = curve.length > LARGE_SERIES;
  const hasBuyHold = curve.some((p) => p.buyHoldEquity !== null);
  const equity = curve.map((p) => [p.time!, p.equity!]);
  const buyHold = curve.map((p) => [p.time!, p.buyHoldEquity]);
  const underwater = curve.map((p) => [p.time!, underwaterPercent(p)]);
  const position = curve.map((p) => [p.time!, p.positionSize ?? 0]);

  const dd = maxDrawdownWindow(curve);
  const ru = maxRunupWindow(curve);

  const markArea =
    dd && dd.fromIndex >= 0
      ? {
          silent: true,
          itemStyle: { color: withAlpha(palette.lossPole, 0.08) },
          label: { show: true, position: 'insideTop' as const, fontSize: 10 },
          data: [
            [
              { xAxis: curve[dd.fromIndex].time!, name: 'Max drawdown' },
              { xAxis: curve[dd.toIndex].time! },
            ],
          ] as any,
        }
      : undefined;

  const markPoint =
    ru && ru.toIndex >= 0
      ? {
          symbol: 'circle',
          symbolSize: 8,
          // 2px ring in the surface colour keeps the pin legible where it sits on the line.
          itemStyle: {
            color: palette.accent,
            borderColor: palette.surface,
            borderWidth: 2,
          },
          label: {
            show: true,
            position: 'top' as const,
            fontSize: 10,
            formatter: `Max run-up ${formatMoney(ru.amount, '', { signed: true, decimals: 0 })}`,
          },
          data: [{ coord: [curve[ru.toIndex].time!, curve[ru.toIndex].equity!] }] as any,
        }
      : undefined;

  const xAxisBase = {
    type: 'time' as const,
    min: 'dataMin' as const,
    max: 'dataMax' as const,
    axisLine: { lineStyle: { color: palette.gridLine } },
    splitLine: { show: false },
  };
  const yAxisBase = {
    splitLine: { lineStyle: { color: palette.gridLine, type: 'solid' as const } },
    nameTextStyle: { fontSize: 10, align: 'left' as const },
  };

  return {
    animation: !large,
    legend: {
      top: 0,
      left: 0,
      itemWidth: 16,
      itemHeight: 2,
      data: hasBuyHold ? ['Equity', 'Buy & hold'] : ['Equity'],
      show: hasBuyHold,
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      confine: true,
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const idx = (list[0] as { dataIndex?: number } | undefined)?.dataIndex ?? -1;
        const p = curve[idx];
        if (!p) return '';
        const rows: [string, string][] = [
          ['Equity', formatMoney(p.equity, currency)],
          [
            'Intrabar low / high',
            `${formatMoney(p.minEquity, '')} / ${formatMoney(p.maxEquity, '')}`,
          ],
        ];
        if (hasBuyHold) rows.push(['Buy & hold', formatMoney(p.buyHoldEquity, currency)]);
        rows.push([
          'Drawdown',
          `${formatMoney(p.drawdown, currency)} (${formatPercent(underwaterPercent(p))})`,
        ]);
        rows.push(['Position', formatQty(p.positionSize)]);
        return (
          `<div style="font-weight:600;margin-bottom:4px">${esc(formatDateTime(p.time))} UTC</div>` +
          rows
            .map(
              ([k, v]) =>
                `<div style="display:flex;justify-content:space-between;gap:16px">` +
                `<span style="opacity:.75">${esc(k)}</span><strong>${esc(v)}</strong></div>`,
            )
            .join('')
        );
      },
    },
    grid: [
      { left: 64, right: 24, top: 36, height: 220 },
      { left: 64, right: 24, top: 290, height: 80 },
      { left: 64, right: 24, top: 400, height: 56 },
    ],
    xAxis: [
      { ...xAxisBase, gridIndex: 0, axisLabel: { show: false }, axisTick: { show: false } },
      { ...xAxisBase, gridIndex: 1, axisLabel: { show: false }, axisTick: { show: false } },
      { ...xAxisBase, gridIndex: 2, axisLabel: { hideOverlap: true } },
    ],
    yAxis: [
      {
        ...yAxisBase,
        gridIndex: 0,
        type: 'value',
        scale: true,
        name: `Equity${currency ? ` (${currency})` : ''}`,
      },
      {
        ...yAxisBase,
        gridIndex: 1,
        type: 'value',
        max: 0,
        name: 'Drawdown',
        axisLabel: { formatter: '{value}%' },
      },
      { ...yAxisBase, gridIndex: 2, type: 'value', name: 'Position', splitNumber: 2 },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2] },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 4, height: 18, showDetail: false },
    ],
    series: [
      {
        name: 'Equity',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: equity,
        showSymbol: false,
        sampling: large ? 'lttb' : undefined,
        lineStyle: { width: 2, color: palette.accent, cap: 'round', join: 'round' },
        itemStyle: { color: palette.accent },
        areaStyle: { color: withAlpha(palette.accent, 0.1), origin: 'start' },
        markArea,
        markPoint,
        z: 3,
      },
      ...(hasBuyHold
        ? [
            {
              name: 'Buy & hold',
              type: 'line' as const,
              xAxisIndex: 0,
              yAxisIndex: 0,
              data: buyHold,
              showSymbol: false,
              connectNulls: false,
              sampling: large ? ('lttb' as const) : undefined,
              lineStyle: { width: 2, color: palette.deEmphasis },
              itemStyle: { color: palette.deEmphasis },
              z: 2,
            },
          ]
        : []),
      {
        name: 'Drawdown',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: underwater,
        showSymbol: false,
        sampling: large ? 'lttb' : undefined,
        lineStyle: { width: 1.5, color: palette.lossPole },
        itemStyle: { color: palette.lossPole },
        areaStyle: { color: withAlpha(palette.lossPole, 0.12) },
      },
      {
        name: 'Position',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: position,
        step: 'end',
        showSymbol: false,
        lineStyle: { width: 1.5, color: palette.position },
        itemStyle: { color: palette.position },
        areaStyle: { color: withAlpha(palette.position, 0.1) },
      },
    ],
  } as EChartsOption;
}

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/**
 * Even-width bins over the closed trades' profit. A bin straddling zero is split at zero so no
 * bar mixes winners and losers. Bin count follows Sturges' rule, clamped to 6–24.
 */
export function profitHistogram(trades: readonly ReportTrade[]): HistogramBin[] {
  const values = trades
    .filter((t) => !t.isOpen && t.profit !== null)
    .map((t) => t.profit as number);
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ from: min, to: max, count: values.length }];

  const binCount = Math.min(24, Math.max(6, Math.ceil(Math.log2(values.length) + 1)));
  const width = (max - min) / binCount;
  const edges: number[] = [];
  for (let i = 0; i <= binCount; i++) edges.push(min + i * width);
  edges[edges.length - 1] = max;
  if (min < 0 && max > 0 && !edges.some((e) => Math.abs(e) < 1e-12)) {
    edges.push(0);
    edges.sort((a, b) => a - b);
  }

  const bins: HistogramBin[] = [];
  for (let i = 0; i < edges.length - 1; i++)
    bins.push({ from: edges[i], to: edges[i + 1], count: 0 });
  for (const v of values) {
    let idx = bins.findIndex((b, i) =>
      i === bins.length - 1 ? v >= b.from && v <= b.to : v >= b.from && v < b.to,
    );
    if (idx < 0) idx = v < bins[0].from ? 0 : bins.length - 1;
    bins[idx].count++;
  }
  return bins;
}

/**
 * Distribution of closed-trade profit: one bar per bin, losing bins in the loss pole and winning
 * bins in the gain pole. Null below three closed trades — a distribution of two is not one.
 */
export function buildProfitDistributionOptions(
  report: StrategyReport,
  palette: ReportPalette,
  currency: string,
): EChartsOption | null {
  const closed = report.trades.filter((t) => !t.isOpen && t.profit !== null);
  if (closed.length < 3) return null;
  const bins = profitHistogram(closed);
  const label = (b: HistogramBin) =>
    `${formatMoney(b.from, '', { decimals: 0 })} … ${formatMoney(b.to, '', { decimals: 0 })}`;

  return {
    grid: { left: 48, right: 16, top: 16, bottom: 56 },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: (p: unknown) => {
        const b = bins[(p as { dataIndex: number }).dataIndex];
        if (!b) return '';
        return (
          `<div style="font-weight:600">${b.count} trade${b.count === 1 ? '' : 's'}</div>` +
          `<div style="opacity:.75">Profit ${esc(label(b))}${currency ? ` ${esc(currency)}` : ''}</div>`
        );
      },
    },
    xAxis: {
      type: 'category',
      data: bins.map(label),
      name: `Profit per trade${currency ? ` (${currency})` : ''}`,
      nameLocation: 'middle',
      nameGap: 36,
      axisLabel: { hideOverlap: true, fontSize: 10 },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      name: 'Trades',
      splitLine: { lineStyle: { color: palette.gridLine } },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 24,
        barCategoryGap: '12%',
        data: bins.map((b) => ({
          value: b.count,
          itemStyle: {
            color: b.to <= 0 && b.from < 0 ? palette.lossPole : palette.gainPole,
            borderRadius: [4, 4, 0, 0],
          },
        })),
      },
    ],
  } as EChartsOption;
}

/**
 * Diverging cell colour for a monthly return: loss pole ↔ neutral ↔ gain pole, saturating at
 * `scale` percent. Returns the background and whichever ink (light or dark) has the higher
 * contrast against the fill as it actually renders over the card surface.
 */
export function heatCellColors(
  returnPercent: number | null,
  scale: number,
  palette: ReportPalette,
): { background: string; color: string } | null {
  if (returnPercent === null || !Number.isFinite(returnPercent)) return null;
  if (returnPercent === 0 || scale <= 0) return { background: 'transparent', color: 'inherit' };
  const t = Math.min(1, Math.abs(returnPercent) / scale);
  // 0.12 → 0.85 opacity: a whisper for small months, a solid fill for the extremes.
  const alpha = Number((0.12 + t * 0.73).toFixed(3));
  const hex = returnPercent > 0 ? palette.gainPole : palette.lossPole;
  const fill = rgbOf(hex);
  const surface = rgbOf(palette.surface);
  const light = rgbOf(palette.inkOnDark);
  const dark = rgbOf(palette.inkOnLight);
  let color = 'inherit';
  if (fill && surface && light && dark) {
    const composite: [number, number, number] = [0, 1, 2].map((i) =>
      Math.round(alpha * fill[i] + (1 - alpha) * surface[i]),
    ) as [number, number, number];
    color =
      contrastRatio(composite, light) >= contrastRatio(composite, dark)
        ? palette.inkOnDark
        : palette.inkOnLight;
  }
  return { background: withAlpha(hex, alpha), color };
}
