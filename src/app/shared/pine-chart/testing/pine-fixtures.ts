import type {
  PineAlertEventOutput,
  PineBar,
  PineBoxOutput,
  PineCandleOutput,
  PineColorSeriesOutput,
  PineFillOutput,
  PineHlineOutput,
  PineLabelOutput,
  PineLineOutput,
  PineLinefillOutput,
  PineLogOutput,
  PineMarkerOutput,
  PinePlotOutput,
  PinePolylineOutput,
  PineProfileLine,
  PineReportTrade,
  PineRunResult,
  PineScriptOutputs,
  PineTableCellOutput,
  PineTableOutput,
  PineTraceBar,
} from '../model/pine-outputs.types';

/**
 * Realistic §3 run results built the way the engine exports them (camelCase ScriptOutputs, per-bar
 * arrays aligned to bars.times, na = null, colors "#RRGGBBAA", offsets/show_last reported only),
 * exercising every output kind. Deterministic: the same arguments give the same result.
 *
 * - `overlayStrategyFixture()` — an overlay strategy: every plot style, all 12 shapes over the five
 *   locations and six sizes, chars, arrows, bgcolor, barcolor, fills (per-bar and gradient), every
 *   label style, lines/boxes/polylines/linefills, tables with merged cells, logs, alerts, trades,
 *   trace and profile.
 * - `paneIndicatorFixture()` — a non-overlay indicator: its own pane with hlines, hline fill,
 *   histogram/columns/area/areabr, plotbar, pane markers and arrows, display variants, a table with
 *   % sizes, force_overlay outputs on the price pane, and a runtime error.
 * - `largeFixture()` — 20,000 bars × dozens of per-bar-colored plots for performance checks.
 */

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PINE = {
  aqua: '#00BCD4FF',
  black: '#363A45FF',
  blue: '#2962FFFF',
  fuchsia: '#E040FBFF',
  gray: '#787B86FF',
  green: '#4CAF50FF',
  lime: '#00E676FF',
  maroon: '#880E4FFF',
  navy: '#311B92FF',
  olive: '#808000FF',
  orange: '#FF9800FF',
  purple: '#9C27B0FF',
  red: '#F23645FF',
  silver: '#B2B5BEFF',
  teal: '#089981FF',
  white: '#FFFFFFFF',
  yellow: '#FDD835FF',
} as const;

/** color.new(c, transp) */
export function tr(color: string, transparency: number): string {
  const a = Math.round(255 * (1 - transparency / 100));
  return color.slice(0, 7) + a.toString(16).toUpperCase().padStart(2, '0');
}

const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d;

/** Hourly EURUSD-like bars from 2026-06-01, skipping weekends. */
export function generateBars(n: number, seed = 7, stepMs = 3_600_000, startPrice = 1.085): PineBar[] {
  const rand = rng(seed);
  const bars: PineBar[] = [];
  let t = Date.UTC(2026, 5, 1, 0, 0, 0);
  let price = startPrice;
  let drift = 0;
  while (bars.length < n) {
    const day = new Date(t).getUTCDay();
    if (stepMs < 86_400_000 && (day === 6 || day === 0)) {
      t += stepMs;
      continue;
    }
    drift = drift * 0.96 + (rand() - 0.5) * 0.00012;
    const o = price;
    const c = o + drift + (rand() - 0.5) * 0.0011;
    const h = Math.max(o, c) + rand() * 0.0006;
    const l = Math.min(o, c) - rand() * 0.0006;
    bars.push({ t, o: round(o), h: round(h), l: round(l), c: round(c), v: Math.round(400 + rand() * 1600) });
    price = c;
    t += stepMs;
  }
  return bars;
}

export function ema(src: readonly number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    prev = i === 0 ? src[0] : src[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(src: readonly number[], len: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= len) sum -= src[i - len];
    out.push(i >= len - 1 ? sum / len : null);
  }
  return out;
}

export function rsi(src: readonly number[], len = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let up = 0;
  let down = 0;
  for (let i = 0; i < src.length; i++) {
    if (i === 0) {
      out.push(null);
      continue;
    }
    const ch = src[i] - src[i - 1];
    up = (up * (len - 1) + Math.max(ch, 0)) / len;
    down = (down * (len - 1) + Math.max(-ch, 0)) / len;
    out.push(i < len ? null : down === 0 ? 100 : 100 - 100 / (1 + up / down));
  }
  return out;
}

function stdev(src: readonly number[], len: number): (number | null)[] {
  const m = sma(src, len);
  return src.map((_, i) => {
    const mean = m[i];
    if (mean === null) return null;
    let s = 0;
    for (let k = i - len + 1; k <= i; k++) s += (src[k] - mean) ** 2;
    return Math.sqrt(s / len);
  });
}

const baseSeries = { editable: true, showLast: null, display: ['all'], forceOverlay: false, offset: 0 };

export function plot(p: Partial<PinePlotOutput> & Pick<PinePlotOutput, 'id' | 'values'>): PinePlotOutput {
  return {
    ...baseSeries,
    title: null,
    plotNumber: p.id,
    style: 'line',
    lineStyle: 'solid',
    lineWidth: 1,
    trackPrice: false,
    histBase: 0,
    join: false,
    format: null,
    precision: null,
    color: PINE.blue,
    colors: null,
    ...p,
  };
}

export function marker(m: Partial<PineMarkerOutput> & Pick<PineMarkerOutput, 'id' | 'points'>): PineMarkerOutput {
  return {
    ...baseSeries,
    title: null,
    plotNumber: m.id,
    kind: 'shape',
    shape: 'xcross',
    char: null,
    location: 'abovebar',
    size: 'auto',
    text: '',
    minHeight: null,
    maxHeight: null,
    format: null,
    precision: null,
    ...m,
  };
}

export const x = (barIndex: number, times: readonly number[], step: number) => ({
  value: barIndex,
  barIndex,
  time: barIndex < times.length ? times[barIndex] : times[times.length - 1] + (barIndex - times.length + 1) * step,
});

