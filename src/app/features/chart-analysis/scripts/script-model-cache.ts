import { buildRenderModel } from '@shared/pine-chart/render/build-render-model';
import type { PineRenderModel } from '@shared/pine-chart/render/render-model';
import type { ChartScriptResult } from './chart-script.model';

/**
 * The shared renderer's model of a chart run (`buildRenderModel`), built once per result and symbol
 * precision. A result object never changes once the page holds it — a live re-run brings a new one —
 * so the model is cached against the object itself and goes with it: the renderer re-applying the
 * scripts (a style change, a theme switch, a new price series), the status line asking for values at
 * every crosshair move and the trade detail reading the series at a fill all share one build.
 */
const cache = new WeakMap<ChartScriptResult, Map<number, PineRenderModel>>();

/** Precision keys the per-result map by: an unknown precision (inferred from the bars) is -1. */
const precisionKey = (p: number | null | undefined): number =>
  p === null || p === undefined || !(p >= 0) ? -1 : Math.min(16, Math.round(p));

/**
 * The render model of a run; null when the run carries no bars (a compile error, a refused run).
 * `pricePrecision` is the symbol's price decimals; omitted, they are inferred from the bars.
 */
export function scriptRenderModel(
  result: ChartScriptResult,
  pricePrecision?: number | null,
): PineRenderModel | null {
  const run = result.run;
  if (!run || run.bars.length === 0) return null;
  const key = precisionKey(pricePrecision);
  let byPrecision = cache.get(result);
  const hit = byPrecision?.get(key);
  if (hit) return hit;
  const model = buildRenderModel(
    {
      bars: run.bars,
      outputs: run.outputs,
      report: run.report,
      declaration: run.compile?.declaration ?? null,
    },
    { pricePrecision: key < 0 ? null : key, trades: true },
  );
  if (!byPrecision) {
    byPrecision = new Map();
    cache.set(result, byPrecision);
  }
  byPrecision.set(key, model);
  return model;
}
