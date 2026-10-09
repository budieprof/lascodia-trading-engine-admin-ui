/**
 * Alerts on drawings (DR-I6, UI part): a trend line, ray, extended line, horizontal line / ray, parallel channel or
 * one Fib retracement level as the engine's drawing-alert geometry (`ChartAlertGeometry` — engine
 * `ChartAlerts/Evaluation/ChartAlertGeometry.cs`), and the new alert the alert form starts from.
 *
 * The engine evaluates the shape on the alert timeframe's bar grid, straight in bar space × price (× log price for a
 * drawing made on a log scale), with TradingView's conventions — which are the drawing tools' own: "extend left /
 * right" in time terms, not anchor order; Fib level 0 at the second anchor, 1 at the first, swapped by Reverse; a
 * channel's parallel line through its third anchor.
 *
 * Pure; unit-tested directly.
 */
import type { ChartAlertDto, ChartAlertGeometry } from '../alerts/chart-alerts.types';
import { FIB_LEVELS_TV, levelsOf } from './tools/fib-gann-core';
import { behaviorFor } from './tools/registry';
import { optionsOf } from './tools/types';
import type { Drawing, DrawingKind } from './model';

/** The drawings an alert can watch, and the anchors each needs. */
const ALERTABLE: Readonly<Partial<Record<DrawingKind, number>>> = {
  'horizontal-line': 1,
  'horizontal-ray': 1,
  'trend-line': 2,
  ray: 2,
  'extended-line': 2,
  'parallel-channel': 3,
  'fib-retracement': 2,
};

/**
 * Whether an alert can be set on this drawing: one of the shapes above, on the price pane (a line on a study's pane
 * is in the study's units, not prices), with its anchors in place.
 */
export function canAlertOn(d: Drawing): boolean {
  const need = ALERTABLE[d.kind];
  if (need === undefined || d.pane) return false;
  if (d.points.length < need) return false;
  return d.points.slice(0, need).every((p) => p.time > 0 && p.price > 0);
}

/** The Fib levels an alert can watch: the drawing's visible ones, in its order. */
export function fibAlertLevels(d: Drawing): number[] {
  if (d.kind !== 'fib-retracement') return [];
  const options = optionsOf(behaviorFor(d.kind), d);
  return levelsOf(options, FIB_LEVELS_TV)
    .filter((l) => l.visible !== false && Number.isFinite(l.value))
    .map((l) => l.value);
}

/**
 * The drawing as the engine's alert geometry; null when it cannot be watched (not an alertable shape, off the price
 * pane, a Fib without a level, two anchors at one time — a vertical line has no price to cross).
 */
export function drawingAlertGeometry(
  d: Drawing,
  opts: { level?: number | null; logScale?: boolean } = {},
): ChartAlertGeometry | null {
  if (!canAlertOn(d)) return null;
  const options = optionsOf(behaviorFor(d.kind), d);
  const flag = (k: string) => options[k] === true;
  const need = ALERTABLE[d.kind] ?? 0;
  const points = d.points.slice(0, need).map((p) => ({ timeMs: p.time, price: p.price }));
  if (need >= 2 && points[0].timeMs === points[1].timeMs) return null;
  const logScale = opts.logScale ? { logScale: true } : {};
  switch (d.kind) {
    case 'horizontal-line':
      return { shape: 'horizontal', points, extendLeft: true, extendRight: true, ...logScale };
    case 'horizontal-ray':
      // It starts at its anchor.
      return { shape: 'horizontal', points, extendLeft: false, extendRight: true, ...logScale };
    case 'parallel-channel':
      return {
        shape: 'channel',
        points,
        extendLeft: flag('extendLeft'),
        extendRight: flag('extendRight'),
        ...logScale,
      };
    case 'fib-retracement': {
      const level = opts.level;
      if (
        level === null ||
        level === undefined ||
        !Number.isFinite(level) ||
        level < -10 ||
        level > 10
      )
        return null;
      return {
        shape: 'fib',
        points,
        level,
        reverse: flag('reverse'),
        extendLeft: flag('extendLeft'),
        extendRight: flag('extendRight'),
        ...logScale,
      };
    }
    default:
      // Trend line, ray, extended line: the tool's own extend flags (a ray's right, an extended line's both).
      return {
        shape: 'line',
        points,
        extendLeft: flag('extendLeft'),
        extendRight: flag('extendRight'),
        ...logScale,
      };
  }
}

const NAMES: Readonly<Partial<Record<DrawingKind, string>>> = {
  'horizontal-line': 'Horizontal line',
  'horizontal-ray': 'Horizontal ray',
  'trend-line': 'Trend line',
  ray: 'Ray',
  'extended-line': 'Extended line',
  'parallel-channel': 'Parallel channel',
  'fib-retracement': 'Fib',
};

/**
 * The new alert the form opens with for a drawing: its geometry, id and kind; crossing either way for a line or a
 * level, entering for a channel; bid, once, in app — the operator still chooses before anything is armed. Null when
 * the drawing cannot be watched ({@link drawingAlertGeometry}).
 */
export function drawingAlertDraft(
  d: Drawing,
  opts: { timeframe: string; level?: number | null; logScale?: boolean },
): ChartAlertDto | null {
  const geometry = drawingAlertGeometry(d, opts);
  if (!geometry) return null;
  const base = NAMES[d.kind] ?? d.kind;
  const name = geometry.shape === 'fib' ? `${base} ${geometry.level}` : base;
  return {
    id: 0,
    name,
    symbol: d.symbol.toUpperCase(),
    timeframe: opts.timeframe,
    kind: 'Drawing',
    side: 'Bid',
    condition: geometry.shape === 'channel' ? 'EnteringChannel' : 'Crossing',
    price: null,
    upperPrice: null,
    geometry,
    drawingId: d.id,
    drawingKind: d.kind,
    frequency: 'once',
    expiresAtUtc: null,
    channels: ['InApp'],
    messageTemplate: null,
    severity: 'Medium',
    status: 'Active',
    statusReason: null,
    createdAt: '',
    updatedAt: '',
    lastFiredAt: null,
    fireCount: 0,
  };
}
