import type { PineChartInput } from '../render/build-render-model';
import {
  normalizeBars,
  normalizeDeclaration,
  normalizeOutputs,
  normalizeReport,
  normalizeRunResult,
} from './normalize';

/** What `<app-pine-chart [result]>` renders. */
export type PineChartData = PineChartInput;

/**
 * Input transform for the chart: accepts a `PineChartData`, a §3 run result (`{ compile, bars,
 * outputs, report }` — also `ScriptingService.run()`'s `ScriptRunResult`), or a whole `ResponseData` envelope, and
 * returns normalised chart data (null when there is nothing to draw).
 */
export function toPineChartData(raw: unknown): PineChartData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if ('declaration' in o && !('compile' in o)) {
    return {
      bars: normalizeBars(o['bars']),
      outputs: normalizeOutputs(o['outputs']),
      report: normalizeReport(o['report']),
      declaration: normalizeDeclaration(o['declaration']),
    };
  }
  const run = normalizeRunResult(raw);
  if (!run) return null;
  return {
    bars: run.bars,
    outputs: run.outputs,
    report: run.report,
    declaration: run.compile?.declaration ?? null,
  };
}
