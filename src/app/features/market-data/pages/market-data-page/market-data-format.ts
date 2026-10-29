import type { EChartsOption } from 'echarts';

/** 1.2M / 3.4K / 512 — compact volume for dense cells; "-" when unknown. */
export function formatVolume(v: number | undefined | null): string {
  if (v == null) return '-';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

/**
 * Whether a chart option object carries anything to draw. The page's computeds return `{}` for
 * "nothing yet"; templates swap in a titled empty state instead of handing ECharts an empty canvas.
 */
export function hasSeries(opts: EChartsOption): boolean {
  const s = (opts as { series?: unknown }).series;
  return Array.isArray(s) ? s.length > 0 : s != null;
}
