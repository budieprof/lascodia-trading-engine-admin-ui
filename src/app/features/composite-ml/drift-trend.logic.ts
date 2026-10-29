import type { CatalogueDriftHistoryDto } from '@core/api/api.types';

export interface TrendPoint {
  t: string;
  /** Observed evidence as a percentage of the warm threshold, capped at 200 so one runaway gate
   *  does not flatten the others. */
  pct: number;
  observed: number;
  threshold: number;
}

export interface TrendSeries {
  layerKey: string;
  scope: string;
  points: TrendPoint[];
  latestPct: number | null;
  /** First sample in the window at or above 100 %, or null. */
  warmSinceUtc: string | null;
}

export function toTrendSeries(h: CatalogueDriftHistoryDto): TrendSeries {
  const points = [...h.points]
    .sort((a, b) => a.evaluatedAtUtc.localeCompare(b.evaluatedAtUtc))
    .map((p) => ({
      t: p.evaluatedAtUtc,
      observed: p.observedCount,
      threshold: p.threshold,
      pct:
        p.threshold > 0
          ? Math.min(200, Math.round((p.observedCount / p.threshold) * 1000) / 10)
          : p.isWarm
            ? 100
            : 0,
    }));
  const last = points.length ? points[points.length - 1] : null;
  // The current warm streak: walk back from the newest sample while it stays ≥ 100 %.
  let warmSince: string | null = null;
  for (let i = points.length - 1; i >= 0 && points[i].pct >= 100; i--) warmSince = points[i].t;
  return {
    layerKey: h.layerKey,
    scope: h.symbol ? `${h.symbol}${h.timeframe ? ' · ' + h.timeframe : ''}` : 'global',
    points,
    latestPct: last ? last.pct : null,
    warmSinceUtc: warmSince,
  };
}

export interface TrendSummary {
  gates: number;
  warm: number;
  cold: number;
  /** The cold gate closest to warm. */
  nearest: { layerKey: string; pct: number } | null;
  samples: number;
  firstSampleUtc: string | null;
}

export function summariseTrends(series: readonly TrendSeries[]): TrendSummary {
  let warm = 0;
  let samples = 0;
  let first: string | null = null;
  let nearest: { layerKey: string; pct: number } | null = null;
  for (const s of series) {
    samples += s.points.length;
    if (s.points.length && (first === null || s.points[0].t < first)) first = s.points[0].t;
    if ((s.latestPct ?? 0) >= 100) warm++;
    else if (
      s.latestPct !== null &&
      s.latestPct > 0 &&
      (nearest === null || s.latestPct > nearest.pct)
    )
      nearest = { layerKey: s.layerKey, pct: s.latestPct };
  }
  return {
    gates: series.length,
    warm,
    cold: series.length - warm,
    nearest,
    samples,
    firstSampleUtc: first,
  };
}
