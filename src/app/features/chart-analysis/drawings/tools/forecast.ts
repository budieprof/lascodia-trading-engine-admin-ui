import type { PaintCtx } from '../paint-ctx';
import { distanceToSegment, type Pt } from '../geometry';
import type { Drawing, DrawingPoint } from '../model';
import type { ToolBehavior, ToolBehaviorMap, ToolOption } from './types';
import {
  TV_BLUE,
  TV_GREEN,
  TV_GREY,
  TV_RED,
  arrow,
  axisOf,
  inRect,
  labelBox,
  rgba,
  strokeLine,
  type Axis,
} from './forecast-draw';
import {
  anchoredVwap,
  barIndexAt,
  barsBetween,
  dateRangeText,
  defaultPositionLevels,
  forecastOutcome,
  formatAmount,
  formatTicks,
  formatVolume,
  ghostCandles,
  positionOutcome,
  positionPnl,
  positionStats,
  priceRangeText,
  resolutionMs,
  tickSize,
  volumeBetween,
  volumeProfileRows,
  type OhlcvBar,
  type VwapSource,
} from './forecast-math';

/**
 * TradingView rail family "Forecasting and measurement tools" plus the
 * standalone measure ruler. See RAIL_LAYOUT in ../model.ts.
 *
 *   Forecasting   long-position, short-position, forecast, bars-pattern, ghost-feed, projection
 *   Volume-based  anchored-vwap, fixed-range-volume-profile, anchored-volume-profile
 *   Measurers     price-range, date-range, measure (Date and price range)
 *   Rail          ruler (transient Date and price range)
 */

type Ctx = PaintCtx & { options: Record<string, unknown> };
type PaintArgs = Ctx & { selected: boolean };

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = Number(o[k]);
  return o[k] !== undefined && o[k] !== null && Number.isFinite(v) ? v : d;
};
const bool = (o: Record<string, unknown>, k: string, d: boolean): boolean =>
  typeof o[k] === 'boolean' ? (o[k] as boolean) : d;
const str = (o: Record<string, unknown>, k: string, d: string): string =>
  typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : d;

/**
 * Model anchors matching `pts`, including the preview cursor (an extra screen
 * point with no model anchor yet), which is converted back through the axis.
 */
function anchorsOf(p: PaintCtx, axis: Axis | null): DrawingPoint[] {
  const out = p.drawing.points.slice(0, p.pts.length).map((pt) => ({ ...pt }));
  for (let i = out.length; i < p.pts.length; i++) {
    const s = p.pts[i];
    const price = p.priceAt(s.y);
    let time = p.timeAt?.(s.x) ?? null;
    if (time === null && axis && out.length) {
      const ref = p.drawing.points[0];
      time = ref.time + ((s.x - p.pts[0].x) / axis.spacing) * axis.interval;
    }
    if (price === null || time === null) continue;
    out.push({ time, price });
  }
  return out;
}

function barsOf(p: PaintCtx): readonly OhlcvBar[] {
  return (p.bars ?? []) as readonly OhlcvBar[];
}

// ── Long / Short position ─────────────────────────────────────────────────

const POSITION_OPTIONS: readonly ToolOption[] = [
  { key: 'accountSize', label: 'Account size', type: 'number', default: 1000, min: 0 },
  { key: 'lotSize', label: 'Lot size', type: 'number', default: 1, min: 0 },
  { key: 'risk', label: 'Risk', type: 'number', default: 25, min: 0 },
  { key: 'riskUnit', label: 'Risk unit', type: 'select', default: '%', choices: ['%', 'money'] },
  { key: 'leverage', label: 'Leverage', type: 'number', default: 1, min: 0 },
  { key: 'qtyPrecision', label: 'Qty precision', type: 'number', default: 2, min: 0, max: 8, step: 1 },
  { key: 'lineColor', label: 'Lines', type: 'color', default: TV_GREY },
  { key: 'targetColor', label: 'Target color', type: 'color', default: TV_GREEN },
  { key: 'stopColor', label: 'Stop color', type: 'color', default: TV_RED },
  { key: 'textColor', label: 'Text', type: 'color', default: '#FFFFFF', tab: 'text' },
  { key: 'compactStats', label: 'Compact stats mode', type: 'bool', default: false },
  { key: 'alwaysShowStats', label: 'Always show stats', type: 'bool', default: false },
  { key: 'showPriceLabels', label: 'Price labels', type: 'bool', default: true },
];

export interface PositionLevels {
  entry: DrawingPoint;
  target: number;
  stop: number;
  end: number;
}

/**
 * Entry, target, stop and right edge of a position. A one-click position has
 * only its entry stored; TradingView's default target/stop/width are derived
 * until the first handle drag materialises them as anchors 1 and 2
 * (`{time: end, price: target}`, `{time: end, price: stop}`).
 */
export function positionLevels(d: Drawing, side: 'long' | 'short'): PositionLevels {
  const entry = d.points[0];
  if (d.points.length >= 3) {
    return { entry, target: d.points[1].price, stop: d.points[2].price, end: d.points[1].time };
  }
  const interval = resolutionMs(d.resolution) ?? 3_600_000;
  const def = defaultPositionLevels(side, entry.price, entry.time, interval);
  return { entry, target: def.target, stop: def.stop, end: def.end };
}

/** The points a one-click position should be committed with (for a creation hook). */
export function completePositionPoints(d: Drawing, side: 'long' | 'short'): DrawingPoint[] {
  const l = positionLevels(d, side);
  return [l.entry, { time: l.end, price: l.target }, { time: l.end, price: l.stop }];
}

interface PositionGeo {
  x0: number;
  x1: number;
  yEntry: number;
  yTarget: number;
  yStop: number;
  levels: PositionLevels;
  axis: Axis;
}