export function label(l: Partial<PineLabelOutput> & Pick<PineLabelOutput, 'id' | 'x'>): PineLabelOutput {
  return {
    y: null,
    xloc: 'bar_index',
    yloc: 'price',
    text: '',
    color: PINE.blue,
    style: 'label_down',
    textColor: PINE.white,
    size: 'normal',
    sizePoints: 12,
    textAlign: 'center',
    tooltip: null,
    fontFamily: 'default',
    bold: false,
    italic: false,
    forceOverlay: false,
    createdBar: 0,
    ...l,
  };
}

export function cell(c: Partial<PineTableCellOutput> & Pick<PineTableCellOutput, 'column' | 'row'>): PineTableCellOutput {
  return {
    columnSpan: 1,
    rowSpan: 1,
    text: '',
    width: 0,
    height: 0,
    textColor: PINE.black,
    textHAlign: 'center',
    textVAlign: 'center',
    textSize: 'normal',
    textSizePoints: 14,
    bgColor: null,
    tooltip: null,
    fontFamily: 'default',
    bold: false,
    italic: false,
    ...c,
  };
}

export function emptyOutputs(times: number[], firstIndex = 0, timeframe = '60'): PineScriptOutputs {
  return {
    schemaVersion: 1,
    bars: { firstIndex, times, timeframe },
    plots: [],
    markers: [],
    candles: [],
    backgrounds: [],
    barColors: [],
    hlines: [],
    fills: [],
    labels: [],
    lines: [],
    boxes: [],
    polylines: [],
    linefills: [],
    tables: [],
    alertConditions: [],
    alerts: [],
    droppedAlerts: 0,
    logs: [],
    droppedLogs: 0,
  };
}

export const OVERLAY_STRATEGY_SOURCE = `//@version=6
strategy("EMA Cross Strategy", "EMA X", overlay = true)
fastLen = input.int(9, "Fast")
slowLen = input.int(21, "Slow")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
basis = ta.sma(close, 20)
dev = 2 * ta.stdev(close, 20)
up = ta.crossover(fast, slow)
dn = ta.crossunder(fast, slow)
if up
    strategy.entry("Long", strategy.long)
if dn
    strategy.entry("Short", strategy.short)
p1 = plot(fast, "EMA 9", fast > slow ? color.green : color.red, 2)
p2 = plot(slow, "EMA 21", color.orange, 2, trackprice = true)
fill(p1, p2, fast > slow ? color.new(color.green, 85) : color.new(color.red, 85))
plotshape(up, "Buy", shape.triangleup, location.belowbar, color.green, text = "Buy")
plotshape(dn, "Sell", shape.triangledown, location.abovebar, color.red, text = "Sell")
log.info("close={0} fast={1}", close, fast)
`;

// ── overlay strategy ─────────────────────────────────────────────────────────────────────────────

