import type { EChartsOption } from 'echarts';

import { alpha, vizPalette, type VizColorRole, type VizMode } from '../analysis-visual/viz-palette';

/**
 * The chat `price_chart` tool's wire contract, and the pure translation of it into an ECharts
 * option over a fetched candle window.
 *
 * <p>This is the artifact the analyst named first and valued most: "price is at 24% of the 20-bar
 * range inside a balance area with an accumulation base" is a sentence nobody can verify by eye.
 * Every layer below exists because some claim in that conversation was unverifiable without it —
 * levels for the named prices, zones for the balance box, markers for the event that started it,
 * trendlines for the converging swing structure, segments for the signal ledger, setups for the
 * geometry, and time-aligned panels for the order flow.</p>
 *
 * <p>Kept free of Angular and of the API types so the layout arithmetic — which index a timestamp
 * lands on, how a short panel array aligns against a longer candle window — is unit-testable. Those
 * two are exactly where a chart goes silently wrong: an annotation one bar off still draws.</p>
 */

export interface PriceBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type LevelKind = 'structure' | 'value' | 'round' | 'pool' | 'pivot' | 'live';
export type ZoneKind = 'balance' | 'value' | 'supply' | 'demand' | 'pool' | 'neutral';

export interface PriceChartSpec {
  kind: 'price_chart';
  symbol: string;
  timeframe: string;
  bars: number;
  title?: string;
  caption?: string;
  asOfUtc?: string;
  estimated?: boolean;

  levels?: { price: number; label: string; kind: LevelKind; dashed?: boolean }[];
  zones?: { from: number; to: number; label: string; kind: ZoneKind }[];
  markers?: { time: string; price: number; label: string; kind: string }[];
  trendlines?: {
    from: { time: string; price: number };
    to: { time: string; price: number };
    label?: string;
    kind?: 'support' | 'resistance' | 'neutral';
  }[];
  segments?: {
    from: { time: string; price: number };
    to: { time: string; price: number };
    label?: string;
    outcome?: 'win' | 'loss' | 'open' | 'expired' | 'scratch';
  }[];
  setups?: {
    label: string;
    action: 'Buy' | 'Sell';
    entry: number;
    sl: number;
    tp: number;
    rr?: number;
    note?: string;
  }[];
  vwap?: { value: number; upper?: number; lower?: number };
  volumeProfile?: {
    poc?: number;
    valueAreaLow?: number;
    valueAreaHigh?: number;
    bins?: { price: number; volume: number }[];
  };
  panels?: {
    name: string;
    type: 'delta' | 'cumulative' | 'line' | 'volume';
    data: (number | null)[];
    color?: VizColorRole;
  }[];
}

export function parsePriceChartSpec(json: string | null | undefined): PriceChartSpec | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as PriceChartSpec;
    return parsed && parsed.kind === 'price_chart' && typeof parsed.symbol === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

// ── Layout ────────────────────────────────────────────────────────────────────

const TOP = 26;
const PANEL_H = 84;
const PANEL_GAP = 26;
const AXIS_BAND = 46;
const PROFILE_W = 64;

/** Total pixel height a spec needs: the price pane plus one band per order-flow panel. */
export function chartHeight(spec: PriceChartSpec): number {
  const panels = (spec.panels ?? []).length;
  return 380 + panels * (PANEL_H + PANEL_GAP);
}

/**
 * Index of the candle whose open lands at-or-before `iso`.
 *
 * <p>Returns a FRACTIONAL index when the instant falls between two bars, so a trendline anchored
 * mid-bar is drawn where it was actually anchored. Out-of-window instants clamp to the edge rather
 * than vanishing: an annotation that silently disappears reads as the analyst not having made the
 * claim, which is worse than one drawn at the boundary.</p>
 */
export function indexAt(bars: PriceBar[], iso: string): number {
  if (bars.length === 0) return 0;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  const ms = bars.map((b) => Date.parse(b.timestamp));
  if (at <= ms[0]) return 0;
  if (at >= ms[ms.length - 1]) return ms.length - 1;
  for (let i = 0; i < ms.length - 1; i++) {
    if (at >= ms[i] && at < ms[i + 1]) {
      const span = ms[i + 1] - ms[i];
      return span > 0 ? i + (at - ms[i]) / span : i;
    }
  }
  return ms.length - 1;
}

