import type { EChartsOption } from 'echarts';

import {
  alpha,
  categoricalAt,
  roleColor,
  signColor,
  vizPalette,
  type VizColorRole,
  type VizMode,
} from './viz-palette';

/**
 * The chat `chart` tool's wire contract, and the pure translation of it into an ECharts option.
 *
 * <p>The engine validates and normalises whatever the analyst wrote before it reaches here (see
 * ChatVisualBuilder), so this module's job is presentation only: it never re-checks lengths or
 * ranges, and it never silently drops a series. Kept free of Angular so the whole grammar can be
 * exercised in a plain unit test — a chart that renders the wrong shape is not something a
 * screenshot review reliably catches.</p>
 */

export type VisualChartType =
  | 'line'
  | 'bar'
  | 'stackedbar'
  | 'histogram'
  | 'scatter'
  | 'heatmap'
  | 'waterfall'
  | 'timeline'
  | 'tree';

export interface VisualSeries {
  name: string;
  data: (number | null)[];
  color?: VizColorRole;
  /** Different SCALE, not a different axis — see `buildLine`. */
  axis?: 'right';
  dashed?: boolean;
  area?: boolean;
  /** Draw over the bars as diamonds instead of as bars of its own. */
  render?: 'marker';
}

export interface VisualMarkLine {
  y?: number;
  x?: string;
  label?: string;
  color?: VizColorRole;
  axis?: 'right';
}

export interface VisualBand {
  from: number;
  to: number;
  label?: string;
  color?: VizColorRole;
  axis?: 'right';
}

export interface VisualTreeNode {
  label: string;
  edgeLabel?: string;
  detail?: string;
  kind?: 'bull' | 'bear' | 'neutral' | 'invalid';
  children?: VisualTreeNode[];
}

export interface VisualTimelineEvent {
  at: string;
  label: string;
  impact?: 'high' | 'medium' | 'low';
  note?: string;
}

export interface VisualTimelineWindow {
  from: string;
  to: string;
  label: string;
  kind?: 'quiet' | 'risk' | 'session' | 'neutral';
}

export interface VisualSpec {
  kind: 'chart';
  type: VisualChartType;
  title: string;
  subtitle?: string;
  caption?: string;
  estimated?: boolean;
  estimatedNote?: string;

  x?: string[];
  categories?: string[];
  series?: VisualSeries[];
  yLabel?: string;
  yRightLabel?: string;
  xLabel?: string;
  horizontal?: boolean;
  diverging?: boolean;
  percent?: boolean;

  bins?: { from: number; to: number; count: number }[];
  count?: number;
  mean?: number;

  points?: { x: number; y: number; label?: string; size?: number; group?: string }[];
  quadrantX?: number;
  quadrantY?: number;
  diagonal?: boolean;

  xCategories?: string[];
  yCategories?: string[];
  cells?: { x: number; y: number; value: number }[];
  valueLabel?: string;
  midpoint?: number;

  steps?: { label: string; value: number; note?: string }[];
  showTotal?: boolean;

  events?: VisualTimelineEvent[];
  windows?: VisualTimelineWindow[];
  from?: string;
  to?: string;

  root?: VisualTreeNode;

  markLines?: VisualMarkLine[];
  bands?: VisualBand[];
}

/** Parse a persisted tool result into a spec, or null when the turn is not one of ours. */
export function parseVisualSpec(json: string | null | undefined): VisualSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as VisualSpec;
    return parsed && parsed.kind === 'chart' && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The timeline is laid out as an HTML strip by the component rather than as an ECharts option — a
 * calendar runway is a band with shaded windows and labelled ticks, which no cartesian series
 * expresses without fighting it.
 */
export const RENDERED_AS_HTML: VisualChartType[] = ['timeline'];