export function overlayStrategyFixture(n = 600, seed = 7): PineRunResult {
  const bars = generateBars(n, seed);
  const times = bars.map((b) => b.t);
  const step = 3_600_000;
  const close = bars.map((b) => b.c);
  const out = emptyOutputs(times);
  const fast = ema(close, 9);
  const slow = ema(close, 21);
  const basis = sma(close, 20);
  const dev = stdev(close, 20);
  const upper = basis.map((b, i) => (b === null || dev[i] === null ? null : b + 2 * dev[i]!));
  const lower = basis.map((b, i) => (b === null || dev[i] === null ? null : b - 2 * dev[i]!));
  const bull = fast.map((f, i) => f > slow[i]);
  const crossUp = bull.map((b, i) => i > 0 && b && !bull[i - 1]);
  const crossDn = bull.map((b, i) => i > 0 && !b && bull[i - 1]);
  let id = 0;

  // Plots — every style.
  out.plots.push(
    plot({ id: id++, title: 'EMA 9', values: fast, colors: bull.map((b) => (b ? PINE.green : PINE.red)), color: null, lineWidth: 2 }),
    plot({ id: id++, title: 'EMA 21', values: slow, color: PINE.orange, lineWidth: 2, trackPrice: true }),
    plot({ id: id++, title: 'Upper band', values: upper, color: tr(PINE.blue, 40), lineStyle: 'dotted', display: ['pane', 'data_window'] }),
    plot({ id: id++, title: 'Lower band', values: lower, color: tr(PINE.blue, 40), lineStyle: 'dotted', display: ['pane', 'data_window'] }),
  );
  // linebr: levels that hold for 6 bars, then 3 bars of na.
  const pivot = close.map((_, i) => (i % 9 < 6 ? round(bars[i - (i % 9)].h + 0.0008) : null));
  out.plots.push(plot({ id: id++, title: 'Pivot level', style: 'linebr', values: pivot, color: PINE.purple, lineWidth: 2 }));
  // stepline trailing stop.
  let trail = close[0];
  const trailing = close.map((c, i) => {
    trail = bull[i] ? Math.max(trail, c - 0.0025) : Math.min(trail, c + 0.0025);
    if (i > 0 && bull[i] !== bull[i - 1]) trail = bull[i] ? c - 0.0025 : c + 0.0025;
    return round(trail);
  });
  out.plots.push(
    plot({ id: id++, title: 'Trail stop', style: 'stepline', values: trailing, colors: bull.map((b) => (b ? PINE.teal : PINE.maroon)), color: null, lineWidth: 2 }),
    plot({ id: id++, title: 'Step diamonds', style: 'stepline_diamond', values: close.map((c, i) => round(Math.round(c * 400) / 400 + (i % 2 ? 0 : 0))), color: tr(PINE.navy, 30) }),
    plot({ id: id++, title: 'Swing (br)', style: 'steplinebr', values: close.map((c, i) => (i % 12 < 8 ? round(Math.floor(c * 200) / 200 - 0.002) : null)), color: PINE.fuchsia, lineWidth: 2 }),
    plot({ id: id++, title: 'Dots', style: 'circles', join: true, values: bars.map((b, i) => (i % 4 === 0 ? b.h + 0.0012 : null)), color: tr(PINE.aqua, 20), lineWidth: 2 }),
    plot({ id: id++, title: 'Body mid', style: 'cross', values: bars.map((b) => (b.c > b.o ? round((b.o + b.c) / 2) : null)), color: PINE.gray, lineWidth: 3 }),
    plot({ id: id++, title: 'SMA +8', values: basis, color: tr(PINE.yellow, 10), lineStyle: 'dashed', offset: 8 }),
    plot({ id: id++, title: 'Close -3', values: close, color: tr(PINE.silver, 30), offset: -3, display: ['pane'] }),
    plot({ id: id++, title: 'Last 40', values: close.map((c) => c + 0.003), color: PINE.olive, showLast: 40, lineWidth: 2 }),
    plot({ id: id++, title: 'Hidden', values: close, display: ['none'] }),
    plot({ id: id++, title: 'Data only', values: close.map((c, i) => round(c - bars[i].o)), display: ['data_window'] }),
  );
  const [pFast, pSlow, pUpper, pLower] = [0, 1, 2, 3];

  // Markers — buy/sell, then all 12 shapes across locations and sizes, chars, arrows.
  const at = (
    pred: (i: number) => boolean,
    value: (i: number) => number | null = () => 1,
    color: string = PINE.blue,
    textColor: string | null = null,
  ) =>
    bars
      .map((b, i) => ({ barIndex: i, time: b.t, value: value(i), color, textColor, direction: null }))
      .filter((p) => pred(p.barIndex));
  out.markers.push(
    marker({ id: id++, title: 'Buy', shape: 'triangleup', location: 'belowbar', size: 'small', text: 'Buy', points: at((i) => crossUp[i], () => 1, PINE.green) }),
    marker({ id: id++, title: 'Sell', shape: 'triangledown', location: 'abovebar', size: 'small', text: 'Sell', points: at((i) => crossDn[i], () => 1, PINE.red) }),
  );
  const shapes = ['xcross', 'cross', 'circle', 'triangleup', 'triangledown', 'flag', 'arrowup', 'arrowdown', 'labelup', 'labeldown', 'square', 'diamond'];
  const locations = ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'];
  const sizes = ['auto', 'tiny', 'small', 'normal', 'large', 'huge'];
  shapes.forEach((shape, k) => {
    const location = locations[k % locations.length];
    out.markers.push(
      marker({
        id: id++,
        title: `Shape ${shape}`,
        shape,
        location,
        size: sizes[k % sizes.length],
        text: k % 3 === 0 ? `S${k}` : shape.startsWith('label') ? shape : '',
        points: at(
          (i) => i % 41 === k + 3,
          (i) => (location === 'absolute' ? bars[i].h + 0.002 : 1),
          [PINE.blue, PINE.red, PINE.teal, PINE.orange, PINE.purple, PINE.fuchsia][k % 6],
          k % 2 ? PINE.black : null,
        ),
      }),
    );
  });
  out.markers.push(
    marker({ id: id++, title: 'Star', kind: 'char', char: '★', shape: null, location: 'abovebar', size: 'tiny', text: 'pivot', points: at((i) => i % 29 === 7, () => 1, PINE.orange) }),
    marker({ id: id++, title: 'Tri char', kind: 'char', char: '▲', shape: null, location: 'bottom', size: 'small', points: at((i) => i % 23 === 11, () => 1, PINE.teal) }),
    marker({
      id: id++,
      title: 'Body arrows',
      kind: 'arrow',
      shape: null,
      location: null,
      size: null,
      minHeight: 5,
      maxHeight: 40,
      points: bars
        .map((b, i) => ({ barIndex: i, time: b.t, value: round(b.c - b.o), color: b.c > b.o ? PINE.teal : PINE.orange, textColor: null, direction: b.c > b.o ? 'up' : 'down' }))
        .filter((p) => p.barIndex % 7 === 3 && p.value !== 0),
    }),
  );

  // bgcolor (London morning), barcolor (outsized bodies).
  const bg: PineColorSeriesOutput = {
    ...baseSeries,
    id: id++,
    title: 'London',
    colors: bars.map((b) => {
      const h = new Date(b.t).getUTCHours();
      return h >= 8 && h < 12 ? tr(PINE.blue, 92) : null;
    }),
  };
  out.backgrounds.push(bg);
  const avgBody = bars.reduce((s, b) => s + Math.abs(b.c - b.o), 0) / n;
  out.barColors.push({
    ...baseSeries,
    id: id++,
    title: 'Big bodies',
    colors: bars.map((b) => (Math.abs(b.c - b.o) > 2.2 * avgBody ? (b.c > b.o ? PINE.lime : PINE.fuchsia) : null)),
  });

  // hline + fills.
  const roundLevel = Math.round(close[n - 1] * 200) / 200;
  out.hlines.push({ id: 0, title: 'Round level', price: roundLevel, color: PINE.gray, lineStyle: 'dotted', lineWidth: 1, editable: true, display: ['all'] });
  out.fills.push(
    {
      id: 0,
      kind: 'plots',
      from: pFast,
      to: pSlow,
      title: 'Trend fill',
      editable: true,
      showLast: null,
      fillGaps: false,
      display: ['all'],
      color: null,
      colors: bull.map((b) => (b ? tr(PINE.green, 85) : tr(PINE.red, 85))),
      topValues: null,
      bottomValues: null,
      topColors: null,
      bottomColors: null,
    },
    {
      id: 1,
      kind: 'gradient',
      from: pUpper,
      to: pLower,
      title: 'Band gradient',
      editable: true,
      showLast: null,
      fillGaps: false,
      display: ['all'],
      color: null,
      colors: null,
      topValues: upper,
      bottomValues: lower,
      topColors: upper.map((u) => (u === null ? null : tr(PINE.green, 88))),
      bottomColors: lower.map((l) => (l === null ? null : tr(PINE.red, 88))),
    },
  );

  // Drawings sit relative to the last bar; `ix` keeps them on the data for short runs.
  const ix = (back: number) => Math.max(0, n - back);
  // Labels — every style.
  const labelStyles = [
    'label_down', 'label_up', 'label_left', 'label_right', 'label_lower_left', 'label_lower_right',
    'label_upper_left', 'label_upper_right', 'label_center', 'none', 'text_outline', 'xcross', 'cross',
    'triangleup', 'triangledown', 'flag', 'circle', 'arrowup', 'arrowdown', 'square', 'diamond',
  ];
  let did = 1;
  labelStyles.forEach((style, k) => {
    const bi = ix(230) + k * 10;
    if (bi < 0 || bi >= n) return;
    out.labels.push(
      label({
        id: did++,
        x: x(bi, times, step),
        y: round(bars[bi].h + 0.0015),
        text: style === 'none' || style === 'text_outline' ? `${style}\ntext only` : style,
        style,
        color: [PINE.blue, PINE.teal, PINE.purple, PINE.orange][k % 4],
        textColor: style === 'none' ? PINE.black : PINE.white,
        size: ['small', 'normal', 'large'][k % 3],
        sizePoints: [10, 12, 18][k % 3],
        tooltip: k % 2 === 0 ? `Label ${style} at bar ${bi}` : null,
        bold: k % 5 === 0,
        italic: k % 7 === 0,
        fontFamily: k % 4 === 3 ? 'monospace' : 'default',
        textAlign: (['left', 'center', 'right'] as const)[k % 3],
        createdBar: bi,
      }),
    );
  });
  out.labels.push(
    label({ id: did++, x: x(ix(12), times, step), yloc: 'abovebar', text: 'abovebar', style: 'label_down', color: PINE.red, createdBar: ix(12) }),
    label({ id: did++, x: x(ix(6), times, step), yloc: 'belowbar', text: 'belowbar', style: 'label_up', color: PINE.green, createdBar: ix(6) }),
    label({
      id: did++,
      x: { value: times[ix(20)], barIndex: ix(20), time: times[ix(20)] + 1_800_000 },
      xloc: 'bar_time',
      y: round(bars[ix(20)].l - 0.002),
      text: 'bar_time +30m',
      style: 'label_upper_left',
      color: tr(PINE.navy, 20),
      tooltip: 'xloc.bar_time half a bar after the open',
      createdBar: ix(20),
    }),
    label({ id: did++, x: x(n + 5, times, step), y: round(close[ix(1)]), text: 'future +5', style: 'label_left', color: PINE.gray, createdBar: ix(1) }),
  );

  // Lines: trend with extend right, arrows, dotted extend left, dashed support extend both.
  const l = (p: Partial<PineLineOutput> & Pick<PineLineOutput, 'x1' | 'x2' | 'y1' | 'y2'>): PineLineOutput => ({
    id: did++,
    xloc: 'bar_index',
    extend: 'none',
    color: PINE.blue,
    style: 'solid',
    width: 1,
    forceOverlay: false,
    createdBar: ix(1),
    ...p,
  });
  const lineA = l({ x1: x(ix(120), times, step), y1: bars[ix(120)].l, x2: x(ix(60), times, step), y2: bars[ix(60)].l, extend: 'right', color: PINE.teal, width: 2 });
  const lineB = l({ x1: x(ix(120), times, step), y1: bars[ix(120)].h, x2: x(ix(60), times, step), y2: bars[ix(60)].h, extend: 'right', color: PINE.maroon, width: 2 });
  out.lines.push(
    lineA,
    lineB,
    l({ x1: x(ix(90), times, step), y1: bars[ix(90)].h + 0.003, x2: x(ix(70), times, step), y2: bars[ix(70)].h + 0.003, style: 'arrow_both', color: PINE.purple, width: 2 }),
    l({ x1: x(ix(50), times, step), y1: bars[ix(50)].c, x2: x(ix(40), times, step), y2: bars[ix(40)].c, style: 'arrow_right', color: PINE.orange, width: 3 }),
    l({ x1: x(ix(45), times, step), y1: bars[ix(45)].c - 0.004, x2: x(ix(35), times, step), y2: bars[ix(35)].c - 0.004, style: 'dotted', extend: 'left', color: PINE.gray }),
    l({ x1: x(ix(30), times, step), y1: roundLevel - 0.005, x2: x(ix(29), times, step), y2: roundLevel - 0.005, style: 'dashed', extend: 'both', color: PINE.red, width: 1 }),
  );
  out.linefills.push({ id: did++, line1: lineA.id, line2: lineB.id, color: tr(PINE.aqua, 90) } as PineLinefillOutput);

  // Boxes.
  const box = (b: Partial<PineBoxOutput> & Pick<PineBoxOutput, 'left' | 'right' | 'top' | 'bottom'>): PineBoxOutput => ({
    id: did++,
    xloc: 'bar_index',
    borderColor: PINE.blue,
    borderWidth: 1,
    borderStyle: 'solid',
    extend: 'none',
    bgColor: tr(PINE.blue, 85),
    text: '',
    textSize: 'auto',
    textSizePoints: 0,
    textColor: PINE.black,
    textHAlign: 'center',
    textVAlign: 'center',
    textWrap: 'none',
    fontFamily: 'default',
    bold: false,
    italic: false,
    forceOverlay: false,
    createdBar: ix(1),
    ...b,
  });
  const hiOf = (a: number, b: number) => Math.max(...bars.slice(a, b + 1).map((q) => q.h));
  const loOf = (a: number, b: number) => Math.min(...bars.slice(a, b + 1).map((q) => q.l));
  out.boxes.push(
    box({ left: x(ix(160), times, step), right: x(ix(130), times, step), top: hiOf(ix(160), ix(130)), bottom: loOf(ix(160), ix(130)), text: 'Range box with wrapped text that is long enough to wrap inside the box', textWrap: 'auto', textVAlign: 'top', textHAlign: 'left', textSize: 'small', textSizePoints: 10, borderStyle: 'dashed' }),
    box({ left: x(ix(26), times, step), right: x(ix(18), times, step), top: hiOf(ix(26), ix(18)), bottom: loOf(ix(26), ix(18)), extend: 'right', bgColor: tr(PINE.orange, 88), borderColor: PINE.orange, text: 'extend.right', textHAlign: 'right', textVAlign: 'bottom', textSizePoints: 10, textSize: 'small', bold: true }),
    box({ left: x(ix(75), times, step), right: x(ix(66), times, step), top: hiOf(ix(75), ix(66)), bottom: loOf(ix(75), ix(66)), text: 'AUTO', bgColor: tr(PINE.purple, 80), borderColor: PINE.purple, borderWidth: 2, borderStyle: 'dotted', textColor: PINE.white, italic: true }),
  );

  // Polylines: zigzag through swing points (straight), a curved closed shape with fill.
  const zig: number[] = [];
  for (let i = ix(200); i < ix(10); i += 15) zig.push(i);
  out.polylines.push(
    {
      id: did++,
      points: zig.map((i, k) => ({ time: times[i], barIndex: i, price: k % 2 ? bars[i].h : bars[i].l })),
      curved: false,
      closed: false,
      xloc: 'bar_index',
      lineColor: PINE.blue,
      fillColor: null,
      lineStyle: 'solid',
      lineWidth: 2,
      forceOverlay: false,
      createdBar: ix(1),
    } as PinePolylineOutput,
    {
      id: did++,
      points: [0, 1, 2, 3, 4, 5].map((k) => {
        const i = ix(100) + Math.round(8 * Math.cos((k * Math.PI) / 3));
        return { time: times[i], barIndex: i, price: round(close[ix(100)] + 0.004 + 0.002 * Math.sin((k * Math.PI) / 3)) };
      }),
      curved: true,
      closed: true,
      xloc: 'bar_time',
      lineColor: PINE.fuchsia,
      fillColor: tr(PINE.fuchsia, 80),
      lineStyle: 'dashed',
      lineWidth: 2,
      forceOverlay: false,
      createdBar: ix(1),
    } as PinePolylineOutput,
  );

  // Trades from the crossovers (entry at the next bar's open), last one left open.
  const trades: PineReportTrade[] = [];
  let open: { dir: 'long' | 'short'; bar: number; price: number } | null = null;
  let cum = 0;
  for (let i = 1; i < ix(1); i++) {
    const flip = crossUp[i] ? 'long' : crossDn[i] ? 'short' : null;
    if (!flip) continue;
    const fillBar = i + 1;
    const price = bars[fillBar].o;
    if (open) {
      const profit = round((open.dir === 'long' ? price - open.price : open.price - price) * 100_000, 2);
      cum += profit;
      trades.push({
        number: trades.length + 1,
        isOpen: false,
        direction: open.dir,
        entryId: open.dir === 'long' ? 'Long' : 'Short',
        entrySignal: open.dir === 'long' ? 'Long' : 'Short',
        entryTime: times[open.bar],
        entryBarIndex: open.bar,
        entryPrice: open.price,
        exitId: flip === 'long' ? 'Long' : 'Short',
        exitSignal: flip === 'long' ? 'Long' : 'Short',
        exitTime: times[fillBar],
        exitBarIndex: fillBar,
        exitPrice: price,
        qty: 1,
        profit,
        profitPercent: round((profit / (open.price * 100_000)) * 100, 3),
        cumulativeProfit: round(cum, 2),
      });
    }
    open = { dir: flip, bar: fillBar, price };
  }
  if (open) {
    const last = close[ix(1)];
    const profit = round((open.dir === 'long' ? last - open.price : open.price - last) * 100_000, 2);
    trades.push({
      number: trades.length + 1,
      isOpen: true,
      direction: open.dir,
      entryId: open.dir === 'long' ? 'Long' : 'Short',
      entrySignal: open.dir === 'long' ? 'Long' : 'Short',
      entryTime: times[open.bar],
      entryBarIndex: open.bar,
      entryPrice: open.price,
      qty: 1,
      profit,
      profitPercent: round((profit / (open.price * 100_000)) * 100, 3),
    });
  }

  // Tables: stats (top_right, merged header), heat strip (bottom_left).
  const wins = trades.filter((t) => !t.isOpen && t.profit > 0).length;
  const closed = trades.filter((t) => !t.isOpen).length;
  out.tables.push(
    {
      id: did++,
      position: 'top_right',
      columns: 2,
      rows: 4,
      bgColor: tr(PINE.white, 10),
      frameColor: PINE.gray,
      frameWidth: 1,
      borderColor: tr(PINE.gray, 50),
      borderWidth: 1,
      forceOverlay: false,
      cells: [
        cell({ column: 0, row: 0, columnSpan: 2, text: 'EMA X · stats', bold: true, bgColor: PINE.blue, textColor: PINE.white }),
        cell({ column: 0, row: 1, text: 'Net P/L', textHAlign: 'left', textSizePoints: 10, textSize: 'small' }),
        cell({ column: 1, row: 1, text: `${cum.toFixed(2)} USD`, bgColor: cum >= 0 ? tr(PINE.green, 70) : tr(PINE.red, 70), textSizePoints: 10, textSize: 'small', tooltip: 'Closed-trade net profit' }),
        cell({ column: 0, row: 2, text: 'Win rate', textHAlign: 'left', textSizePoints: 10, textSize: 'small' }),
        cell({ column: 1, row: 2, text: closed ? `${((wins / closed) * 100).toFixed(1)}%` : '—', textSizePoints: 10, textSize: 'small' }),
        cell({ column: 0, row: 3, text: 'Trades', textHAlign: 'left', textSizePoints: 10, textSize: 'small', italic: true }),
        cell({ column: 1, row: 3, text: String(trades.length), fontFamily: 'monospace', textSizePoints: 10, textSize: 'small' }),
      ],
    },
    {
      id: did++,
      position: 'bottom_left',
      columns: 10,
      rows: 1,
      bgColor: null,
      frameColor: null,
      frameWidth: 0,
      borderColor: null,
      borderWidth: 0,
      forceOverlay: false,
      cells: Array.from({ length: 10 }, (_, k) =>
        cell({ column: k, row: 0, text: ' ', bgColor: close[ix(1)] > close[Math.max(0, ix(1) - (k + 1) * 5)] ? tr(PINE.green, k * 9) : tr(PINE.red, k * 9), tooltip: `vs ${(k + 1) * 5} bars ago` }),
      ),
    },
  );

  // Logs, alerts.
  out.logs = logsFor(bars, fast);
  out.alertConditions.push({ id: 0, title: 'Cross up', message: 'EMA cross up on {{ticker}} at {{close}}' });
  out.alerts = bars
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => crossUp[i])
    .map(({ b, i }): PineAlertEventOutput => ({
      source: 'alertcondition',
      conditionId: 0,
      title: 'Cross up',
      message: `EMA cross up on EURUSD at ${b.c}`,
      frequency: null,
      barIndex: i,
      barTime: b.t,
      time: b.t + 3_599_000,
      isRealtime: false,
      isConfirmed: true,
    }));

  return {
    compile: {
      success: true,
      diagnostics: [],
      declaration: { kind: 'strategy', title: 'EMA Cross Strategy', shortTitle: 'EMA X', overlay: true, format: 'inherit', precision: null },
    },
    bars,
    outputs: out,
    report: { meta: { symbol: 'EURUSD', timeframe: '60', accountCurrency: 'USD', initialCapital: 10_000 }, trades },
    trace: traceFor(bars, fast, slow, n - 60, n - 1),
    profile: profileFor(),
    runtimeError: null,
    elapsedMs: 184,
  };
}