function positionGeo(p: PaintCtx, side: 'long' | 'short'): PositionGeo | null {
  const axis = axisOf(p);
  if (!axis || p.pts.length === 0 || p.drawing.points.length === 0) return null;
  const levels = positionLevels(p.drawing, side);
  const yTarget = axis.yOf(levels.target);
  const yStop = axis.yOf(levels.stop);
  if (yTarget === null || yStop === null) return null;
  const x0 = p.pts[0].x;
  const x1 = Math.max(x0 + 4, axis.xOf(levels.end));
  return { x0, x1, yEntry: p.pts[0].y, yTarget, yStop, levels, axis };
}

function positionBehavior(side: 'long' | 'short'): ToolBehavior {
  const dir = side === 'long' ? 1 : -1;
  return {
    points: 1,
    defaultStyle: { color: TV_GREY, width: 1, fill: null, showLabels: true },
    options: POSITION_OPTIONS,

    paint(p: PaintArgs) {
      const g = positionGeo(p, side);
      if (!g) return;
      const { ctx, options: o, precision } = p;
      const { x0, x1, yEntry, yTarget, yStop, levels } = g;
      const targetColor = str(o, 'targetColor', TV_GREEN);
      const stopColor = str(o, 'stopColor', TV_RED);
      const lineColor = str(o, 'lineColor', TV_GREY);
      const lot = num(o, 'lotSize', 1);
      const w = x1 - x0;

      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = rgba(targetColor, 0.2);
      ctx.fillRect(x0, Math.min(yEntry, yTarget), w, Math.abs(yTarget - yEntry));
      ctx.fillStyle = rgba(stopColor, 0.2);
      ctx.fillRect(x0, Math.min(yEntry, yStop), w, Math.abs(yStop - yEntry));

      const stats = positionStats({
        side,
        entry: levels.entry.price,
        target: levels.target,
        stop: levels.stop,
        accountSize: num(o, 'accountSize', 1000),
        lotSize: lot,
        risk: num(o, 'risk', 25),
        riskUnit: str(o, 'riskUnit', '%') === 'money' ? 'money' : '%',
        leverage: num(o, 'leverage', 1),
        qtyPrecision: num(o, 'qtyPrecision', 2),
      });

      // Trade path: from the entry to where it closed (or the last bar), shaded by result.
      const outcome = positionOutcome(
        barsOf(p),
        side,
        levels.entry.price,
        levels.target,
        levels.stop,
        levels.entry.time,
        levels.end,
      );
      let pnl = 0;
      let closed = false;
      if (outcome.state !== 'pending') {
        const xo = Math.min(x1, g.axis.xOf(outcome.time));
        const yo = g.axis.yOf(outcome.price);
        pnl = positionPnl(side, levels.entry.price, outcome.price, stats.qty, lot);
        closed = outcome.state === 'target' || outcome.state === 'stop';
        if (yo !== null && xo > x0) {
          ctx.fillStyle = rgba(pnl >= 0 ? targetColor : stopColor, 0.25);
          ctx.fillRect(x0, Math.min(yEntry, yo), xo - x0, Math.abs(yo - yEntry));
          ctx.strokeStyle = lineColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          strokeLine(ctx, { x: x0, y: yEntry }, { x: xo, y: yo });
          ctx.setLineDash([]);
        }
      }

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = p.drawing.style.width;
      strokeLine(ctx, { x: x0, y: yEntry }, { x: x1, y: yEntry });

      if (bool(o, 'showPriceLabels', true) && (p.selected || bool(o, 'alwaysShowStats', false))) {
        const tag = (y: number, price: number, color: string) =>
          labelBox(ctx, [price.toFixed(precision)], { x: x1 + 34, y }, { bg: color });
        tag(yTarget, levels.target, targetColor);
        tag(yEntry, levels.entry.price, lineColor);
        tag(yStop, levels.stop, stopColor);
      }

      if (p.drawing.style.showLabels && (p.selected || bool(o, 'alwaysShowStats', false))) {
        const fg = str(o, 'textColor', '#FFFFFF');
        const cx = x0 + w / 2;
        const compact = bool(o, 'compactStats', false);
        const tTicks = formatTicks(stats.targetDelta, precision);
        const sTicks = formatTicks(stats.stopDelta, precision);
        const tCore = `${stats.targetDelta.toFixed(precision)} (${stats.targetPct.toFixed(2)}%) ${tTicks}`;
        const sCore = `${stats.stopDelta.toFixed(precision)} (${stats.stopPct.toFixed(2)}%) ${sTicks}`;
        const tLine = compact
          ? `${tCore}, ${formatAmount(stats.targetAmount)}`
          : `Target: ${tCore}, Amount: ${formatAmount(stats.targetAmount)}`;
        const sLine = compact
          ? `${sCore}, ${formatAmount(stats.stopAmount)}`
          : `Stop: ${sCore}, Amount: ${formatAmount(stats.stopAmount)}`;
        const centre = compact
          ? [`${formatAmount(pnl)}, ${formatAmount(stats.qty)}`, stats.rr.toFixed(2)]
          : [
              `${closed ? 'Closed' : 'Open'} P&L: ${formatAmount(pnl)}, Qty: ${formatAmount(stats.qty)}`,
              `Risk/Reward Ratio: ${stats.rr.toFixed(2)}`,
            ];
        const tEdge = dir > 0 ? Math.min(yTarget, yEntry) - 4 : Math.max(yTarget, yEntry) + 4;
        const sEdge = dir > 0 ? Math.max(yStop, yEntry) + 4 : Math.min(yStop, yEntry) - 4;
        labelBox(ctx, [tLine], { x: cx, y: tEdge }, { bg: targetColor, fg, align: dir > 0 ? 'above' : 'below' });
        labelBox(ctx, [sLine], { x: cx, y: sEdge }, { bg: stopColor, fg, align: dir > 0 ? 'below' : 'above' });
        labelBox(ctx, centre, { x: cx, y: yEntry }, { bg: pnl > 0 ? targetColor : pnl < 0 ? stopColor : TV_GREY, fg });
      }
      ctx.restore();
    },

    /** 0 entry (left, entry line), 1 target, 2 stop (left corners), 3 width (right, entry line). */
    handles(p: Ctx) {
      const g = positionGeo(p, side);
      if (!g) return p.pts;
      return [
        { x: g.x0, y: g.yEntry },
        { x: g.x0, y: g.yTarget },
        { x: g.x0, y: g.yStop },
        { x: g.x1, y: g.yEntry },
      ];
    },

    moveHandle(d: Drawing, index: number, to: DrawingPoint): DrawingPoint[] {
      return movePositionHandle(d, side, index, to);
    },

    hitTest(p: Ctx, at: Pt, tol: number) {
      const g = positionGeo(p, side);
      if (!g) return false;
      return inRect(at, g.x0, Math.min(g.yTarget, g.yStop), g.x1, Math.max(g.yTarget, g.yStop), tol);
    },
  };
}