/**
 * Right-align a panel series against the candle window.
 *
 * <p>The analyst rarely holds a reading for every bar the chart fetches and always holds the most
 * recent ones. Padding the LEFT with gaps puts each reading under its own bar; padding the right
 * would slide the whole series forward in time, which draws a real dataset against the wrong bars —
 * the one failure here that still looks like a working chart.</p>
 */
export function alignRight(data: (number | null)[], barCount: number): (number | null)[] {
  if (data.length >= barCount) return data.slice(data.length - barCount);
  return [...new Array<number | null>(barCount - data.length).fill(null), ...data];
}

/** Decimals for a price axis — JPY-style pairs sit above 50, majors below 2. */
export const pricePrecision = (sample: number): number => (sample > 50 ? 3 : 5);

/** Hard ceiling on a fetched window, so a marker a month back cannot ask for 40,000 M1 bars. */
const MAX_WINDOW_BARS = 1000;

const TF_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
  W1: 10080,
  MN1: 43200,
};

export const timeframeMinutes = (tf: string): number => TF_MINUTES[tf?.toUpperCase()] ?? 60;

/**
 * The candle window a spec needs: `bars` of history, but widened backwards whenever an annotation
 * references an instant older than that.
 *
 * <p>The widening is the load-bearing part. A 60-bar H1 chart covers two and a half days, and the
 * FOMC print the analyst wants to mark sits three days back — clamped to the left edge that marker
 * would be drawn on the wrong bar while still looking like a working chart, which is the one
 * failure mode a reader has no way to notice. The window always runs through to the PRESENT, so
 * reopening an old conversation shows what price did after the argument was made.</p>
 */
export function windowFor(spec: PriceChartSpec, nowMs: number): { itemCount: number; to: string } {
  const tfMs = timeframeMinutes(spec.timeframe) * 60_000;
  let startMs = nowMs - Math.max(20, spec.bars) * tfMs;

  const earliest = earliestAnnotation(spec);
  if (earliest !== null && earliest < startMs) startMs = earliest - 3 * tfMs;

  const count = Math.ceil((nowMs - startMs) / tfMs) + 2;
  return {
    itemCount: Math.max(20, Math.min(MAX_WINDOW_BARS, count)),
    to: new Date(nowMs).toISOString(),
  };
}

/** Oldest instant any annotation refers to, or null when nothing is time-anchored. */
export function earliestAnnotation(spec: PriceChartSpec): number | null {
  const stamps = [
    ...(spec.markers ?? []).map((m) => m.time),
    ...(spec.trendlines ?? []).flatMap((t) => [t.from.time, t.to.time]),
    ...(spec.segments ?? []).flatMap((s) => [s.from.time, s.to.time]),
    ...(spec.asOfUtc ? [spec.asOfUtc] : []),
  ]
    .map((iso) => Date.parse(iso))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.min(...stamps) : null;
}

// ── Option ────────────────────────────────────────────────────────────────────