export function toEchartsOption(spec: VisualSpec, mode: VizMode): EChartsOption | null {
  switch (spec.type) {
    case 'line':
      return buildLine(spec, mode);
    case 'bar':
      return buildBar(spec, mode, false);
    case 'stackedbar':
      return buildBar(spec, mode, true);
    case 'histogram':
      return buildHistogram(spec, mode);
    case 'scatter':
      return buildScatter(spec, mode);
    case 'heatmap':
      return buildHeatmap(spec, mode);
    case 'waterfall':
      return buildWaterfall(spec, mode);
    case 'tree':
      return buildTree(spec, mode);
    default:
      return null;
  }
}

// ── line ──────────────────────────────────────────────────────────────────────

/**
 * A line chart, with one deliberate departure from what the tool contract literally says.
 *
 * <p>`axis: "right"` is the analyst's way of saying "this series is on a different scale" — pressure
 * pinned near 1.0 against a live-share percentage swinging 83 → 7. Drawing that as a second y-axis
 * on the same plot is the classic dual-axis lie: the two lines cross wherever the two scales happen
 * to be zeroed, and the reader takes the crossing for an event. So a different scale gets its own
 * STACKED PANEL sharing the x-axis and a linked crosshair. The divergence the analyst wanted to show
 * is still read off one time axis, and none of it is an artifact of scaling.</p>
 */
function buildLine(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const x = spec.x ?? [];
  const all = spec.series ?? [];
  const left = all.filter((s) => s.axis !== 'right');
  const right = all.filter((s) => s.axis === 'right');
  const split = left.length > 0 && right.length > 0;

  const topHeight = split ? '46%' : undefined;
  const grids = split
    ? [
        { left: 64, right: 24, top: 28, height: topHeight },
        { left: 64, right: 24, top: '62%', bottom: 56 },
      ]
    : [{ left: 64, right: 24, top: 28, bottom: 56 }];

  const axisLabel = { color: p.textMuted, fontSize: 10, hideOverlap: true };
  const xAxes = grids.map((_, i) => ({
    type: 'category' as const,
    gridIndex: i,
    data: x,
    boundaryGap: false,
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    // Only the bottom panel carries the time labels; repeating them between two stacked panels
    // spends vertical room on information the reader already has.
    axisLabel: i === grids.length - 1 ? axisLabel : { show: false },
    splitLine: { show: false },
  }));
  const yAxes = grids.map((_, i) => ({
    type: 'value' as const,
    gridIndex: i,
    scale: true,
    name: i === 0 ? spec.yLabel : spec.yRightLabel,
    nameTextStyle: { color: p.textMuted, fontSize: 10 },
    axisLabel,
    axisLine: { show: false },
    splitLine: { lineStyle: { color: p.grid } },
  }));

  const series = [
    ...left.map((s, i) => lineSeries(s, i, 0, mode)),
    ...right.map((s, i) => lineSeries(s, left.length + i, split ? 1 : 0, mode)),
  ];

  return {
    ...base(spec, mode, all.length),
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    axisPointer: split ? { link: [{ xAxisIndex: 'all' }] } : undefined,
    tooltip: { ...tooltip(p), trigger: 'axis', axisPointer: { type: 'cross' } },
    series: withAnnotations(series, spec, mode, split),
  } as EChartsOption;
}

function lineSeries(s: VisualSeries, colorIndex: number, gridIndex: number, mode: VizMode) {
  const color = roleColor(mode, s.color, categoricalAt(mode, colorIndex));
  return {
    name: s.name,
    type: 'line' as const,
    xAxisIndex: gridIndex,
    yAxisIndex: gridIndex,
    data: s.data,
    // A genuine gap stays a gap. Bridging it draws a trend through hours nobody measured.
    connectNulls: false,
    showSymbol: false,
    symbolSize: 8,
    smooth: false,
    lineStyle: { color, width: 2, type: s.dashed ? ('dashed' as const) : ('solid' as const) },
    itemStyle: { color },
    areaStyle: s.area ? { color: alpha(color, 0.14) } : undefined,
    z: 5,
  };
}