/** Handle drags: each handle changes only its own value, as on TradingView. */
export function movePositionHandle(
  d: Drawing,
  side: 'long' | 'short',
  index: number,
  to: DrawingPoint,
): DrawingPoint[] {
  const dir = side === 'long' ? 1 : -1;
  const l = positionLevels(d, side);
  let { entry, target, stop, end } = l;
  if (index === 0) {
    entry = { time: to.time, price: to.price };
    // The zones stay on their side of the entry, as TradingView clamps them.
    if ((target - entry.price) * dir <= 0) target = entry.price + (l.target - l.entry.price);
    if ((entry.price - stop) * dir <= 0) stop = entry.price - (l.entry.price - l.stop);
    if (end <= entry.time) end = entry.time + (l.end - l.entry.time);
  } else if (index === 1) {
    if ((to.price - entry.price) * dir > 0) target = to.price;
  } else if (index === 2) {
    if ((entry.price - to.price) * dir > 0) stop = to.price;
  } else if (index === 3) {
    if (to.time > entry.time) end = to.time;
  }
  return [entry, { time: end, price: target }, { time: end, price: stop }];
}

// ── Measurers ─────────────────────────────────────────────────────────────

const RANGE_BLUE_FILL = 'rgba(41,98,255,0.2)';

function rangeHit(p: Ctx, at: Pt, tol: number): boolean {
  if (p.pts.length < 2) return false;
  const [a, b] = p.pts;
  return inRect(at, a.x, a.y, b.x, b.y, tol);
}

/** Label lines for Date and Price Range and the ruler. */
export function measureLines(
  bars: readonly OhlcvBar[],
  a: DrawingPoint,
  b: DrawingPoint,
  precision: number,
  interval: number,
): string[] {
  const n = barsBetween(bars, a.time, b.time, interval);
  return [
    priceRangeText(a.price, b.price, precision),
    dateRangeText(n, b.time - a.time),
    `Vol ${formatVolume(volumeBetween(bars, a.time, b.time))}`,
  ];
}

function fillBox(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, fill: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
}

function paintPriceRange(p: PaintArgs): void {
  const m = anchorsOf(p, axisOf(p));
  if (p.pts.length < 2 || m.length < 2) return;
  const { ctx, drawing } = p;
  const [a, b] = p.pts;
  const color = drawing.style.color;
  ctx.save();
  ctx.setLineDash([]);
  fillBox(ctx, a, b, drawing.style.fill ?? RANGE_BLUE_FILL);
  ctx.strokeStyle = color;
  ctx.lineWidth = drawing.style.width;
  strokeLine(ctx, { x: a.x, y: a.y }, { x: b.x, y: a.y });
  strokeLine(ctx, { x: a.x, y: b.y }, { x: b.x, y: b.y });
  const cx = (a.x + b.x) / 2;
  arrow(ctx, { x: cx, y: a.y }, { x: cx, y: b.y }, color, drawing.style.width);
  if (drawing.style.showLabels) {
    const up = b.y <= a.y;
    labelBox(
      ctx,
      [priceRangeText(m[0].price, m[1].price, p.precision)],
      { x: cx, y: up ? Math.min(a.y, b.y) - 6 : Math.max(a.y, b.y) + 6 },
      { bg: color, fg: drawing.style.textColor ?? '#FFFFFF', align: up ? 'above' : 'below' },
    );
  }
  ctx.restore();
}

function paintDateRange(p: PaintArgs): void {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  if (p.pts.length < 2 || m.length < 2 || !axis) return;
  const { ctx, drawing } = p;
  const [a, b] = p.pts;
  const color = drawing.style.color;
  ctx.save();
  ctx.setLineDash([]);
  fillBox(ctx, a, b, drawing.style.fill ?? RANGE_BLUE_FILL);
  ctx.strokeStyle = color;
  ctx.lineWidth = drawing.style.width;
  strokeLine(ctx, { x: a.x, y: a.y }, { x: a.x, y: b.y });
  strokeLine(ctx, { x: b.x, y: a.y }, { x: b.x, y: b.y });
  const cy = (a.y + b.y) / 2;
  arrow(ctx, { x: a.x, y: cy }, { x: b.x, y: cy }, color, drawing.style.width);
  if (drawing.style.showLabels) {
    const bars = barsOf(p);
    const n = barsBetween(bars, m[0].time, m[1].time, axis.interval);
    labelBox(
      ctx,
      [dateRangeText(n, m[1].time - m[0].time), `Vol ${formatVolume(volumeBetween(bars, m[0].time, m[1].time))}`],
      { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) + 6 },
      { bg: color, fg: drawing.style.textColor ?? '#FFFFFF', align: 'below' },
    );
  }
  ctx.restore();
}