function logsFor(bars: readonly PineBar[], fast: readonly number[]): PineLogOutput[] {
  const logs: PineLogOutput[] = [];
  bars.forEach((b, i) => {
    if (i % 5 === 0) logs.push({ level: 'info', message: `close=${b.c} fast=${fast[i].toFixed(5)}`, barIndex: i, time: b.t, isRealtime: false, line: 20 });
    if (i % 37 === 0) logs.push({ level: 'warning', message: `Wide bar: range ${(b.h - b.l).toFixed(5)}\nhigh=${b.h}\nlow=${b.l}`, barIndex: i, time: b.t, isRealtime: false, line: 21 });
    if (i % 111 === 0 && i > 0) logs.push({ level: 'error', message: `Order rejected: insufficient margin at bar ${i}`, barIndex: i, time: b.t, isRealtime: false, line: null });
  });
  return logs;
}

function traceFor(bars: readonly PineBar[], fast: readonly number[], slow: readonly number[], from: number, to: number): PineTraceBar[] {
  const out: PineTraceBar[] = [];
  for (let i = Math.max(1, from); i <= to; i++) {
    const up = fast[i] > slow[i] && fast[i - 1] <= slow[i - 1];
    const dn = fast[i] < slow[i] && fast[i - 1] >= slow[i - 1];
    out.push({
      bar: i,
      timeMs: bars[i].t,
      items: [
        { line: 5, column: 8, endLine: 5, endColumn: 30, text: 'ta.ema(close, fastLen)', value: fast[i].toFixed(5) },
        { line: 6, column: 8, endLine: 6, endColumn: 30, text: 'ta.ema(close, slowLen)', value: slow[i].toFixed(5) },
        { line: 9, column: 6, endLine: 9, endColumn: 30, text: 'ta.crossover(fast, slow)', value: String(up) },
        { line: 10, column: 6, endLine: 10, endColumn: 31, text: 'ta.crossunder(fast, slow)', value: String(dn) },
        { line: 15, column: 30, endLine: 15, endColumn: 41, text: 'fast > slow', value: String(fast[i] > slow[i]) },
        { line: 8, column: 7, endLine: 8, endColumn: 29, text: '2 * ta.stdev(close, 20)', value: i < 20 ? 'na' : '0.00312' },
      ],
    });
  }
  return out;
}