// ── bar / stackedBar ──────────────────────────────────────────────────────────

function buildBar(spec: VisualSpec, mode: VizMode, stacked: boolean): EChartsOption {
  const p = vizPalette(mode);
  const cats = spec.categories ?? [];
  const all = spec.series ?? [];
  const horizontal = spec.horizontal === true;

  const series = all.map((s, i) => {
    const fallback = categoricalAt(mode, i);
    const color = roleColor(mode, s.color, fallback);

    // A marker series rides over the bars instead of beside them: the level and its change on one
    // axis, where a second bar group would read as a second measurement of the same thing.
    if (!stacked && s.render === 'marker') {
      return {
        name: s.name,
        type: 'scatter' as const,
        data: s.data,
        symbol: 'diamond',
        symbolSize: 10,
        itemStyle: { color, borderColor: p.surface, borderWidth: 2 },
        z: 10,
      };
    }

    return {
      name: s.name,
      type: 'bar' as const,
      stack: stacked ? 'total' : undefined,
      data: s.data.map((v) =>
        // Sign-coding is per POINT, so a diverging series cannot be expressed as one series colour.
        spec.diverging && typeof v === 'number'
          ? { value: v, itemStyle: { color: signColor(mode, v) } }
          : v,
      ),
      itemStyle: {
        color: spec.diverging ? undefined : color,
        // Rounded data-end anchored to the baseline; a stacked segment stays square so the stack
        // reads as one column.
        borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
        // 2px of surface between adjacent stacked segments, so the boundary is a gap and not a
        // colour change the reader has to trust.
        borderColor: stacked ? p.surface : undefined,
        borderWidth: stacked ? 2 : 0,
      },
      barMaxWidth: 34,
      z: 5,
    };
  });

  const valueAxis = {
    type: 'value' as const,
    scale: !stacked,
    name: spec.yLabel,
    nameTextStyle: { color: p.textMuted, fontSize: 10 },
    max: stacked && spec.percent ? 100 : undefined,
    axisLabel: {
      color: p.textMuted,
      fontSize: 10,
      formatter: stacked && spec.percent ? '{value}%' : undefined,
    },
    axisLine: { show: false },
    splitLine: { lineStyle: { color: p.grid } },
  };
  const catAxis = {
    type: 'category' as const,
    data: cats,
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    axisLabel: { color: p.textMuted, fontSize: 10, hideOverlap: true },
  };

  return {
    ...base(spec, mode, all.length),
    grid: { left: horizontal ? 96 : 64, right: 24, top: 28, bottom: 56 },
    xAxis: horizontal ? valueAxis : catAxis,
    yAxis: horizontal ? catAxis : valueAxis,
    tooltip: { ...tooltip(p), trigger: 'axis', axisPointer: { type: 'shadow' } },
    series: withAnnotations(series, spec, mode, false),
  } as EChartsOption;
}

// ── histogram ─────────────────────────────────────────────────────────────────