/** Date and Price Range (and the ruler): blue going up, red going down. */
function paintMeasure(p: PaintArgs): void {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  if (p.pts.length < 2 || m.length < 2 || !axis) return;
  const { ctx, drawing } = p;
  const [a, b] = p.pts;
  const up = m[1].price >= m[0].price;
  const color = up ? TV_BLUE : TV_RED;
  ctx.save();
  ctx.setLineDash([]);
  fillBox(ctx, a, b, rgba(color, 0.2));
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  arrow(ctx, { x: cx, y: a.y }, { x: cx, y: b.y }, color, 1);
  arrow(ctx, { x: a.x, y: cy }, { x: b.x, y: cy }, color, 1);
  if (drawing.style.showLabels) {
    labelBox(
      ctx,
      measureLines(barsOf(p), m[0], m[1], p.precision, axis.interval),
      { x: cx, y: up ? Math.min(a.y, b.y) - 6 : Math.max(a.y, b.y) + 6 },
      { bg: color, align: up ? 'above' : 'below' },
    );
  }
  ctx.restore();
}

// ── Forecast ──────────────────────────────────────────────────────────────

const FORECAST_OPTIONS: readonly ToolOption[] = [
  { key: 'sourceTextColor', label: 'Source text', type: 'color', default: '#FFFFFF', tab: 'text' },
  { key: 'sourceBackColor', label: 'Source background', type: 'color', default: '#1E53E5' },
  { key: 'targetTextColor', label: 'Target text', type: 'color', default: '#FFFFFF', tab: 'text' },
  { key: 'targetBackColor', label: 'Target background', type: 'color', default: '#1E53E5' },
  { key: 'successTextColor', label: 'Success text', type: 'color', default: '#FFFFFF', tab: 'text' },
  { key: 'successBackColor', label: 'Success background', type: 'color', default: TV_GREEN },
  { key: 'failureTextColor', label: 'Failure text', type: 'color', default: '#FFFFFF', tab: 'text' },
  { key: 'failureBackColor', label: 'Failure background', type: 'color', default: TV_RED },
];

function paintForecast(p: PaintArgs): void {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  if (!axis || p.pts.length < 2 || m.length < 2) return;
  const { ctx, drawing, options: o, precision } = p;
  const [a, b] = p.pts;
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = drawing.style.color;
  ctx.lineWidth = drawing.style.width;
  strokeLine(ctx, a, b);
  for (const pt of [a, b]) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = drawing.style.color;
    ctx.fill();
  }
  const up = m[1].price >= m[0].price;
  labelBox(ctx, [m[0].price.toFixed(precision)], { x: a.x, y: up ? a.y + 8 : a.y - 8 }, {
    bg: str(o, 'sourceBackColor', '#1E53E5'),
    fg: str(o, 'sourceTextColor', '#FFFFFF'),
    align: up ? 'below' : 'above',
  });
  const n = barsBetween(barsOf(p), m[0].time, m[1].time, axis.interval);
  const tgt = labelBox(
    ctx,
    [priceRangeText(m[0].price, m[1].price, precision), dateRangeText(n, m[1].time - m[0].time)],
    { x: b.x, y: up ? b.y - 8 : b.y + 8 },
    { bg: str(o, 'targetBackColor', '#1E53E5'), fg: str(o, 'targetTextColor', '#FFFFFF'), align: up ? 'above' : 'below' },
  );
  const result = forecastOutcome(barsOf(p), m[0], m[1]);
  if (result !== 'pending') {
    const ok = result === 'success';
    labelBox(ctx, [ok ? 'SUCCESS' : 'FAILURE'], { x: b.x, y: up ? tgt.y - 4 : tgt.y + tgt.h + 4 }, {
      bg: str(o, ok ? 'successBackColor' : 'failureBackColor', ok ? TV_GREEN : TV_RED),
      fg: str(o, ok ? 'successTextColor' : 'failureTextColor', '#FFFFFF'),
      align: up ? 'above' : 'below',
    });
  }
  ctx.restore();
}

// ── Bars pattern ──────────────────────────────────────────────────────────

const BARS_PATTERN_MODES = [
  'HL Bars',
  'OHLC Bars',
  'Line - Open',
  'Line - High',
  'Line - Low',
  'Line - Close',
  'Line - HL/2',
] as const;

