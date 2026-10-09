import { describeAlert, roundTo } from './chart-alert-rules';
import type { ChartAlertDto } from './chart-alerts.types';

/** Which level of an alert a line is: its level (a channel's lower bound) or a channel's upper bound. */
export type AlertLineBound = 'price' | 'upper';

/** One dashed alert line on the chart. */
export interface AlertLine {
  alertId: number;
  bound: AlertLineBound;
  price: number;
  /** Axis chip text. */
  label: string;
  /** Tooltip-length description. */
  title: string;
  color: string;
  /** Paused alerts are drawn faint and are not draggable. */
  active: boolean;
}

export const ALERT_LINE_COLORS = {
  up: '#26a69a',
  down: '#ef5350',
  either: '#2962ff',
  channel: '#ab47bc',
  paused: '#9e9e9e',
} as const;

/** Pixels from a line within which a press grabs it. */
export const GRAB_TOLERANCE_PX = 5;

/**
 * The lines of `symbol`'s price alerts (drawing alerts follow their drawing and are not drawn again): Active ones in
 * their condition's colour, Paused ones faint. Fired and expired alerts are not drawn.
 */
export function alertLinesFor(
  alerts: readonly ChartAlertDto[],
  symbol: string,
  precision: number,
): AlertLine[] {
  const s = symbol.toUpperCase();
  const lines: AlertLine[] = [];
  for (const a of alerts) {
    if (a.kind !== 'Price' || a.symbol.toUpperCase() !== s) continue;
    if (a.status !== 'Active' && a.status !== 'Paused') continue;
    const active = a.status === 'Active';
    const channel = a.condition === 'EnteringChannel' || a.condition === 'ExitingChannel';
    const color = !active
      ? ALERT_LINE_COLORS.paused
      : channel
        ? ALERT_LINE_COLORS.channel
        : a.condition === 'CrossingUp'
          ? ALERT_LINE_COLORS.up
          : a.condition === 'CrossingDown'
            ? ALERT_LINE_COLORS.down
            : ALERT_LINE_COLORS.either;
    const title = describeAlert(a, precision);
    const name = a.name?.trim();
    if (typeof a.price === 'number' && a.price > 0)
      lines.push({
        alertId: a.id,
        bound: 'price',
        price: a.price,
        label: `⏰ ${name || priceText(a.price, precision)}`,
        title,
        color,
        active,
      });
    if (channel && typeof a.upperPrice === 'number' && a.upperPrice > 0)
      lines.push({
        alertId: a.id,
        bound: 'upper',
        price: a.upperPrice,
        label: `⏰ ${name || priceText(a.upperPrice, precision)}`,
        title,
        color,
        active,
      });
  }
  return lines;
}

/**
 * The active line a press at `y` grabs (the nearest within {@link GRAB_TOLERANCE_PX}), or null. `toY` is the series'
 * price → pixel projection (null when the price is off the scale).
 */
export function grabbedLine(
  lines: readonly AlertLine[],
  y: number,
  toY: (price: number) => number | null,
  tolerancePx = GRAB_TOLERANCE_PX,
): AlertLine | null {
  let best: AlertLine | null = null;
  let bestDistance = tolerancePx + 1e-9;
  for (const line of lines) {
    if (!line.active) continue;
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

/** The price a drag ends at, rounded to the symbol's digits; null when the pixel is off the scale. */
export function dragPrice(
  y: number,
  fromY: (y: number) => number | null,
  precision: number,
): number | null {
  const p = fromY(y);
  return p === null || !Number.isFinite(p) || p <= 0 ? null : roundTo(p, precision);
}

/** A moved channel bound must keep the channel the right way up; null when it would not. */
export function movedBounds(
  alert: Pick<ChartAlertDto, 'price' | 'upperPrice'>,
  bound: AlertLineBound,
  price: number,
): { price: number; upperPrice: number | null } | null {
  if (bound === 'price') {
    if (alert.upperPrice != null && price >= alert.upperPrice) return null;
    return { price, upperPrice: alert.upperPrice ?? null };
  }
  if (alert.price == null || price <= alert.price) return null;
  return { price: alert.price, upperPrice: price };
}

function priceText(price: number, precision: number): string {
  return price.toFixed(Math.max(0, Math.trunc(precision)));
}
