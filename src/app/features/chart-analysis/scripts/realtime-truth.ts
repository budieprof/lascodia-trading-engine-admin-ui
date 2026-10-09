import { parsePineColor } from '@shared/pine-chart/core/color';
import type {
  PineBoxOutput,
  PineLabelOutput,
  PineLineOutput,
  PineOutputX,
  PinePolylineOutput,
  PineScriptOutputs,
} from '@shared/pine-chart/model/pine-outputs.types';

/**
 * Realtime truthfulness (PC-I9). On a live chart a script's last bar is the one still FORMING: what it shows there is
 * re-computed on every tick and can change — or vanish — until the bar closes (Pine rolls the bar back each tick).
 * TradingView shows those values like the others; the operator then reads a cross or a label that may never happen.
 * The chart says it instead:
 *
 * - values on the forming bar are drawn faded ({@link UNCONFIRMED_ALPHA}) until the bar closes;
 * - drawings created or moved on the forming bar are PROVISIONAL: faded, with a tooltip saying so;
 * - a plot whose value on an already CLOSED bar changes between two runs (or frames) of the same session REPAINTS —
 *   {@link detectRepaint} finds the first such plot and bar, for the script's chip.
 */

/** Alpha factor of what is drawn on the forming bar (and of provisional drawings). */
export const UNCONFIRMED_ALPHA = 0.45;

/** The tooltip a provisional drawing gets (after its own, if any). */
export const PROVISIONAL_NOTE = 'Provisional — drawn on the bar still forming: it can change or disappear before the bar closes.';