function profileFor(): PineProfileLine[] {
  return [
    { line: 5, executions: 600, totalMicros: 812 },
    { line: 6, executions: 600, totalMicros: 790 },
    { line: 7, executions: 600, totalMicros: 1210 },
    { line: 8, executions: 600, totalMicros: 4200 },
    { line: 9, executions: 600, totalMicros: 350 },
    { line: 10, executions: 600, totalMicros: 342 },
    { line: 11, executions: 600, totalMicros: 40 },
    { line: 12, executions: 23, totalMicros: 690 },
    { line: 13, executions: 600, totalMicros: 38 },
    { line: 14, executions: 22, totalMicros: 655 },
    { line: 15, executions: 600, totalMicros: 1480 },
    { line: 16, executions: 600, totalMicros: 1320 },
    { line: 17, executions: 600, totalMicros: 980 },
    { line: 20, executions: 120, totalMicros: 2600 },
  ];
}

// ── non-overlay indicator ────────────────────────────────────────────────────────────────────────

export const PANE_INDICATOR_SOURCE = `//@version=6
indicator("RSI Workbench", "RSI+", overlay = false, precision = 2)
r = ta.rsi(close, 14)
ma = ta.sma(r, 9)
plot(r, "RSI", r > 70 ? color.red : r < 30 ? color.green : color.purple, 2)
plot(ma, "RSI MA", color.yellow)
h70 = hline(70, "Overbought", color.red)
h30 = hline(30, "Oversold", color.green)
hline(50, "Mid", color.gray, hline.linestyle_dotted)
fill(h70, h30, color.new(color.purple, 92))
plot(close, "SMA 50", color.blue, force_overlay = true)
`;

