import { BacktestStatus, type LlmBacktestRunSummary } from '@core/services/llm-backtest.service';

export interface ComparablePair {
  left: number;
  right: number;
  /** Plain sentence: why these two. */
  reason: string;
}

const sameSet = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function usable(r: LlmBacktestRunSummary): boolean {
  // The status arrives as the enum integer, or as its name on a string-enum engine.
  const done = r.status === BacktestStatus.Completed || (r.status as unknown) === 'Completed';
  return done && !r.dryRun && (r.sampleCount ?? r.completedPoints ?? 0) > 0;
}

/**
 * The two most recent completed runs that are fair to compare, so the compare page opens full:
 * the newest real run (candidate, right) against the most similar earlier one (baseline, left) —
 * same symbols, timeframes and window first, a different prompt version breaking ties.
 */
export function pickComparablePair(runs: LlmBacktestRunSummary[]): ComparablePair | null {
  const pool = runs.filter(usable).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (pool.length < 2) return null;
  const cand = pool[0];
  let best: { run: LlmBacktestRunSummary; score: number } | null = null;
  for (const r of pool.slice(1)) {
    const symOverlap = r.symbols.some((s) => cand.symbols.includes(s));
    const tfOverlap = r.timeframes.some((t) => cand.timeframes.includes(t));
    if (!symOverlap || !tfOverlap) continue;
    let score = 1;
    if (sameSet(r.symbols, cand.symbols) && sameSet(r.timeframes, cand.timeframes)) score += 3;
    if (r.windowStartUtc === cand.windowStartUtc && r.windowEndUtc === cand.windowEndUtc)
      score += 2;
    if (r.promptVersion !== cand.promptVersion) score += 1;
    if (!best || score > best.score) best = { run: r, score };
  }
  if (!best) return null;
  const b = best.run;
  const same =
    sameSet(b.symbols, cand.symbols) && sameSet(b.timeframes, cand.timeframes)
      ? 'the same symbols and timeframes'
      : 'overlapping symbols';
  const window =
    b.windowStartUtc === cand.windowStartUtc && b.windowEndUtc === cand.windowEndUtc
      ? ' over the same window'
      : '';
  const prompt =
    b.promptVersion !== cand.promptVersion
      ? `, prompt ${b.promptVersion} vs ${cand.promptVersion}`
      : `, both on prompt ${cand.promptVersion}`;
  return {
    left: b.id,
    right: cand.id,
    reason: `Newest completed run #${cand.id} against the most similar earlier run #${b.id} — ${same}${window}${prompt}.`,
  };
}
