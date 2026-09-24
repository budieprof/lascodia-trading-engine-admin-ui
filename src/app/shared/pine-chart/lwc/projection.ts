import type { IChartApiBase, ISeriesApi, Logical, SeriesType, Time } from 'lightweight-charts';

/**
 * Pixel projection of one pane for one frame: what every painter draws through.
 *
 * The time scale is linear in logical index, so x is computed from two probes rather than one
 * library call per point. The price scale is linear in price in every mode except logarithmic, so y
 * is too (two probes per frame); log mode falls back to the series converter per point. At 20,000
 * bars × dozens of plots that difference is the frame budget.
 */
export interface Projection {
  /** Pane size in CSS px. */
  readonly width: number;
  readonly height: number;
  /** x (CSS px, pane-relative) of a logical index; extrapolates past both ends. */
  x(logical: number): number;
  /** y of a price; NaN when the pane has no price scale yet. */
  y(price: number): number;
  readonly barSpacing: number;
  /** Visible logical range, inclusive, padded by one bar each side. */
  readonly from: number;
  readonly to: number;
  /** Logical index of the chart's last bar. */
  readonly lastLogical: number;
}

export function createProjection(
  chart: IChartApiBase<Time>,
  series: ISeriesApi<SeriesType, Time>,
  width: number,
  height: number,
  lastLogical: number,
): Projection | null {
  const ts = chart.timeScale();
  const range = ts.getVisibleLogicalRange();
  if (!range) return null;
  const xa = ts.logicalToCoordinate(0 as Logical);
  const xb = ts.logicalToCoordinate(1 as Logical);
  if (xa === null || xb === null) return null;
  const barSpacing = xb - xa;
  const x = (logical: number) => xa + logical * barSpacing;

  let y: (price: number) => number;
  const mode = series.priceScale().options().mode;
  if (mode === 1 /* PriceScaleMode.Logarithmic */) {
    y = (price: number) => {
      const c = series.priceToCoordinate(price);
      return c === null ? NaN : c;
    };
  } else {
    const y0 = series.priceToCoordinate(0);
    const y1 = series.priceToCoordinate(1);
    if (y0 === null || y1 === null || !Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const k = y1 - y0;
    y = (price: number) => y0 + price * k;
  }
  return {
    width,
    height,
    x,
    y,
    barSpacing,
    from: Math.floor(range.from) - 1,
    to: Math.ceil(range.to) + 1,
    lastLogical,
  };
}

/** A projection with explicit linear mappings (tests, snapshots). */
export function linearProjection(opts: {
  width?: number;
  height?: number;
  x0?: number;
  barSpacing?: number;
  /** y of price 0 and px per price unit (negative: prices grow upward). */
  y0?: number;
  pxPerUnit?: number;
  from?: number;
  to?: number;
  lastLogical?: number;
}): Projection {
  const x0 = opts.x0 ?? 0;
  const bs = opts.barSpacing ?? 10;
  const y0 = opts.y0 ?? 100;
  const k = opts.pxPerUnit ?? -1;
  return {
    width: opts.width ?? 1000,
    height: opts.height ?? 500,
    x: (l) => x0 + l * bs,
    y: (p) => y0 + p * k,
    barSpacing: bs,
    from: opts.from ?? -1,
    to: opts.to ?? 1000,
    lastLogical: opts.lastLogical ?? 1000,
  };
}