export function paneIndicatorFixture(n = 500, seed = 11): PineRunResult {
  const bars = generateBars(n, seed);
  const times = bars.map((b) => b.t);
  const step = 3_600_000;
  const close = bars.map((b) => b.c);
  const out = emptyOutputs(times);
  const r = rsi(close, 14);
  const rNum = r.map((v) => v ?? 50);
  const ma = sma(rNum, 9);
  let id = 0;
  out.plots.push(
    plot({ id: id++, title: 'RSI', values: r, colors: r.map((v) => (v === null ? null : v > 70 ? PINE.red : v < 30 ? PINE.green : PINE.purple)), color: null, lineWidth: 2, precision: 2 }),
    plot({ id: id++, title: 'RSI MA', values: ma.map((v, i) => (r[i] === null ? null : v)), color: PINE.yellow, precision: 2 }),
    plot({ id: id++, title: 'Momentum', style: 'histogram', lineWidth: 3, histBase: 50, values: r.map((v, i) => (v === null ? null : 50 + (v - (ma[i] ?? 50)) * 2)), colors: r.map((v, i) => (v === null ? null : v >= (ma[i] ?? 50) ? tr(PINE.teal, 20) : tr(PINE.red, 20))), color: null, precision: 2 }),
    plot({ id: id++, title: 'Volume', style: 'columns', values: bars.map((b) => b.v / 100), colors: bars.map((b) => (b.c >= b.o ? tr(PINE.teal, 70) : tr(PINE.red, 70))), color: null, format: 'volume', display: ['pane', 'data_window'] }),
    plot({ id: id++, title: 'Smoothed', style: 'area', histBase: 50, values: ema(rNum, 20).map((v, i) => (i < 20 ? null : v)), color: tr(PINE.teal, 80), precision: 2 }),
    plot({ id: id++, title: 'Zone', style: 'areabr', histBase: 50, values: r.map((v) => (v !== null && (v > 60 || v < 40) ? v : null)), color: tr(PINE.orange, 70), precision: 2 }),
    plot({ id: id++, title: 'SMA 50', values: sma(close, 50), color: PINE.blue, lineWidth: 2, forceOverlay: true }),
    plot({ id: id++, title: 'Hidden RSI', values: r, display: ['none'] }),
    plot({ id: id++, title: 'Status only', values: r.map((v) => (v === null ? null : 100 - v)), display: ['status_line'], precision: 1 }),
    plot({ id: id++, title: 'Scale only', values: r.map((v) => (v === null ? null : v / 2)), display: ['price_scale'], color: PINE.gray }),
  );

  // plotbar of RSI OHLC in the pane; Heikin-Ashi plotcandle forced onto the price pane.
  const barOut: PineCandleOutput = {
    ...baseSeries,
    id: id++,
    title: 'RSI bars',
    plotNumber: 100,
    kind: 'bar',
    format: null,
    precision: 2,
    open: r.map((v, i) => (v === null || i === 0 || r[i - 1] === null ? null : r[i - 1])),
    high: r.map((v, i) => (v === null || i === 0 || r[i - 1] === null ? null : Math.max(v, r[i - 1]!) + 1)),
    low: r.map((v, i) => (v === null || i === 0 || r[i - 1] === null ? null : Math.min(v, r[i - 1]!) - 1)),
    close: r,
    color: null,
    colors: r.map((v, i) => (v === null || i === 0 ? null : v >= (r[i - 1] ?? v) ? PINE.teal : PINE.red)),
    wickColors: null,
    borderColors: null,
    display: ['data_window'],
  };
  const ha: { o: number; h: number; l: number; c: number }[] = [];
  bars.forEach((b, i) => {
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = i === 0 ? (b.o + b.c) / 2 : (ha[i - 1].o + ha[i - 1].c) / 2;
    ha.push({ o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c) });
  });
  const haOut: PineCandleOutput = {
    ...baseSeries,
    id: id++,
    title: 'Heikin-Ashi',
    plotNumber: 104,
    kind: 'candle',
    format: null,
    precision: null,
    open: ha.map((h, i) => (i >= n - 80 ? round(h.o) : null)),
    high: ha.map((h, i) => (i >= n - 80 ? round(h.h) : null)),
    low: ha.map((h, i) => (i >= n - 80 ? round(h.l) : null)),
    close: ha.map((h, i) => (i >= n - 80 ? round(h.c) : null)),
    color: null,
    colors: ha.map((h) => (h.c >= h.o ? tr(PINE.teal, 40) : tr(PINE.red, 40))),
    wickColors: ha.map(() => null),
    borderColors: ha.map((h) => (h.c >= h.o ? PINE.teal : PINE.red)),
    forceOverlay: true,
  };
  out.candles.push(barOut, haOut);

  out.markers.push(
    marker({ id: id++, title: 'OB', shape: 'circle', location: 'top', size: 'tiny', points: bars.map((b, i) => ({ barIndex: i, time: b.t, value: 1, color: PINE.red, textColor: null, direction: null })).filter((p) => (r[p.barIndex] ?? 0) > 70) }),
    marker({ id: id++, title: 'OS', shape: 'diamond', location: 'bottom', size: 'tiny', text: 'OS', points: bars.map((b, i) => ({ barIndex: i, time: b.t, value: 1, color: PINE.green, textColor: PINE.green, direction: null })).filter((p) => (r[p.barIndex] ?? 100) < 30) }),
    marker({
      id: id++,
      title: 'RSI change',
      kind: 'arrow',
      shape: null,
      location: null,
      size: null,
      minHeight: 4,
      maxHeight: 24,
      points: bars
        .map((b, i) => {
          const d = i > 0 && r[i] !== null && r[i - 1] !== null ? r[i]! - r[i - 1]! : 0;
          return { barIndex: i, time: b.t, value: round(d, 2), color: d > 0 ? PINE.teal : PINE.orange, textColor: null, direction: d > 0 ? 'up' : 'down' };
        })
        .filter((p) => p.barIndex % 11 === 0 && p.value !== 0),
    }),
  );
  out.backgrounds.push({ ...baseSeries, id: id++, title: 'Overbought bg', colors: r.map((v) => (v !== null && v > 70 ? tr(PINE.red, 90) : null)) });

  const h70: PineHlineOutput = { id: 0, title: 'Overbought', price: 70, color: PINE.red, lineStyle: 'dashed', lineWidth: 1, editable: true, display: ['all'] };
  const h30: PineHlineOutput = { id: 1, title: 'Oversold', price: 30, color: PINE.green, lineStyle: 'dashed', lineWidth: 1, editable: true, display: ['all'] };
  const h50: PineHlineOutput = { id: 2, title: 'Mid', price: 50, color: PINE.gray, lineStyle: 'dotted', lineWidth: 1, editable: true, display: ['all'] };
  out.hlines.push(h70, h30, h50);
  out.fills.push({
    id: 0,
    kind: 'hlines',
    from: 0,
    to: 1,
    title: 'Band',
    editable: true,
    showLast: null,
    fillGaps: false,
    display: ['all'],
    color: tr(PINE.purple, 92),
    colors: null,
    topValues: null,
    bottomValues: null,
    topColors: null,
    bottomColors: null,
  } as PineFillOutput);

  let did = 1;
  const last = n - 1;
  out.labels.push(
    label({ id: did++, x: x(last, times, step), y: r[last] ?? 50, text: `RSI ${(r[last] ?? 0).toFixed(1)}`, style: 'label_left', color: PINE.purple, createdBar: last }),
    label({ id: did++, x: x(last - 30, times, step), y: round(bars[last - 30].h + 0.001), text: 'force_overlay', style: 'label_down', color: PINE.orange, forceOverlay: true, tooltip: 'Drawn by a non-overlay script on the price pane', createdBar: last - 30 }),
  );
  out.tables.push(
    {
      id: did++,
      position: 'middle_right',
      columns: 3,
      rows: 3,
      bgColor: tr(PINE.black, 20),
      frameColor: PINE.purple,
      frameWidth: 2,
      borderColor: tr(PINE.white, 70),
      borderWidth: 1,
      forceOverlay: false,
      cells: [
        cell({ column: 0, row: 0, columnSpan: 3, text: 'RSI zones', textColor: PINE.white, bold: true }),
        cell({ column: 0, row: 1, rowSpan: 2, text: 'Now', textColor: PINE.white, textVAlign: 'center' }),
        cell({ column: 1, row: 1, text: (r[last] ?? 0).toFixed(2), textColor: PINE.white, fontFamily: 'monospace', tooltip: 'RSI on the last bar' }),
        cell({ column: 2, row: 1, text: (r[last] ?? 0) > 50 ? 'Bull' : 'Bear', textColor: PINE.white, bgColor: (r[last] ?? 0) > 50 ? tr(PINE.teal, 30) : tr(PINE.red, 30) }),
        cell({ column: 1, row: 2, text: 'MA', textColor: PINE.white, textSizePoints: 10, textSize: 'small' }),
        cell({ column: 2, row: 2, text: (ma[last] ?? 0).toFixed(2), textColor: PINE.white, textSizePoints: 10, textSize: 'small', italic: true }),
      ],
    },
    {
      id: did++,
      position: 'top_center',
      columns: 1,
      rows: 1,
      bgColor: tr(PINE.yellow, 60),
      frameColor: null,
      frameWidth: 0,
      borderColor: null,
      borderWidth: 0,
      forceOverlay: true,
      cells: [cell({ column: 0, row: 0, text: 'Table with width 18% × height 6% of the pane', width: 18, height: 6, textSizePoints: 10, textSize: 'small' })],
    } as PineTableOutput,
  );
  out.logs = [
    { level: 'info', message: 'RSI Workbench started', barIndex: 0, time: times[0], isRealtime: false, line: 3 },
    ...bars
      .map((b, i) => ({ b, i }))
      .filter(({ i }) => r[i] !== null && (r[i]! > 75 || r[i]! < 25))
      .map(({ b, i }): PineLogOutput => ({ level: r[i]! > 75 ? 'warning' : 'info', message: `Extreme RSI ${r[i]!.toFixed(2)}`, barIndex: i, time: b.t, isRealtime: false, line: 5 })),
    { level: 'error', message: 'Division by zero in ta.rsi()', barIndex: n - 42, time: times[n - 42], isRealtime: false, line: 12 },
  ];
  return {
    compile: {
      success: true,
      diagnostics: [],
      declaration: { kind: 'indicator', title: 'RSI Workbench', shortTitle: 'RSI+', overlay: false, format: 'inherit', precision: 2 },
    },
    bars,
    outputs: out,
    report: null,
    trace: [],
    profile: [
      { line: 3, executions: n, totalMicros: 2100 },
      { line: 4, executions: n, totalMicros: 760 },
      { line: 5, executions: n, totalMicros: 1400 },
      { line: 6, executions: n, totalMicros: 520 },
    ],
    runtimeError: { code: 'PS5003', message: 'Division by zero in ta.rsi()', line: 12, column: 5, barIndex: n - 42 },
    elapsedMs: 96,
  };
}

