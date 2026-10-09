/**
 * Trading lines the operator can drag on the chart (SP-I3 / SP-I4): the order ticket's brackets, an open position's
 * stop and target, a working order's price — and the "pending" ghost a change leaves until the EA acknowledges it.
 * Pure geometry; the primitive draws and drags, the page decides what a drop means.
 */

export type TradeLineKind =
  | 'ticketEntry'
  | 'ticketStop'
  | 'ticketTarget'
  | 'positionEntry'
  | 'positionStop'
  | 'positionTarget'
  | 'orderPrice'
  | 'orderStop'
  | 'orderTarget'
  | 'pending';

export interface TradeLine {
  /** Unique per line, stable across redraws ("pos:12:stop", "ticket:stop", …). */
  key: string;
  kind: TradeLineKind;
  price: number;
  /** Chip text at the right end. */
  label: string;
  color: string;
  /** Can be grabbed and dragged. */
  draggable: boolean;
  /** Can be clicked (a position's entry: close it; an order's price: cancel it). */
  clickable?: boolean;
  /**
   * Drawn by this layer. False for a position's or order's own lines, which the trade layer's overlay already draws:
   * this layer only makes them grabbable and draws them while they move.
   */
  drawn: boolean;
  /** The position or order the line belongs to. */
  refId?: number;
  /** Faded dashes: a change sent and waiting for the broker. */
  faded?: boolean;
}

/** Pixels from a line within which a press grabs it. */
export const TRADE_GRAB_TOLERANCE_PX = 5;

/**
 * The line a press at `y` takes (the nearest draggable or clickable one within the tolerance), or null. With `only`
 * = 'draggable' clickable-only lines are passed over.
 */
export function grabbedTradeLine(
  lines: readonly TradeLine[],
  y: number,
  toY: (price: number) => number | null,
  tolerancePx = TRADE_GRAB_TOLERANCE_PX,
  only: 'any' | 'draggable' = 'any',
): TradeLine | null {
  let best: TradeLine | null = null;
  let bestDistance = tolerancePx + 1e-9;
  for (const line of lines) {
    if (!line.draggable && (only === 'draggable' || !line.clickable)) continue;
    const ly = toY(line.price);
    if (ly === null) continue;
    const d = Math.abs(ly - y);
    if (d <= bestDistance) {
      best = line;
      bestDistance = d;
    }
  }
  return best;
}

/** `price` rounded to `precision` digits. */
export function roundPrice(price: number, precision: number): number {
  const f = 10 ** Math.max(0, Math.min(10, Math.trunc(precision)));
  return Math.round(price * f) / f;
}

/** The price a drag ends at, rounded to the symbol's digits; null when the pixel is off the scale. */
export function tradeDragPrice(
  y: number,
  fromY: (y: number) => number | null,
  precision: number,
): number | null {
  const p = fromY(y);
  return p === null || !Number.isFinite(p) || p <= 0 ? null : roundPrice(p, precision);
}