export function toPriceChartOption(
  spec: PriceChartSpec,
  bars: PriceBar[],
  mode: VizMode,
  livePrice: number | null = null,
): EChartsOption | null {
  if (bars.length === 0) return null;

  const p = vizPalette(mode);
  const lastIdx = bars.length - 1;
  const dp = pricePrecision(bars[0].close);
  const fmt = (n: number) => n.toFixed(dp);

  const profileBins = spec.volumeProfile?.bins ?? [];
  const hasProfile = profileBins.length > 0;
  const panels = spec.panels ?? [];
  const height = chartHeight(spec);
  const priceH = height - TOP - AXIS_BAND - panels.length * (PANEL_H + PANEL_GAP);

  // ── Grids: price (+ an optional profile column to its right) then one band per panel ──
  //
  // The gutter holds the right-margin price pills (ENTRY / TP / POC / LIVE), and when a profile is
  // drawn it also holds the profile column. The profile grid is positioned by WIDTH against the
  // right edge rather than by `left`, which would span the whole frame and lay the histogram
  // straight across the candles.
  const PILL_GUTTER = 96;
  const rightGutter = hasProfile ? PROFILE_W + PILL_GUTTER : PILL_GUTTER;
  const grids: object[] = [{ left: 68, right: rightGutter, top: TOP, height: priceH }];
  if (hasProfile) grids.push({ width: PROFILE_W, right: PILL_GUTTER, top: TOP, height: priceH });
  panels.forEach((_, i) => {
    grids.push({
      left: 68,
      right: rightGutter,
      top: TOP + priceH + PANEL_GAP + i * (PANEL_H + PANEL_GAP),
      height: PANEL_H,
    });
  });
  const profileGrid = hasProfile ? 1 : -1;
  const firstPanelGrid = hasProfile ? 2 : 1;

  // ── Y bounds: every drawn price participates, so nothing clips off the top or bottom ──
  const ys: number[] = [...bars.map((b) => b.low), ...bars.map((b) => b.high)];
  for (const l of spec.levels ?? []) ys.push(l.price);
  for (const z of spec.zones ?? []) ys.push(z.from, z.to);
  for (const m of spec.markers ?? []) ys.push(m.price);
  for (const t of spec.trendlines ?? []) ys.push(t.from.price, t.to.price);
  for (const s of spec.segments ?? []) ys.push(s.from.price, s.to.price);
  for (const s of spec.setups ?? []) ys.push(s.entry, s.sl, s.tp);
  if (spec.vwap)
    ys.push(
      spec.vwap.value,
      spec.vwap.upper ?? spec.vwap.value,
      spec.vwap.lower ?? spec.vwap.value,
    );
  if (spec.volumeProfile?.poc) ys.push(spec.volumeProfile.poc);
  if (spec.volumeProfile?.valueAreaLow) ys.push(spec.volumeProfile.valueAreaLow);
  if (spec.volumeProfile?.valueAreaHigh) ys.push(spec.volumeProfile.valueAreaHigh);
  if (livePrice !== null && Number.isFinite(livePrice)) ys.push(livePrice);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const pad = (yMax - yMin) * 0.08 || 0.0005;

  const categories = bars.map((b) => b.timestamp);
  const axisLabel = { color: p.textMuted, fontSize: 10, hideOverlap: true };
  const timeLabel = {
    ...axisLabel,
    formatter: (v: string) => {
      const d = new Date(v);
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    },
  };

  const xAxes: object[] = [
    {
      type: 'category',
      gridIndex: 0,
      data: categories,
      boundaryGap: true,
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: panels.length === 0 ? timeLabel : { show: false },
      splitLine: { show: false },
    },
  ];
  const yAxes: object[] = [
    {
      type: 'value',
      gridIndex: 0,
      scale: true,
      min: yMin - pad,
      max: yMax + pad,
      axisLabel: { ...axisLabel, formatter: (v: number) => fmt(v) },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
    },
  ];

  if (hasProfile) {
    // The profile column shares the price scale exactly, so a bin sits at the height of its own
    // price. Bars grow leftward from the right edge, which keeps them out of the candles.
    xAxes.push({ type: 'value', gridIndex: profileGrid, inverse: true, show: false });
    yAxes.push({
      type: 'value',
      gridIndex: profileGrid,
      min: yMin - pad,
      max: yMax + pad,
      show: false,
    });
  }

  panels.forEach((panel, i) => {
    const gi = firstPanelGrid + i;
    xAxes.push({
      type: 'category',
      gridIndex: gi,
      data: categories,
      boundaryGap: true,
      axisLine: { lineStyle: { color: p.axis } },
      axisTick: { show: false },
      axisLabel: i === panels.length - 1 ? timeLabel : { show: false },
      splitLine: { show: false },
    });
    yAxes.push({
      type: 'value',
      gridIndex: gi,
      scale: true,
      name: panel.name,
      nameTextStyle: { color: p.textMuted, fontSize: 10, align: 'left' },
      nameLocation: 'end',
      nameGap: 6,
      axisLabel: { ...axisLabel, showMinLabel: false },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: p.grid } },
      splitNumber: 2,
    });
  });

  // ── Series ────────────────────────────────────────────────────────────────
  const series: object[] = [];

  const markAreas: object[][] = [];
  for (const z of spec.zones ?? []) {
    const c = zoneColor(z.kind, p);
    markAreas.push([
      {
        yAxis: z.from,
        itemStyle: { color: alpha(c, z.kind === 'pool' ? 0.16 : 0.1) },
        name: z.label,
        label: {
          show: true,
          position: 'insideTopLeft',
          distance: 6,
          color: p.textMuted,
          fontSize: 10,
        },
      },
      { yAxis: z.to },
    ]);
  }
  // The VWAP ±1σ envelope is a band, not two lines: what it says is "inside or outside", and two
  // lines invite the reader to treat each edge as a level.
  if (spec.vwap?.upper !== undefined && spec.vwap?.lower !== undefined) {
    markAreas.push([
      { yAxis: spec.vwap.lower, itemStyle: { color: alpha(p.semantic.accent, 0.07) } },
      { yAxis: spec.vwap.upper },
    ]);
  }
  if (
    spec.volumeProfile?.valueAreaLow !== undefined &&
    spec.volumeProfile?.valueAreaHigh !== undefined
  ) {
    markAreas.push([
      {
        yAxis: spec.volumeProfile.valueAreaLow,
        itemStyle: { color: alpha(p.categorical[6], 0.08) },
        name: 'Value area',
        label: {
          show: true,
          position: 'insideBottomLeft',
          distance: 6,
          color: p.textMuted,
          fontSize: 10,
        },
      },
      { yAxis: spec.volumeProfile.valueAreaHigh },
    ]);
  }
  for (const s of spec.setups ?? []) {
    markAreas.push([
      { yAxis: s.entry, itemStyle: { color: alpha(p.semantic.up, 0.13) } },
      { yAxis: s.tp },
    ]);
    markAreas.push([
      { yAxis: s.entry, itemStyle: { color: alpha(p.semantic.down, 0.13) } },
      { yAxis: s.sl },
    ]);
  }

  const markPoints = (spec.markers ?? []).map((m) => ({
    name: m.label,
    coord: [Math.round(indexAt(bars, m.time)), m.price],
    symbol: markerSymbol(m.kind),
    symbolSize: m.kind === 'event' ? 14 : 11,
    itemStyle: { color: markerColor(m.kind, p), borderColor: p.surface, borderWidth: 2 },
    label: { show: true, formatter: m.label, position: 'top', fontSize: 10, color: p.text },
  }));

  series.push({
    name: spec.symbol,
    type: 'candlestick',
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: bars.map((b) => [b.open, b.close, b.low, b.high]),
    itemStyle: {
      color: p.semantic.up,
      color0: p.semantic.down,
      borderColor: p.semantic.up,
      borderColor0: p.semantic.down,
    },
    z: 5,
    markArea: markAreas.length ? { silent: true, z: 0, data: markAreas } : undefined,
    markPoint: markPoints.length ? { silent: true, data: markPoints } : undefined,
  });

  // Levels: two-point line series with a right-margin pill, matching the Entry/SL/TP convention the
  // recommendation chart already established elsewhere in the app.
  const flat = (y: number) => [
    [0, y],
    [lastIdx, y],
  ];
  for (const l of spec.levels ?? []) {
    const c = levelColor(l.kind, p);
    series.push({
      name: l.label,
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: flat(l.price),
      symbol: 'none',
      lineStyle: {
        color: c,
        width: l.kind === 'structure' ? 2 : 1.5,
        type: l.dashed || l.kind === 'round' ? 'dashed' : 'solid',
      },
      tooltip: { show: false },
      z: 9,
      endLabel: {
        show: true,
        formatter: `${l.label} ${fmt(l.price)}`,
        backgroundColor: c,
        color: '#ffffff',
        padding: [2, 6],
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 'bold',
      },
    });
  }

  if (spec.vwap) {
    series.push({
      name: 'VWAP',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: flat(spec.vwap.value),
      symbol: 'none',
      lineStyle: { color: p.semantic.accent, width: 1.5, type: 'dotted' },
      tooltip: { show: false },
      z: 9,
      endLabel: {
        show: true,
        formatter: `VWAP ${fmt(spec.vwap.value)}`,
        backgroundColor: p.semantic.accent,
        color: '#ffffff',
        padding: [2, 6],
        borderRadius: 3,
        fontSize: 10,
      },
    });
  }

  if (spec.volumeProfile?.poc !== undefined) {
    series.push({
      name: 'POC',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: flat(spec.volumeProfile.poc),
      symbol: 'none',
      lineStyle: { color: p.categorical[6], width: 2 },
      tooltip: { show: false },
      z: 9,
      endLabel: {
        show: true,
        formatter: `POC ${fmt(spec.volumeProfile.poc)}`,
        backgroundColor: p.categorical[6],
        color: '#ffffff',
        padding: [2, 6],
        borderRadius: 3,
        fontSize: 10,
      },
    });
  }

  for (const s of spec.setups ?? []) {
    const triple: [string, number, string][] = [
      ['ENTRY', s.entry, p.text],
      ['TP', s.tp, p.semantic.up],
      ['SL', s.sl, p.semantic.down],
    ];
    for (const [tag, price, color] of triple) {
      series.push({
        name: `${s.label} ${tag}`,
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: flat(price),
        symbol: 'none',
        lineStyle: { color, width: 2 },
        tooltip: { show: false },
        z: 10,
        endLabel: {
          show: true,
          formatter: `${s.label} ${tag} ${fmt(price)}`,
          backgroundColor: color,
          color: mode === 'dark' && color === p.text ? '#000000' : '#ffffff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 'bold',
        },
      });
    }
  }

  for (const t of spec.trendlines ?? []) {
    const c =
      t.kind === 'support'
        ? p.semantic.up
        : t.kind === 'resistance'
          ? p.semantic.down
          : p.semantic.neutral;
    series.push({
      name: t.label ?? 'trend',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: [
        [indexAt(bars, t.from.time), t.from.price],
        [indexAt(bars, t.to.time), t.to.price],
      ],
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color: c, width: 2, type: 'dashed' },
      itemStyle: { color: c },
      tooltip: { show: false },
      z: 8,
      endLabel: t.label
        ? { show: true, formatter: t.label, color: c, fontSize: 10, distance: 4 }
        : { show: false },
    });
  }

  for (const s of spec.segments ?? []) {
    const c = outcomeColor(s.outcome, p);
    series.push({
      name: s.label ?? 'trade',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: [
        [indexAt(bars, s.from.time), s.from.price],
        [indexAt(bars, s.to.time), s.to.price],
      ],
      symbol: 'roundRect',
      symbolSize: 8,
      lineStyle: { color: c, width: 3, opacity: 0.85 },
      itemStyle: { color: c, borderColor: p.surface, borderWidth: 2 },
      tooltip: { show: false },
      z: 8,
      // Outcome is in the label as well as the colour — a ledger read by colour alone is a ledger
      // two readers in ten cannot read.
      endLabel: {
        show: true,
        formatter: s.label ? `${s.label} · ${s.outcome ?? 'open'}` : (s.outcome ?? 'open'),
        color: c,
        fontSize: 10,
        distance: 4,
      },
    });
  }

  if (livePrice !== null && Number.isFinite(livePrice)) {
    series.push({
      name: 'LIVE',
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: flat(livePrice),
      symbol: 'none',
      lineStyle: { color: p.semantic.accent, width: 1.5, type: 'dashed' },
      tooltip: { show: false },
      z: 11,
      endLabel: {
        show: true,
        formatter: `LIVE ${fmt(livePrice)}`,
        backgroundColor: p.semantic.accent,
        color: '#ffffff',
        padding: [2, 6],
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 'bold',
      },
    });
  }

  if (hasProfile) {
    series.push({
      name: 'Volume profile',
      type: 'bar',
      xAxisIndex: profileGrid,
      yAxisIndex: profileGrid,
      data: profileBins.map((b) => [b.volume, b.price]),
      barWidth: 3,
      itemStyle: { color: alpha(p.categorical[6], 0.55) },
      tooltip: { show: false },
      silent: true,
      z: 3,
    });
  }

  // Aligned once and shared with the tooltip below — a hover must not re-pad every panel series.
  const panelData = panels.map((panel) => alignRight(panel.data, bars.length));

  panels.forEach((panel, i) => {
    const gi = firstPanelGrid + i;
    const data = panelData[i];
    const diverging = panel.type === 'delta';
    series.push(
      diverging || panel.type === 'volume'
        ? {
            name: panel.name,
            type: 'bar',
            xAxisIndex: gi,
            yAxisIndex: gi,
            data: data.map((v) =>
              v === null
                ? null
                : {
                    value: v,
                    itemStyle: {
                      color: diverging
                        ? v > 0
                          ? p.semantic.up
                          : v < 0
                            ? p.semantic.down
                            : p.semantic.neutral
                        : alpha(p.semantic.neutral, 0.6),
                    },
                  },
            ),
            z: 5,
          }
        : {
            name: panel.name,
            type: 'line',
            xAxisIndex: gi,
            yAxisIndex: gi,
            data,
            connectNulls: false,
            symbol: 'none',
            lineStyle: {
              color: panel.color ? p.semantic[panel.color] : p.semantic.accent,
              width: 2,
            },
            areaStyle:
              panel.type === 'cumulative'
                ? { color: alpha(panel.color ? p.semantic[panel.color] : p.semantic.accent, 0.12) }
                : undefined,
            markLine: {
              silent: true,
              symbol: 'none',
              data: [{ yAxis: 0, lineStyle: { color: p.axis, width: 1, type: 'dashed' } }],
            },
            z: 5,
          },
    );
  });

  const priceAxes = [0, ...panels.map((_, i) => firstPanelGrid + i)];

  return {
    animation: false,
    backgroundColor: 'transparent',
    legend: { show: false },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    // One crosshair across price and every panel: the whole reason a panel sits beneath the candles
    // is to be read against the same bar.
    axisPointer: { link: [{ xAxisIndex: priceAxes }] },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: p.surface,
      borderColor: p.grid,
      textStyle: { color: p.text, fontSize: 11 },
      confine: true,
      formatter: (params: unknown) => {
        const arr = (Array.isArray(params) ? params : [params]) as {
          seriesType: string;
          dataIndex: number;
          seriesName: string;
          value: unknown;
        }[];
        const candle = arr.find((q) => q.seriesType === 'candlestick');
        const bar = candle ? bars[candle.dataIndex] : undefined;
        if (!bar) return '';
        const d = new Date(bar.timestamp);
        const head = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
        const ohlc = `O ${fmt(bar.open)}  H ${fmt(bar.high)}<br/>L ${fmt(bar.low)}  C ${fmt(bar.close)}`;
        const panelRows = panels
          .map((panel, pi) => {
            const v = panelData[pi][candle!.dataIndex];
            return v === null || v === undefined ? '' : `${panel.name} ${v}`;
          })
          .filter(Boolean)
          .join('<br/>');
        return `<b>${head}</b><br/>${ohlc}${panelRows ? `<br/>${panelRows}` : ''}`;
      },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: priceAxes, startValue: 0, endValue: lastIdx },
      {
        type: 'slider',
        xAxisIndex: priceAxes,
        height: 20,
        bottom: 10,
        startValue: 0,
        endValue: lastIdx,
        textStyle: { color: p.textMuted, fontSize: 9 },
      },
    ],
    series,
  } as EChartsOption;
}