function buildHistogram(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const bins = spec.bins ?? [];
  const dp = binPrecision(bins);
  const labels = bins.map((b) => b.from.toFixed(dp));

  return {
    ...base(spec, mode, 1),
    grid: { left: 64, right: 24, top: 28, bottom: 56 },
    xAxis: {
      type: 'category',
      data: labels,
      name: spec.xLabel,
      nameLocation: 'middle',
      nameGap: 32,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: { color: p.textMuted, fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      name: spec.yLabel ?? 'count',
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      axisLabel: { color: p.textMuted, fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
    },
    tooltip: {
      ...tooltip(p),
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const i = (arr[0] as { dataIndex: number }).dataIndex;
        const b = bins[i];
        return b ? `${b.from.toFixed(dp)} … ${b.to.toFixed(dp)}<br/><b>${b.count}</b>` : '';
      },
    },
    series: withAnnotations(
      [
        {
          name: spec.yLabel ?? 'count',
          type: 'bar' as const,
          data: bins.map((b) => b.count),
          // A distribution is one measurement, so the bars carry no identity: a single neutral
          // fill, with the shape doing the talking.
          itemStyle: { color: vizPalette(mode).semantic.accent, borderRadius: [3, 3, 0, 0] },
          barCategoryGap: '8%',
          z: 5,
        },
      ],
      spec,
      mode,
      false,
    ),
  } as EChartsOption;
}

/** Decimal places that keep adjacent bin edges distinguishable. */
function binPrecision(bins: { from: number; to: number }[]): number {
  if (bins.length === 0) return 2;
  const width = Math.abs(bins[0].to - bins[0].from);
  if (width >= 10) return 0;
  if (width >= 1) return 1;
  if (width >= 0.1) return 2;
  return 4;
}

// ── scatter ───────────────────────────────────────────────────────────────────

function buildScatter(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const pts = spec.points ?? [];

  // Points carry an optional group, which is the identity channel; ungrouped points are one
  // undifferentiated cloud rather than eight colours that mean nothing.
  const groups = [...new Set(pts.map((pt) => pt.group ?? ''))];
  const sizes = pts.map((pt) => pt.size ?? 0).filter((s) => s > 0);
  const maxSize = sizes.length ? Math.max(...sizes) : 0;

  const series = groups.map((g, i) => ({
    name: g || 'points',
    type: 'scatter' as const,
    data: pts
      .filter((pt) => (pt.group ?? '') === g)
      .map((pt) => ({
        value: [pt.x, pt.y],
        name: pt.label ?? '',
        symbolSize: maxSize > 0 ? 8 + 18 * Math.sqrt((pt.size ?? 0) / maxSize) : 10,
      })),
    itemStyle: {
      color: alpha(groups.length > 1 ? categoricalAt(mode, i) : p.semantic.accent, 0.75),
      // A 2px surface ring keeps overlapping dots countable.
      borderColor: p.surface,
      borderWidth: 2,
    },
    z: 5,
  }));

  return {
    ...base(spec, mode, groups.length > 1 ? groups.length : 1),
    grid: { left: 64, right: 28, top: 28, bottom: 56 },
    xAxis: {
      type: 'value',
      scale: true,
      name: spec.xLabel,
      nameLocation: 'middle',
      nameGap: 32,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      axisLabel: { color: p.textMuted, fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
    },
    yAxis: {
      type: 'value',
      scale: true,
      name: spec.yLabel,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      axisLabel: { color: p.textMuted, fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
    },
    tooltip: {
      ...tooltip(p),
      trigger: 'item',
      formatter: (prm: unknown) => {
        const q = prm as { name?: string; value: [number, number]; seriesName: string };
        const head = q.name ? `<b>${q.name}</b><br/>` : '';
        return `${head}${spec.xLabel ?? 'x'} ${q.value[0]}<br/>${spec.yLabel ?? 'y'} ${q.value[1]}`;
      },
    },
    series: scatterGuides(series, spec, mode),
  } as EChartsOption;
}

/**
 * The quadrant rules and the y=x diagonal. These are what make a scatter an argument: "stops are
 * clipped before targets are reached" is dots falling below the diagonal, not dots existing.
 */
function scatterGuides(series: object[], spec: VisualSpec, mode: VizMode): object[] {
  const p = vizPalette(mode);
  const lines: object[] = [];
  if (typeof spec.quadrantX === 'number')
    lines.push(guide({ xAxis: spec.quadrantX }, spec.xLabel ?? 'x', p.semantic.neutral));
  if (typeof spec.quadrantY === 'number')
    lines.push(guide({ yAxis: spec.quadrantY }, spec.yLabel ?? 'y', p.semantic.neutral));

  const out = [...series];
  if (lines.length > 0)
    out.push({
      type: 'scatter',
      data: [],
      markLine: { silent: true, symbol: 'none', data: lines, z: 1 },
    });

  if (spec.diagonal) {
    const pts = spec.points ?? [];
    const lo = Math.min(...pts.map((q) => Math.min(q.x, q.y)), 0);
    const hi = Math.max(...pts.map((q) => Math.max(q.x, q.y)), 0);
    out.push({
      name: '1:1',
      type: 'line',
      data: [
        [lo, lo],
        [hi, hi],
      ],
      symbol: 'none',
      lineStyle: { color: p.semantic.neutral, width: 1, type: 'dashed' },
      tooltip: { show: false },
      silent: true,
      z: 1,
    });
  }
  return out;
}

function guide(at: object, label: string, color: string) {
  return {
    ...at,
    lineStyle: { color, width: 1, type: 'dashed' as const },
    label: { show: true, formatter: label, color, fontSize: 10 },
  };
}

// ── heatmap ───────────────────────────────────────────────────────────────────

function buildHeatmap(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const cells = spec.cells ?? [];
  const values = cells.map((c) => c.value);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;

  // With a midpoint the ramp is diverging around it — which cells cleared the threshold, not which
  // cell was largest. Without one it is a single hue, light → dark. Never a rainbow either way.
  const hasMid = typeof spec.midpoint === 'number';
  const reach = hasMid ? Math.max(hi - spec.midpoint!, spec.midpoint! - lo) || 1 : 0;

  return {
    ...base(spec, mode, 0),
    grid: { left: 88, right: 24, top: 28, bottom: 76 },
    xAxis: {
      type: 'category',
      data: spec.xCategories ?? [],
      name: spec.xLabel,
      nameLocation: 'middle',
      nameGap: 30,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: { color: p.textMuted, fontSize: 10 },
    },
    yAxis: {
      type: 'category',
      data: spec.yCategories ?? [],
      name: spec.yLabel,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: { color: p.textMuted, fontSize: 10 },
    },
    visualMap: {
      min: hasMid ? spec.midpoint! - reach : lo,
      max: hasMid ? spec.midpoint! + reach : hi,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 8,
      itemWidth: 12,
      itemHeight: 90,
      text: [spec.valueLabel ?? '', ''],
      textStyle: { color: p.textMuted, fontSize: 10 },
      inRange: {
        color: hasMid
          ? [p.diverging.low, p.diverging.mid, p.diverging.high]
          : [p.sequential.from, p.sequential.to],
      },
    },
    tooltip: {
      ...tooltip(p),
      trigger: 'item',
      formatter: (prm: unknown) => {
        const q = prm as { value: [number, number, number] };
        const xs = spec.xCategories ?? [];
        const ys = spec.yCategories ?? [];
        return `${spec.xLabel ?? 'x'} ${xs[q.value[0]]}<br/>${spec.yLabel ?? 'y'} ${ys[q.value[1]]}<br/><b>${q.value[2]}</b>`;
      },
    },
    series: [
      {
        type: 'heatmap',
        data: cells.map((c) => [c.x, c.y, c.value]),
        // Every cell is directly labelled: a grid is read by value, and the relief rule applies
        // anyway for the lighter steps of the ramp.
        label: {
          show: true,
          fontSize: 10,
          color: p.text,
          formatter: (q: { value: number[] }) => fmtCell(q.value[2]),
        },
        itemStyle: { borderColor: p.surface, borderWidth: 2 },
      },
    ],
  } as EChartsOption;
}

const fmtCell = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

// ── waterfall ─────────────────────────────────────────────────────────────────

/**
 * Cumulative contributions — the session arc, where each step moves the running total. Drawn as a
 * transparent riser plus a visible signed block, which is the standard construction; the note on
 * each step rides under its label so "delta negative but price +11 pips" sits on the one bar that
 * makes the point.
 */
function buildWaterfall(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const steps = spec.steps ?? [];

  const risers: number[] = [];
  let running = 0;
  for (const s of steps) {
    risers.push(s.value >= 0 ? running : running + s.value);
    running += s.value;
  }

  const cats = steps.map((s) => s.label);
  const series: object[] = [
    {
      name: 'base',
      type: 'bar',
      stack: 'wf',
      silent: true,
      itemStyle: { color: 'transparent' },
      data: risers,
      tooltip: { show: false },
    },
    {
      name: spec.yLabel ?? 'change',
      type: 'bar',
      stack: 'wf',
      barMaxWidth: 44,
      data: steps.map((s) => ({
        value: Math.abs(s.value),
        itemStyle: { color: signColor(mode, s.value) },
      })),
      label: {
        show: true,
        position: 'top',
        fontSize: 10,
        color: p.text,
        formatter: (q: { dataIndex: number }) => {
          const s = steps[q.dataIndex];
          return s.note ? `${fmtSigned(s.value)}\n${s.note}` : fmtSigned(s.value);
        },
      },
      itemStyle: { borderRadius: 3 },
      z: 5,
    },
  ];

  if (spec.showTotal) {
    cats.push('Total');
    (series[0] as { data: number[] }).data.push(0);
    (series[1] as { data: unknown[] }).data.push({
      value: running,
      itemStyle: { color: p.semantic.accent },
    });
  }

  return {
    ...base(spec, mode, 0),
    grid: { left: 64, right: 24, top: 40, bottom: 56 },
    xAxis: {
      type: 'category',
      data: cats,
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: { color: p.textMuted, fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      name: spec.yLabel,
      nameTextStyle: { color: p.textMuted, fontSize: 10 },
      axisLabel: { color: p.textMuted, fontSize: 10 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
    },
    tooltip: {
      ...tooltip(p),
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const i = (arr[0] as { dataIndex: number }).dataIndex;
        const s = steps[i];
        if (!s) return `Total <b>${fmtSigned(running)}</b>`;
        return `<b>${s.label}</b><br/>${fmtSigned(s.value)}${s.note ? `<br/>${s.note}` : ''}`;
      },
    },
    series: withAnnotations(series, spec, mode, false),
  } as EChartsOption;
}

const fmtSigned = (v: number): string =>
  (v > 0 ? '+' : '') + (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

// ── tree ──────────────────────────────────────────────────────────────────────

/**
 * A scenario tree, laid out left-to-right. ECharts has no edge labels, so the trigger condition is
 * rendered as the node's first line in a dimmer style — which keeps the grammar the analyst was
 * told to write ("condition on the edge, consequence on the node") intact for the reader.
 */
function buildTree(spec: VisualSpec, mode: VizMode): EChartsOption {
  const p = vizPalette(mode);
  const kindColor = (k?: string): string =>
    k === 'bull'
      ? p.semantic.up
      : k === 'bear'
        ? p.semantic.down
        : k === 'invalid'
          ? p.semantic.warn
          : p.semantic.accent;

  const toNode = (n: VisualTreeNode): object => ({
    name: n.label,
    value: n.detail ?? '',
    itemStyle: { color: kindColor(n.kind), borderColor: p.surface, borderWidth: 2 },
    label: {
      formatter: n.edgeLabel
        ? [`{cond|${n.edgeLabel}}`, `{node|${n.label}}`].join('\n')
        : `{node|${n.label}}`,
      rich: {
        cond: { color: p.textMuted, fontSize: 10, lineHeight: 14 },
        node: { color: p.text, fontSize: 11, fontWeight: 'bold', lineHeight: 16 },
      },
    },
    children: (n.children ?? []).map(toNode),
  });

  return {
    ...base(spec, mode, 0),
    tooltip: {
      ...tooltip(p),
      trigger: 'item',
      formatter: (prm: unknown) => {
        const q = prm as { name: string; value?: string };
        return q.value ? `<b>${q.name}</b><br/>${q.value}` : `<b>${q.name}</b>`;
      },
    },
    series: [
      {
        type: 'tree',
        data: spec.root ? [toNode(spec.root)] : [],
        left: 24,
        right: 180,
        top: 32,
        bottom: 24,
        orient: 'LR',
        symbolSize: 10,
        edgeShape: 'polyline',
        initialTreeDepth: -1,
        expandAndCollapse: false,
        lineStyle: { color: p.grid, width: 1.5 },
        label: { position: 'right', align: 'left', distance: 8 },
        leaves: { label: { position: 'right', align: 'left' } },
      },
    ],
  } as EChartsOption;
}

// ── shared ────────────────────────────────────────────────────────────────────

/**
 * Option scaffolding every type shares. The title lives in the component's own header rather than
 * in the chart, so it wraps and stays selectable; what the chart owns is the legend, which is
 * present whenever there is more than one series so identity is never colour-alone.
 */
function base(spec: VisualSpec, mode: VizMode, seriesCount: number) {
  const p = vizPalette(mode);
  return {
    animation: false,
    backgroundColor: 'transparent',
    legend:
      seriesCount > 1
        ? {
            type: 'scroll' as const,
            top: 0,
            left: 0,
            itemWidth: 10,
            itemHeight: 10,
            itemGap: 14,
            textStyle: { color: p.textMuted, fontSize: 11 },
          }
        : { show: false },
  };
}

const tooltip = (p: ReturnType<typeof vizPalette>) => ({
  backgroundColor: p.surface,
  borderColor: p.grid,
  textStyle: { color: p.text, fontSize: 11 },
  confine: true,
});

/**
 * Reference lines and shaded bands, attached to a carrier series so they survive whichever type is
 * being drawn. A band whose `axis` is "right" lands on the lower panel of a split line chart, which
 * is where its series is.
 */
function withAnnotations(
  series: object[],
  spec: VisualSpec,
  mode: VizMode,
  split: boolean,
): object[] {
  const p = vizPalette(mode);
  const lines = spec.markLines ?? [];
  const bands = spec.bands ?? [];
  if (lines.length === 0 && bands.length === 0) return series;

  const carriers: object[] = [];
  for (const panel of split ? [0, 1] : [0]) {
    const onPanel = (a: { axis?: 'right' }) =>
      split ? (a.axis === 'right' ? 1 : 0) === panel : true;
    const ls = lines.filter(onPanel);
    const bs = bands.filter(onPanel);
    if (ls.length === 0 && bs.length === 0) continue;

    carriers.push({
      type: 'line',
      xAxisIndex: panel,
      yAxisIndex: panel,
      data: [],
      silent: true,
      z: 2,
      markLine: ls.length
        ? {
            silent: true,
            symbol: 'none',
            data: ls.map((m) => {
              const color = roleColor(mode, m.color, p.semantic.neutral);
              return {
                ...(typeof m.y === 'number' ? { yAxis: m.y } : { xAxis: m.x }),
                lineStyle: { color, width: 1.5, type: 'dashed' as const },
                label: m.label
                  ? {
                      show: true,
                      formatter: m.label,
                      position: 'insideEndTop' as const,
                      color,
                      fontSize: 10,
                    }
                  : { show: false },
              };
            }),
          }
        : undefined,
      markArea: bs.length
        ? {
            silent: true,
            data: bs.map((b) => [
              {
                yAxis: Math.min(b.from, b.to),
                itemStyle: { color: alpha(roleColor(mode, b.color, p.semantic.accent), 0.09) },
                label: b.label
                  ? {
                      show: true,
                      formatter: b.label,
                      position: 'insideTopLeft' as const,
                      color: p.textMuted,
                      fontSize: 10,
                    }
                  : { show: false },
              },
              { yAxis: Math.max(b.from, b.to) },
            ]),
          }
        : undefined,
    });
  }
  return [...series, ...carriers];
}
