/**
 * Training Lab roll-ups: failure causes, per-symbol outcomes and daily activity,
 * computed from the analytics sample of training runs. Pure functions so the
 * spec can pin them without a component.
 */

/** The run fields these roll-ups read (a subset of MLTrainingRunDto). */
export interface TrainingRunLike {
  id: number;
  symbol: string | null;
  status: string;
  errorMessage: string | null;
  startedAt: string;
  completedAt?: string | null;
}

/** Outcome buckets shown on the page. Queued and Running are both "in flight". */
export type RunOutcome = 'Completed' | 'Failed' | 'Cancelled' | 'InFlight';

export function runOutcome(status: string): RunOutcome | null {
  switch (status) {
    case 'Completed':
      return 'Completed';
    case 'Failed':
      return 'Failed';
    case 'Cancelled':
      return 'Cancelled';
    case 'Queued':
    case 'Running':
      return 'InFlight';
    default:
      return null;
  }
}

export const OUTCOME_META: Record<RunOutcome, { label: string; color: string }> = {
  Completed: { label: 'Completed', color: '#34C759' },
  Failed: { label: 'Failed', color: '#FF3B30' },
  Cancelled: { label: 'Cancelled', color: '#AEAEB2' },
  InFlight: { label: 'In flight', color: '#0071E3' },
};

export interface FailureCause {
  /** Plain-language cause. */
  title: string;
  /** What usually fixes it, or null when there is no general advice. */
  hint: string | null;
}

const RETRY_PREFIX = /^\[Permanently failed after \d+ attempt\(s\)\]\s*/i;

/**
 * Turns an engine error message into a cause an operator can act on. Messages
 * carry numbers (sample counts, accuracies), so grouping on the raw text would
 * give every run its own row.
 */
export function classifyFailure(message: string | null | undefined): FailureCause {
  const raw = (message ?? '').trim();
  if (!raw) return { title: 'No error recorded', hint: null };
  const text = raw.replace(RETRY_PREFIX, '');

  if (/sample count .*below minimum/i.test(text)) {
    return {
      title: 'Too few training samples',
      hint: 'The window yields fewer samples than the trainer needs — widen it.',
    };
  }
  if (/label imbalance/i.test(text)) {
    return {
      title: 'Buy/sell labels too one-sided',
      hint: 'The market moved mostly one way in the window, so the labels are lopsided.',
    };
  }
  if (/insufficient candles/i.test(text)) {
    return {
      title: 'Not enough candle history',
      hint: 'Ingest more history for this pair, or pick a longer window.',
    };
  }
  if (/^quality gate failed/i.test(text)) {
    if (/no skill over base rate/i.test(text)) {
      return {
        title: 'Quality gate: no edge over the base rate',
        hint: 'The model trained but did not beat always guessing the majority side.',
      };
    }
    if (/brier/i.test(text)) {
      return { title: 'Quality gate: poorly calibrated (Brier)', hint: null };
    }
    if (/sharpe|f1/i.test(text)) {
      return { title: 'Quality gate: Sharpe / F1 too low', hint: null };
    }
    return { title: 'Quality gate: accuracy too low', hint: null };
  }
  if (/canceling statement|timeout|timed out/i.test(text)) {
    return { title: 'Database query timed out', hint: 'Usually transient — retry the run.' };
  }
  // Unknown: the text before the first colon, numbers masked, so similar
  // messages still share a row.
  const head = text
    .split(':')[0]
    .replace(/-?\d+(\.\d+)?/g, 'N')
    .trim();
  return { title: head.length > 80 ? head.slice(0, 77) + '…' : head, hint: null };
}

export interface FailureReasonRow extends FailureCause {
  count: number;
  /** Share of all failed runs, 0–100. */
  share: number;
  /** The newest failed run with this cause, to open as an example. */
  latestRunId: number;
}

/** Failed runs grouped by cause, most frequent first. */
export function failureReasons(runs: readonly TrainingRunLike[]): FailureReasonRow[] {
  const groups = new Map<string, FailureReasonRow & { latestAt: number }>();
  let total = 0;
  for (const r of runs) {
    if (r.status !== 'Failed') continue;
    total++;
    const cause = classifyFailure(r.errorMessage);
    const at = Date.parse(r.startedAt) || 0;
    const g = groups.get(cause.title);
    if (!g) {
      groups.set(cause.title, { ...cause, count: 1, share: 0, latestRunId: r.id, latestAt: at });
    } else {
      g.count++;
      if (at > g.latestAt) {
        g.latestAt = at;
        g.latestRunId = r.id;
      }
    }
  }
  return [...groups.values()]
    .map(({ latestAt: _latestAt, ...g }) => ({
      ...g,
      share: total > 0 ? (g.count / total) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface SymbolOutcomeRow {
  symbol: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  /** Completed of finished (completed + failed), 0–100, or null when none finished. */
  successPct: number | null;
  lastStartedAt: string | null;
}

/** Runs per symbol with their outcomes, busiest first. */
export function symbolOutcomes(runs: readonly TrainingRunLike[]): SymbolOutcomeRow[] {
  const groups = new Map<string, SymbolOutcomeRow>();
  for (const r of runs) {
    const symbol = r.symbol ?? '—';
    let g = groups.get(symbol);
    if (!g) {
      g = {
        symbol,
        runs: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        inFlight: 0,
        successPct: null,
        lastStartedAt: null,
      };
      groups.set(symbol, g);
    }
    g.runs++;
    const o = runOutcome(r.status);
    if (o === 'Completed') g.completed++;
    else if (o === 'Failed') g.failed++;
    else if (o === 'Cancelled') g.cancelled++;
    else if (o === 'InFlight') g.inFlight++;
    if (r.startedAt && (!g.lastStartedAt || r.startedAt > g.lastStartedAt)) {
      g.lastStartedAt = r.startedAt;
    }
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      successPct:
        g.completed + g.failed > 0 ? (g.completed / (g.completed + g.failed)) * 100 : null,
    }))
    .sort((a, b) => b.runs - a.runs);
}

export interface DailyActivity {
  /** UTC days, oldest first, as YYYY-MM-DD. */
  days: string[];
  /** Run starts per day per outcome, aligned with `days`. */
  series: Record<RunOutcome, number[]>;
  total: number;
}

/**
 * Run starts per UTC day for the last `dayCount` days, split by outcome.
 * Days are UTC because `startedAt` is UTC — bucketing on local midnight shifted
 * evening runs onto the wrong day.
 */
export function dailyActivity(
  runs: readonly TrainingRunLike[],
  now: Date,
  dayCount = 14,
): DailyActivity {
  const days: string[] = [];
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = dayCount - 1; i >= 0; i--) {
    days.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  const index = new Map(days.map((d, i) => [d, i]));
  const series: Record<RunOutcome, number[]> = {
    Completed: days.map(() => 0),
    Failed: days.map(() => 0),
    Cancelled: days.map(() => 0),
    InFlight: days.map(() => 0),
  };
  let total = 0;
  for (const r of runs) {
    if (!r.startedAt) continue;
    const t = Date.parse(r.startedAt);
    if (!Number.isFinite(t)) continue;
    const i = index.get(new Date(t).toISOString().slice(0, 10));
    const o = runOutcome(r.status);
    if (i === undefined || o === null) continue;
    series[o][i]++;
    total++;
  }
  return { days, series, total };
}
