import type { Logical } from 'lightweight-charts';

/** The part of the time scale {@link xAtLogical} reads. */
export interface LogicalScale {
  logicalToCoordinate(logical: Logical): number | null;
  options(): { barSpacing: number };
}

/**
 * x of a FRACTIONAL logical index — an instant between two bars, an economic event at 12:30 on an
 * H1 chart, a line between the last bar of one day and the first of the next. Lightweight Charts'
 * `logicalToCoordinate` answers only whole indexes (any fraction comes back as 0, which drew every
 * such line on the left edge); bars are evenly spaced, so the whole index's x plus the fraction of a
 * bar's spacing is exact — on screen, before the first bar and past the last.
 */
export function xAtLogical(scale: LogicalScale, logical: number): number | null {
  if (!Number.isFinite(logical)) return null;
  const whole = Math.floor(logical);
  const x = scale.logicalToCoordinate(whole as Logical);
  if (x === null) return null;
  return Number(x) + (logical - whole) * scale.options().barSpacing;
}