// ── Kind → colour ─────────────────────────────────────────────────────────────

type Palette = ReturnType<typeof vizPalette>;

/**
 * Levels are colour-coded BY TYPE, which was the explicit ask: structure, value area and round
 * numbers are three different kinds of claim and must not read as one undifferentiated stack.
 */
function levelColor(kind: LevelKind, p: Palette): string {
  switch (kind) {
    case 'value':
      return p.categorical[6];
    case 'round':
      return p.semantic.muted;
    case 'pool':
      return p.semantic.warn;
    case 'pivot':
      return p.categorical[1];
    case 'live':
      return p.semantic.accent;
    default:
      return p.semantic.neutral;
  }
}

function zoneColor(kind: ZoneKind, p: Palette): string {
  switch (kind) {
    case 'balance':
      return p.semantic.accent;
    case 'value':
      return p.categorical[6];
    case 'supply':
      return p.semantic.down;
    case 'demand':
      return p.semantic.up;
    case 'pool':
      return p.semantic.warn;
    default:
      return p.semantic.neutral;
  }
}

function outcomeColor(outcome: string | undefined, p: Palette): string {
  switch (outcome) {
    case 'win':
      return p.semantic.up;
    case 'loss':
      return p.semantic.down;
    case 'expired':
      return p.semantic.warn;
    case 'scratch':
      return p.semantic.muted;
    default:
      return p.semantic.accent;
  }
}

function markerSymbol(kind: string): string {
  switch (kind) {
    case 'event':
      return 'pin';
    case 'high':
      return 'triangle';
    case 'low':
      return 'arrow';
    case 'fill':
      return 'diamond';
    case 'exit':
      return 'rect';
    default:
      return 'circle';
  }
}

function markerColor(kind: string, p: Palette): string {
  switch (kind) {
    case 'event':
      return p.semantic.warn;
    case 'high':
      return p.semantic.down;
    case 'low':
      return p.semantic.up;
    case 'fill':
      return p.semantic.accent;
    case 'exit':
      return p.semantic.neutral;
    default:
      return p.semantic.neutral;
  }
}
