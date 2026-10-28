import type { MLTrainingRunDto } from '@core/api/api.types';

/**
 * Turns a training failure message into a short category so repeated reasons collapse into one
 * line: "[Permanently failed after 3 attempt(s)] Label imbalance out of bounds: buy …" →
 * "Label imbalance out of bounds". Long text without a colon is cut at 60 characters.
 */
export function failureCategory(message: string | null | undefined): string {
  let m = (message ?? '').trim();
  if (!m) return 'No reason recorded';
  m = m.replace(/^\[[^\]]*\]\s*/, '');
  const colon = m.indexOf(':');
  let head = colon > 0 ? m.slice(0, colon) : m;
  head = head.replace(/\s+/g, ' ').trim();
  // "Timeframe D1 is excluded from ML training (MLTraining:ExcludedTimeframes). …" has its colon
  // inside the key — keep the sentence before the parenthesis instead.
  const paren = m.indexOf(' (');
  if (colon > 0 && paren > 0 && paren < colon) head = m.slice(0, paren);
  head = head
    .replace(/\b(D1|H4|H1|M30|M15|M5|M1|W1)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return head.length > 60 ? head.slice(0, 59) + '…' : head;
}

export interface TrainingHistorySummary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  oldestUtc: string | null;
  newestFinishedUtc: string | null;
  /** Failure / cancellation reasons, most frequent first. */
  reasons: { reason: string; count: number }[];
}

/** Summarises a page of recent runs (newest first) without inventing anything beyond it. */
export function summariseRuns(runs: readonly MLTrainingRunDto[]): TrainingHistorySummary {
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let oldest: string | null = null;
  let newestFinished: string | null = null;
  const reasons = new Map<string, number>();
  for (const r of runs) {
    const st = String(r.status);
    if (st === 'Completed') completed++;
    else if (st === 'Failed') failed++;
    else if (st === 'Cancelled') cancelled++;
    if (st === 'Failed' || st === 'Cancelled') {
      const c = failureCategory(r.errorMessage);
      reasons.set(c, (reasons.get(c) ?? 0) + 1);
    }
    if (r.startedAt && (oldest === null || r.startedAt < oldest)) oldest = r.startedAt;
    if (r.completedAt && (newestFinished === null || r.completedAt > newestFinished))
      newestFinished = r.completedAt;
  }
  return {
    total: runs.length,
    completed,
    failed,
    cancelled,
    oldestUtc: oldest,
    newestFinishedUtc: newestFinished,
    reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}