export interface PatternBar {
  /** Bar offset from the copy's first bar. */
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * The copy a Bars Pattern draws: the source bars re-based so the first bar
 * opens at `basePrice`, optionally mirrored (time reversed) and flipped
 * (prices inverted about the base).
 */
export function barsPatternCopy(
  source: readonly OhlcvBar[],
  basePrice: number,
  mirrored: boolean,
  flipped: boolean,
): PatternBar[] {
  if (source.length === 0) return [];
  const seq = mirrored ? [...source].reverse() : source;
  const origin = mirrored ? seq[0].close : seq[0].open;
  const f = (v: number) => basePrice + (flipped ? -(v - origin) : v - origin);
  return seq.map((b, i) => {
    const h = f(b.high);
    const l = f(b.low);
    return {
      index: i,
      open: f(mirrored ? b.close : b.open),
      close: f(mirrored ? b.open : b.close),
      high: Math.max(h, l),
      low: Math.min(h, l),
    };
  });
}

/**
 * Source = the bars between the two anchors (or `options.sourceBars`, a
 * snapshot taken at creation when the controller provides one). Until a
 * snapshot exists the copy is placed straight after the source, continuing
 * from its last close — the pattern projected forward.
 */
function patternGeo(p: Ctx) {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  if (!axis || m.length < 2) return null;
  const t0 = Math.min(m[0].time, m[1].time);
  const t1 = Math.max(m[0].time, m[1].time);
  const snap = p.options['sourceBars'] as OhlcvBar[] | undefined;
  const source = snap?.length ? snap : barsOf(p).filter((b) => b.time >= t0 && b.time <= t1);
  if (source.length === 0) return null;
  const base = snap?.length ? m[0].price : source[source.length - 1].close;
  const copy = barsPatternCopy(source, base, bool(p.options, 'mirrored', false), bool(p.options, 'flipped', false));
  const x0 = snap?.length ? axis.xOf(t0) : axis.xOf(t1) + axis.spacing;
  return { copy, x0, axis };
}

function paintBarsPattern(p: PaintArgs): void {
  const g = patternGeo(p);
  if (!g) return;
  const { ctx, drawing } = p;
  const mode = str(p.options, 'mode', 'HL Bars');
  const sp = g.axis.spacing;
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = drawing.style.color;
  ctx.lineWidth = Math.max(1, drawing.style.width);
  ctx.globalAlpha *= 1 - num(p.options, 'transparency', 0) / 100;
  if (mode.startsWith('Line')) {
    const pick = (b: PatternBar) =>
      mode === 'Line - Open'
        ? b.open
        : mode === 'Line - High'
          ? b.high
          : mode === 'Line - Low'
            ? b.low
            : mode === 'Line - HL/2'
              ? (b.high + b.low) / 2
              : b.close;
    ctx.beginPath();
    let started = false;
    for (const b of g.copy) {
      const y = g.axis.yOf(pick(b));
      if (y === null) continue;
      const x = g.x0 + b.index * sp;
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  } else {
    for (const b of g.copy) {
      const x = g.x0 + b.index * sp;
      const yh = g.axis.yOf(b.high);
      const yl = g.axis.yOf(b.low);
      if (yh === null || yl === null) continue;
      strokeLine(ctx, { x, y: yh }, { x, y: yl });
      if (mode === 'OHLC Bars') {
        const yo = g.axis.yOf(b.open);
        const yc = g.axis.yOf(b.close);
        const t = Math.max(2, sp * 0.35);
        if (yo !== null) strokeLine(ctx, { x: x - t, y: yo }, { x, y: yo });
        if (yc !== null) strokeLine(ctx, { x, y: yc }, { x: x + t, y: yc });
      }
    }
  }
  if (p.selected && p.pts.length >= 2) {
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    strokeLine(ctx, p.pts[0], p.pts[1]);
  }
  ctx.restore();
}

function hitBarsPattern(p: Ctx, at: Pt, tol: number): boolean {
  if (p.pts.length >= 2 && distanceToSegment(at, p.pts[0], p.pts[1]) <= tol) return true;
  const g = patternGeo(p);
  if (!g || g.copy.length === 0) return false;
  const yh = g.axis.yOf(Math.max(...g.copy.map((b) => b.high)));
  const yl = g.axis.yOf(Math.min(...g.copy.map((b) => b.low)));
  if (yh === null || yl === null) return false;
  return inRect(at, g.x0, yh, g.x0 + (g.copy.length - 1) * g.axis.spacing, yl, tol);
}

// ── Ghost feed ────────────────────────────────────────────────────────────

function ghostGeo(p: Ctx) {
  const axis = axisOf(p);
  if (!axis || p.pts.length === 0) return null;
  const m = anchorsOf(p, axis);
  const bars = barsOf(p);
  const i0 = m.length ? barIndexAt(bars, m[0].time, axis.interval) : 0;
  const path: { index: number; price: number }[] = [];
  for (const pt of m) {
    const index = Math.round(barIndexAt(bars, pt.time, axis.interval) - i0);
    // A double-click lands two clicks on one bar; keep the last price.
    if (path.length && path[path.length - 1].index === index) path[path.length - 1].price = pt.price;
    else path.push({ index, price: pt.price });
  }
  const candles = ghostCandles(
    path,
    num(p.options, 'avgHL', 20),
    num(p.options, 'variance', 50),
    tickSize(p.precision),
    p.drawing.id,
  );
  return { axis, x0: p.pts[0].x, candles };
}

function paintGhostFeed(p: PaintArgs): void {
  const g = ghostGeo(p);
  if (!g) return;
  const { ctx, options: o } = p;
  const alpha = 1 - num(o, 'transparency', 50) / 100;
  const sp = g.axis.spacing;
  const bodyW = Math.max(1, sp * 0.7);
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  for (const c of g.candles) {
    const x = g.x0 + c.index * sp;
    const yo = g.axis.yOf(c.open);
    const yc = g.axis.yOf(c.close);
    const yh = g.axis.yOf(c.high);
    const yl = g.axis.yOf(c.low);
    if (yo === null || yc === null || yh === null || yl === null) continue;
    const up = c.close >= c.open;
    const pickC = (u: string, d: string) => rgba(str(o, up ? u : d, up ? TV_GREEN : TV_RED), alpha);
    ctx.strokeStyle = pickC('wickUpColor', 'wickDownColor');
    strokeLine(ctx, { x, y: yh }, { x, y: yl });
    const top = Math.min(yo, yc);
    const h = Math.max(1, Math.abs(yc - yo));
    ctx.fillStyle = pickC('upColor', 'downColor');
    ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    ctx.strokeStyle = pickC('borderUpColor', 'borderDownColor');
    ctx.strokeRect(x - bodyW / 2, top, bodyW, h);
  }
  if (p.selected || p.drawing.id === 'preview') {
    ctx.strokeStyle = p.drawing.style.color;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    p.pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.stroke();
  }
  ctx.restore();
}

function hitGhostFeed(p: Ctx, at: Pt, tol: number): boolean {
  for (let i = 1; i < p.pts.length; i++) if (distanceToSegment(at, p.pts[i - 1], p.pts[i]) <= tol) return true;
  const g = ghostGeo(p);
  if (!g) return false;
  const half = g.axis.spacing / 2;
  return g.candles.some((c) => {
    const x = g.x0 + c.index * g.axis.spacing;
    const yh = g.axis.yOf(c.high);
    const yl = g.axis.yOf(c.low);
    return yh !== null && yl !== null && inRect(at, x - half, yh, x + half, yl, tol);
  });
}

// ── Projection ────────────────────────────────────────────────────────────

/**
 * Projection: origin A, B to the right (time), C at the estimated price. A
 * sector centred on A sweeps from AB to AC, filled with background 1 (rising)
 * or background 2 (falling), bordered, with the change A→C labelled.
 */
function paintProjection(p: PaintArgs): void {
  const { ctx, drawing, pts, options: o } = p;
  if (pts.length < 2) return;
  const [a, b, c] = pts;
  const r = Math.hypot(b.x - a.x, b.y - a.y);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = str(o, 'borderColor', '#9598A1');
  ctx.lineWidth = drawing.style.width;
  strokeLine(ctx, a, b);
  if (c && r > 0) {
    const angB = Math.atan2(b.y - a.y, b.x - a.x);
    const angC = Math.atan2(c.y - a.y, c.x - a.x);
    const end = { x: a.x + r * Math.cos(angC), y: a.y + r * Math.sin(angC) };
    const rising = c.y < b.y;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.arc(a.x, a.y, r, angB, angC, angC < angB);
    ctx.closePath();
    ctx.fillStyle = rising ? str(o, 'color1', 'rgba(8,153,129,0.2)') : str(o, 'color2', 'rgba(242,54,69,0.2)');
    if (bool(o, 'fillBackground', true)) ctx.fill();
    ctx.stroke();
    if (drawing.style.showLabels) {
      const m = anchorsOf(p, axisOf(p));
      if (m.length >= 3) {
        labelBox(ctx, [priceRangeText(m[0].price, m[2].price, p.precision)], { x: end.x, y: rising ? end.y - 6 : end.y + 6 }, {
          bg: rising ? TV_GREEN : TV_RED,
          align: rising ? 'above' : 'below',
        });
      }
    }
  }
  ctx.restore();
}

function hitProjection(p: Ctx, at: Pt, tol: number): boolean {
  const [a, b, c] = p.pts;
  if (!a || !b) return false;
  if (distanceToSegment(at, a, b) <= tol) return true;
  if (!c) return false;
  const r = Math.hypot(b.x - a.x, b.y - a.y);
  if (Math.hypot(at.x - a.x, at.y - a.y) > r + tol) return false;
  const ang = Math.atan2(at.y - a.y, at.x - a.x);
  const angB = Math.atan2(b.y - a.y, b.x - a.x);
  const angC = Math.atan2(c.y - a.y, c.x - a.x);
  return ang >= Math.min(angB, angC) - 0.05 && ang <= Math.max(angB, angC) + 0.05;
}

// ── Anchored VWAP ─────────────────────────────────────────────────────────

const VWAP_OPTIONS: readonly ToolOption[] = [
  {
    key: 'source',
    label: 'Source',
    type: 'select',
    default: 'hlc3',
    choices: ['hlc3', 'hl2', 'ohlc4', 'close', 'open', 'high', 'low'],
  },
  { key: 'band1', label: 'Bands multiplier #1', type: 'bool', default: true },
  { key: 'band1Mult', label: 'Multiplier #1', type: 'number', default: 1, min: 0, step: 0.5 },
  { key: 'band2', label: 'Bands multiplier #2', type: 'bool', default: false },
  { key: 'band2Mult', label: 'Multiplier #2', type: 'number', default: 2, min: 0, step: 0.5 },
  { key: 'band3', label: 'Bands multiplier #3', type: 'bool', default: false },
  { key: 'band3Mult', label: 'Multiplier #3', type: 'number', default: 3, min: 0, step: 0.5 },
  { key: 'bandColor', label: 'Bands', type: 'color', default: '#4CAF50' },
  { key: 'bandFill', label: 'Bands background', type: 'color', default: 'rgba(76,175,80,0.1)' },
];

function vwapGeo(p: Ctx) {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  if (!axis || m.length === 0) return null;
  return { axis, series: anchoredVwap(barsOf(p), m[0].time, str(p.options, 'source', 'hlc3') as VwapSource) };
}

function polyline(ctx: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.stroke();
}

function paintVwap(p: PaintArgs): void {
  const g = vwapGeo(p);
  if (!g || g.series.length === 0) return;
  const { ctx, drawing, options: o } = p;
  const xs = g.series.map((s) => g.axis.xOf(s.time));
  const path = (k: number): Pt[] => {
    const out: Pt[] = [];
    g.series.forEach((s, i) => {
      const y = g.axis.yOf(s.vwap + k * s.stdev);
      if (y !== null) out.push({ x: xs[i], y });
    });
    return out;
  };
  ctx.save();
  ctx.setLineDash([]);
  for (const n of [3, 2, 1]) {
    if (!bool(o, `band${n}`, n === 1)) continue;
    const k = num(o, `band${n}Mult`, n);
    const upper = path(k);
    const lower = path(-k);
    ctx.fillStyle = str(o, 'bandFill', 'rgba(76,175,80,0.1)');
    ctx.beginPath();
    [...upper, ...[...lower].reverse()].forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = str(o, 'bandColor', '#4CAF50');
    ctx.lineWidth = 1;
    polyline(ctx, upper);
    polyline(ctx, lower);
  }
  ctx.strokeStyle = drawing.style.color;
  ctx.lineWidth = drawing.style.width;
  polyline(ctx, path(0));
  ctx.restore();
}

function hitVwap(p: Ctx, at: Pt, tol: number): boolean {
  const g = vwapGeo(p);
  if (!g) return false;
  let prev: Pt | null = null;
  for (const s of g.series) {
    const y = g.axis.yOf(s.vwap);
    if (y === null) continue;
    const q = { x: g.axis.xOf(s.time), y };
    if (prev && distanceToSegment(at, prev, q) <= tol) return true;
    prev = q;
  }
  return false;
}

// ── Volume profiles ───────────────────────────────────────────────────────

const PROFILE_OPTIONS: readonly ToolOption[] = [
  { key: 'rows', label: 'Row size', type: 'number', default: 24, min: 1, max: 1000, step: 1 },
  { key: 'volume', label: 'Volume', type: 'select', default: 'Up/Down', choices: ['Up/Down', 'Total', 'Delta'] },
  { key: 'valueArea', label: 'Value area volume', type: 'number', default: 70, min: 0, max: 100 },
  { key: 'widthPct', label: 'Width (% of the box)', type: 'number', default: 30, min: 1, max: 100 },
  { key: 'placement', label: 'Placement', type: 'select', default: 'Left', choices: ['Left', 'Right'] },
  { key: 'upColor', label: 'Up volume', type: 'color', default: 'rgba(8,153,129,0.3)' },
  { key: 'downColor', label: 'Down volume', type: 'color', default: 'rgba(242,54,69,0.3)' },
  { key: 'vaUpColor', label: 'Value area up', type: 'color', default: 'rgba(8,153,129,0.7)' },
  { key: 'vaDownColor', label: 'Value area down', type: 'color', default: 'rgba(242,54,69,0.7)' },
  { key: 'showValueArea', label: 'Value area', type: 'bool', default: true },
  { key: 'showPoc', label: 'POC', type: 'bool', default: true },
  { key: 'pocColor', label: 'POC color', type: 'color', default: '#FF0000' },
  { key: 'extendPoc', label: 'Extend POC right', type: 'bool', default: false },
];

/**
 * The time span a volume-profile drawing covers, in MODEL time: fixed = between its two anchors, in either drag
 * order; anchored = from its anchor to the newest bar, whatever that is (an unbounded end, never a screen x — the
 * old painter asked the time scale for the pane's right edge, which is past the data, got null and drew nothing).
 * A fixed profile still being placed (one anchor) previews as anchored. Null without an anchor.
 */
export function profileSpan(
  mode: 'fixed' | 'anchored',
  anchors: readonly { time: number }[],
): { t0: number; t1: number; fixed: boolean } | null {
  if (anchors.length === 0) return null;
  const fixed = mode === 'fixed' && anchors.length >= 2;
  return fixed
    ? { t0: Math.min(anchors[0].time, anchors[1].time), t1: Math.max(anchors[0].time, anchors[1].time), fixed }
    : { t0: anchors[0].time, t1: Infinity, fixed };
}

function profileGeo(p: Ctx, mode: 'fixed' | 'anchored') {
  const axis = axisOf(p);
  const m = anchorsOf(p, axis);
  const span = profileSpan(mode, m);
  if (!axis || !span) return null;
  const { t0, t1, fixed } = span;
  const inRange = barsOf(p).filter((b) => b.time >= t0 && b.time <= t1);
  const rows = Math.max(1, Math.round(num(p.options, 'rows', 24)));
  const prof = volumeProfileRows(inRange, rows, num(p.options, 'valueArea', 70));
  if (!prof) return null;
  const x0 = axis.xOf(t0);
  const x1 = fixed ? axis.xOf(t1) : axis.xOf(inRange[inRange.length - 1].time);
  const yTop = axis.yOf(prof.rows[prof.rows.length - 1].high);
  const yBot = axis.yOf(prof.rows[0].low);
  if (yTop === null || yBot === null) return null;
  return { axis, prof, x0, x1: Math.max(x1, x0 + 1), yTop, yBot };
}

function paintProfile(p: PaintArgs, mode: 'fixed' | 'anchored'): void {
  const g = profileGeo(p, mode);
  if (!g) return;
  const { ctx, options: o } = p;
  const { prof, x0, x1 } = g;
  const right = str(o, 'placement', 'Left') === 'Right';
  const maxW = ((x1 - x0) * num(o, 'widthPct', 30)) / 100;
  const vol = str(o, 'volume', 'Up/Down');
  const showVA = bool(o, 'showValueArea', true);
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(41,98,255,0.04)';
  ctx.fillRect(x0, g.yTop, x1 - x0, g.yBot - g.yTop);
  if (p.selected) {
    ctx.strokeStyle = rgba(TV_BLUE, 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, g.yTop, x1 - x0, g.yBot - g.yTop);
  }
  const scale =
    vol === 'Delta' ? Math.max(...prof.rows.map((r) => Math.abs(r.up - r.down)), 1e-12) : prof.peak || 1;
  prof.rows.forEach((row, i) => {
    const ya = g.axis.yOf(row.high);
    const yb = g.axis.yOf(row.low);
    if (ya === null || yb === null) return;
    const y = Math.min(ya, yb) + 0.5;
    const h = Math.max(1, Math.abs(yb - ya) - 1);
    const va = showVA && i >= prof.vaLow && i <= prof.vaHigh;
    const upC = str(o, va ? 'vaUpColor' : 'upColor', va ? 'rgba(8,153,129,0.7)' : 'rgba(8,153,129,0.3)');
    const dnC = str(o, va ? 'vaDownColor' : 'downColor', va ? 'rgba(242,54,69,0.7)' : 'rgba(242,54,69,0.3)');
    const segs: [number, string][] =
      vol === 'Total'
        ? [[row.total, upC]]
        : vol === 'Delta'
          ? [[Math.abs(row.up - row.down), row.up >= row.down ? upC : dnC]]
          : [
              [row.up, upC],
              [row.down, dnC],
            ];
    let offset = 0;
    for (const [v, c] of segs) {
      const w = (v / scale) * maxW;
      ctx.fillStyle = c;
      ctx.fillRect(right ? x1 - offset - w : x0 + offset, y, w, h);
      offset += w;
    }
  });
  if (bool(o, 'showPoc', true)) {
    const row = prof.rows[prof.poc];
    const y = g.axis.yOf((row.low + row.high) / 2);
    if (y !== null) {
      ctx.strokeStyle = str(o, 'pocColor', '#FF0000');
      ctx.lineWidth = 2;
      strokeLine(ctx, { x: x0, y }, { x: bool(o, 'extendPoc', false) ? p.width : x1, y });
    }
  }
  ctx.restore();
}

function hitProfile(p: Ctx, at: Pt, tol: number, mode: 'fixed' | 'anchored'): boolean {
  const g = profileGeo(p, mode);
  return !!g && inRect(at, g.x0, g.yTop, g.x1, g.yBot, tol);
}

// ── Registry ──────────────────────────────────────────────────────────────

const MEASURE_STYLE = { color: TV_BLUE, width: 1, fill: RANGE_BLUE_FILL, showLabels: true } as const;

export const BEHAVIORS: ToolBehaviorMap = {
  'long-position': {
    ...positionBehavior('long'),
    // Store TradingView's default target/stop at creation instead of deriving them on every paint.
    onCreate: (d) => ({ points: completePositionPoints(d, 'long') }),
  },
  'short-position': {
    ...positionBehavior('short'),
    onCreate: (d) => ({ points: completePositionPoints(d, 'short') }),
  },

  forecast: {
    points: 2,
    defaultStyle: { color: TV_BLUE, width: 2, showLabels: true },
    options: FORECAST_OPTIONS,
    paint: paintForecast,
    hitTest: (p, at, tol) => p.pts.length >= 2 && distanceToSegment(at, p.pts[0], p.pts[1]) <= tol,
  },

  'bars-pattern': {
    points: 2,
    defaultStyle: { color: TV_BLUE, width: 1 },
    options: [
      { key: 'mode', label: 'Mode', type: 'select', default: 'HL Bars', choices: BARS_PATTERN_MODES },
      { key: 'mirrored', label: 'Mirrored', type: 'bool', default: false },
      { key: 'flipped', label: 'Flipped', type: 'bool', default: false },
      { key: 'transparency', label: 'Transparency', type: 'number', default: 0, min: 0, max: 100 },
    ],
    paint: paintBarsPattern,
    hitTest: hitBarsPattern,
    // TradingView freezes the copied bars at creation: later moves relocate the copy, not the source.
    onCreate: (d, bars) => {
      const [a, b] = d.points;
      if (!a || !b) return;
      const t0 = Math.min(a.time, b.time);
      const t1 = Math.max(a.time, b.time);
      const sourceBars = bars
        .filter((x) => x.time >= t0 && x.time <= t1)
        .map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
      return sourceBars.length ? { options: { ...(d.options ?? {}), sourceBars } } : undefined;
    },
  },

  'ghost-feed': {
    // Click each turn of the path; a double-click finishes (the controller commits on dblclick).
    points: 30,
    defaultStyle: { color: TV_BLUE, width: 1 },
    options: [
      { key: 'avgHL', label: 'Avg HL in minticks', type: 'number', default: 20, min: 0, step: 1 },
      { key: 'variance', label: 'Variance', type: 'number', default: 50, min: 0, step: 1 },
      { key: 'upColor', label: 'Up body', type: 'color', default: TV_GREEN },
      { key: 'downColor', label: 'Down body', type: 'color', default: TV_RED },
      { key: 'borderUpColor', label: 'Up border', type: 'color', default: TV_GREEN },
      { key: 'borderDownColor', label: 'Down border', type: 'color', default: TV_RED },
      { key: 'wickUpColor', label: 'Up wick', type: 'color', default: TV_GREEN },
      { key: 'wickDownColor', label: 'Down wick', type: 'color', default: TV_RED },
      { key: 'transparency', label: 'Transparency', type: 'number', default: 50, min: 0, max: 100 },
    ],
    paint: paintGhostFeed,
    hitTest: hitGhostFeed,
  },

  projection: {
    points: 3,
    defaultStyle: { color: '#9598A1', width: 1, showLabels: true },
    options: [
      { key: 'fillBackground', label: 'Background', type: 'bool', default: true },
      { key: 'color1', label: 'Background (up)', type: 'color', default: 'rgba(8,153,129,0.2)' },
      { key: 'color2', label: 'Background (down)', type: 'color', default: 'rgba(242,54,69,0.2)' },
      { key: 'borderColor', label: 'Border', type: 'color', default: '#9598A1' },
    ],
    paint: paintProjection,
    hitTest: hitProjection,
  },

  'anchored-vwap': {
    points: 1,
    defaultStyle: { color: TV_BLUE, width: 2 },
    options: VWAP_OPTIONS,
    paint: paintVwap,
    hitTest: hitVwap,
  },

  'fixed-range-volume-profile': {
    points: 2,
    defaultStyle: { color: TV_BLUE, width: 1 },
    options: PROFILE_OPTIONS,
    paint: (p) => paintProfile(p, 'fixed'),
    hitTest: (p, at, tol) => hitProfile(p, at, tol, 'fixed'),
  },

  'anchored-volume-profile': {
    points: 1,
    defaultStyle: { color: TV_BLUE, width: 1 },
    options: PROFILE_OPTIONS,
    paint: (p) => paintProfile(p, 'anchored'),
    hitTest: (p, at, tol) => hitProfile(p, at, tol, 'anchored'),
  },

  'price-range': { points: 2, defaultStyle: MEASURE_STYLE, paint: paintPriceRange, hitTest: rangeHit },
  'date-range': { points: 2, defaultStyle: MEASURE_STYLE, paint: paintDateRange, hitTest: rangeHit },
  measure: { points: 2, defaultStyle: MEASURE_STYLE, paint: paintMeasure, hitTest: rangeHit },
  /**
   * TradingView's rail ruler: a click-drag Date and Price Range that vanishes
   * on the next click. Transient removal needs controller support (see
   * TRANSIENT_KINDS); painting and hit-testing are `measure`'s.
   */
  ruler: { points: 2, transient: true, defaultStyle: MEASURE_STYLE, paint: paintMeasure, hitTest: rangeHit },
};

/** For the controller: kinds TradingView removes on the next chart click (the rail ruler). */
export const TRANSIENT_KINDS: readonly string[] = ['ruler'];