// ── performance ──────────────────────────────────────────────────────────────────────────────────

/** `bars` bars with `plots` per-bar-colored plots of mixed styles, markers, bgcolor and 10k logs. */
export function largeFixture(bars = 20_000, plots = 40, seed = 3): PineRunResult {
  const b = generateBars(bars, seed);
  const times = b.map((q) => q.t);
  const close = b.map((q) => q.c);
  const out = emptyOutputs(times);
  // Overlay-friendly styles (an area or columns plot fills down to its histbase, which on a price
  // chart is a wall of color, exactly as it would be in Pine).
  const styles = ['line', 'linebr', 'stepline', 'steplinebr', 'circles', 'cross', 'stepline_diamond', 'line'];
  for (let k = 0; k < plots; k++) {
    const len = 5 + k * 3;
    const e = ema(close, len);
    const style = styles[k % styles.length];
    out.plots.push(
      plot({
        id: k,
        title: `EMA ${len}`,
        style,
        values: style === 'linebr' ? e.map((v, i) => (i % 10 < 7 ? v : null)) : e,
        colors: e.map((v, i) => (v >= close[i] ? PINE.red : PINE.teal)),
        color: null,
      }),
    );
  }
  out.markers.push(
    marker({ id: plots, title: 'Every 50', shape: 'triangleup', location: 'belowbar', points: b.map((q, i) => ({ barIndex: i, time: q.t, value: 1, color: PINE.green, textColor: null, direction: null })).filter((p) => p.barIndex % 50 === 0) }),
  );
  out.backgrounds.push({ ...baseSeries, id: plots + 1, title: 'Stripes', colors: b.map((_, i) => (Math.floor(i / 100) % 2 ? tr(PINE.gray, 94) : null)) });
  out.logs = b.filter((_, i) => i % 2 === 0).slice(-10_000).map((q, i) => ({ level: i % 97 === 0 ? 'warning' : 'info', message: `bar ${i * 2} close ${q.c}`, barIndex: i * 2, time: q.t, isRealtime: false, line: 4 }));
  return {
    compile: { success: true, diagnostics: [], declaration: { kind: 'indicator', title: `${plots} EMAs`, shortTitle: null, overlay: true, format: 'inherit', precision: null } },
    bars: b,
    outputs: out,
    report: null,
    trace: [],
    profile: [],
    runtimeError: null,
    elapsedMs: 1200,
  };
}