/** A Pine `#RRGGBBAA` color with its alpha multiplied by `factor`; na stays na, an unreadable color is kept as is. */
export function fadePineColor(color: string | null | undefined, factor = UNCONFIRMED_ALPHA): string | null | undefined {
  if (!color) return color;
  const c = parsePineColor(color);
  if (!c) return color;
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${hex(c.a * factor * 255)}`.toUpperCase();
}

/**
 * The outputs with the forming bar's values faded and the drawings made on it marked provisional. `formingIndex` is
 * the bar_index of the forming bar (the run's last); null returns `outputs` unchanged. Pure: per-bar arrays and drawings
 * that change are copied, the rest is shared.
 */
export function markUnconfirmed(outputs: PineScriptOutputs, formingIndex: number | null): PineScriptOutputs {
  if (formingIndex === null) return outputs;
  const slot = formingIndex - outputs.bars.firstIndex;
  if (slot < 0 || slot >= outputs.bars.times.length) return outputs;
  const n = outputs.bars.times.length;

  /** A per-bar color track with the forming slot faded (a uniform color becomes per-bar). */
  const fadeTrack = (
    color: string | null | undefined,
    colors: readonly (string | null)[] | null | undefined,
  ): { color: string | null; colors: (string | null)[] | null } => {
    if (!colors && !color) return { color: color ?? null, colors: colors ? [...colors] : null };
    const track = colors ? [...colors] : new Array<string | null>(n).fill(color ?? null);
    if (slot < track.length) track[slot] = (fadePineColor(track[slot]) as string | null) ?? null;
    return { color: null, colors: track };
  };
  const fadeOnly = (colors: readonly (string | null)[] | null | undefined): (string | null)[] | null => {
    if (!colors) return null;
    const out = [...colors];
    if (slot < out.length) out[slot] = (fadePineColor(out[slot]) as string | null) ?? null;
    return out;
  };

  const provisional = (xs: readonly (PineOutputX | null | undefined)[], createdBar: number): boolean =>
    createdBar >= formingIndex || xs.some((x) => (x?.barIndex ?? -1) >= formingIndex);
  const note = (tooltip: string | null | undefined) => (tooltip ? `${tooltip}\n${PROVISIONAL_NOTE}` : PROVISIONAL_NOTE);

  const labels = outputs.labels.map((l): PineLabelOutput =>
    provisional([l.x], l.createdBar)
      ? { ...l, color: fadePineColor(l.color), textColor: fadePineColor(l.textColor), tooltip: note(l.tooltip) }
      : l,
  );
  const lines = outputs.lines.map((l): PineLineOutput =>
    provisional([l.x1, l.x2], l.createdBar) ? { ...l, color: fadePineColor(l.color) } : l,
  );
  const boxes = outputs.boxes.map((b): PineBoxOutput =>
    provisional([b.left, b.right], b.createdBar)
      ? { ...b, borderColor: fadePineColor(b.borderColor), bgColor: fadePineColor(b.bgColor), textColor: fadePineColor(b.textColor) }
      : b,
  );
  const polylines = outputs.polylines.map((p): PinePolylineOutput =>
    p.createdBar >= formingIndex || p.points.some((pt) => (pt.barIndex ?? -1) >= formingIndex)
      ? { ...p, lineColor: fadePineColor(p.lineColor), fillColor: fadePineColor(p.fillColor) }
      : p,
  );

  return {
    ...outputs,
    plots: outputs.plots.map((p) => ({ ...p, ...fadeTrack(p.color, p.colors) })),
    candles: outputs.candles.map((c) => ({
      ...c,
      ...fadeTrack(c.color, c.colors),
      wickColors: fadeOnly(c.wickColors),
      borderColors: fadeOnly(c.borderColors),
    })),
    markers: outputs.markers.map((m) =>
      m.points.some((pt) => pt.barIndex === formingIndex)
        ? {
            ...m,
            points: m.points.map((pt) =>
              pt.barIndex === formingIndex
                ? { ...pt, color: fadePineColor(pt.color), textColor: fadePineColor(pt.textColor) }
                : pt,
            ),
          }
        : m,
    ),
    backgrounds: outputs.backgrounds.map((b) => ({ ...b, colors: fadeOnly(b.colors) ?? b.colors })),
    barColors: outputs.barColors.map((b) => ({ ...b, colors: fadeOnly(b.colors) ?? b.colors })),
    fills: outputs.fills.map((f) =>
      f.kind === 'gradient'
        ? { ...f, topColors: fadeOnly(f.topColors), bottomColors: fadeOnly(f.bottomColors) }
        : { ...f, ...fadeTrack(f.color, f.colors) },
    ),
    labels,
    lines,
    boxes,
    polylines,
  };
}

/** A plot that changed its value on a bar that had already closed. */
export interface RepaintFinding {
  plotTitle: string;
  /** Open time of the bar (Unix ms). */
  barTime: number;
  barIndex: number;
  before: number | null;
  after: number | null;
}

/** How far apart two values may be and still be "the same" (relative, and absolute near zero). */
const REPAINT_EPSILON = 1e-9;

/**
 * The first plot whose value on a bar that was CLOSED in `before` differs in `after` — a repaint (`request.security`
 * with lookahead, `timenow`, a value written back to history). Compared only when both runs start on the same bar (a
 * window that moved would differ in every warm-up value, which is not a repaint), on the bars closed in `before`
 * (`beforeForming`: its forming bar, excluded; null = all closed), by open time, at most the last `maxBars` of them.
 */
export function detectRepaint(
  before: PineScriptOutputs | null | undefined,
  after: PineScriptOutputs | null | undefined,
  beforeForming: number | null,
  maxBars = 300,
): RepaintFinding | null {
  if (!before || !after) return null;
  const bt = before.bars.times;
  const at = after.bars.times;
  if (!bt.length || !at.length) return null;
  // The same window start: same first bar (index and time) — a delta-merged run keeps it; a full re-run on a new bar
  // moves it.
  if (before.bars.firstIndex !== after.bars.firstIndex || bt[0] !== at[0]) return null;
  const closedEnd = beforeForming === null ? bt.length : Math.min(bt.length, beforeForming - before.bars.firstIndex);
  const start = Math.max(0, closedEnd - maxBars);
  const afterSlotOf = new Map<number, number>();
  for (let i = 0; i < at.length; i++) afterSlotOf.set(at[i], i);
  const afterById = new Map(after.plots.map((p) => [p.id, p]));
  for (const p of before.plots) {
    const q = afterById.get(p.id);
    if (!q) continue;
    for (let i = start; i < closedEnd; i++) {
      const j = afterSlotOf.get(bt[i]);
      if (j === undefined) continue;
      const x = p.values[i] ?? null;
      const y = q.values[j] ?? null;
      if (same(x, y)) continue;
      return {
        plotTitle: p.title || `Plot ${p.plotNumber}`,
        barTime: bt[i],
        barIndex: before.bars.firstIndex + i,
        before: x,
        after: y,
      };
    }
  }
  return null;
}

function same(x: number | null, y: number | null): boolean {
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
    const xn = x === null || !Number.isFinite(x);
    const yn = y === null || !Number.isFinite(y);
    return xn && yn;
  }
  const diff = Math.abs(x - y);
  return diff <= REPAINT_EPSILON || diff <= REPAINT_EPSILON * Math.max(Math.abs(x), Math.abs(y));
}

/** The chip's line about a repaint: "Repaints: Fast EMA changed on a closed bar (12:00) from 1.08321 to 1.08350". */
export function repaintText(f: RepaintFinding, formatTime: (ms: number) => string): string {
  const v = (n: number | null) => (n === null ? 'na' : String(Math.round(n * 1e8) / 1e8));
  return `Repaints: ${f.plotTitle} changed on a closed bar (${formatTime(f.barTime)}) from ${v(f.before)} to ${v(f.after)}`;
}
