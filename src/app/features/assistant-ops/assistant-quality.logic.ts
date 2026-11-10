/**
 * Pure decisions for the Assistant page's Evals / Quality tabs and the Health tab's efficiency
 * and before/after sections. Kept free of Angular so every rule is unit-tested.
 */
import { ApiError } from '@core/api/api.types';

import { compact, duration, pct, usd } from './assistant-ops.logic';
import type {
  AssistantEvalRun,
  AssistantEvalSettings,
  AssistantHistoryStats,
  AssistantLesson,
  AssistantLoopEfficiency,
  AssistantMetricsCompare,
  AssistantQualityPoint,
} from './assistant-ops.types';

export type QTone = 'good' | 'warn' | 'bad' | 'neutral' | 'live';

// ── Eval runs ────────────────────────────────────────────────────────────────

/** The engine's `-16`: a run is already queued / running, or (lesson) no case matches it. */
export const BUSY_CODE = '-16';

export function evalStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'Queued':
      return 'Waiting to start';
    case 'Running':
      return 'Running';
    case 'Completed':
      return 'Finished';
    case 'BudgetStopped':
      return 'Stopped at the daily token limit';
    case 'Failed':
      return 'Failed';
    default:
      return status || '—';
  }
}

export function evalStatusTone(status: string | null | undefined): QTone {
  switch (status) {
    case 'Queued':
    case 'Running':
      return 'live';
    case 'Completed':
      return 'good';
    case 'BudgetStopped':
      return 'warn';
    case 'Failed':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function evalKindLabel(kind: string): string {
  switch (kind) {
    case 'suite':
      return 'Test suite';
    case 'lesson':
      return 'Lesson replay';
    case 'judge':
      return 'Answer spot check';
    default:
      return kind;
  }
}

export function evalTriggerLabel(trigger: string): string {
  switch (trigger) {
    case 'nightly':
      return 'nightly';
    case 'manual':
      return 'started by hand';
    case 'lesson_approved':
      return 'after a lesson was approved';
    case 'scheduled':
      return 'scheduled';
    default:
      return trigger;
  }
}

/** Wall time of a run: the engine's own figure, or start → finish. */
export function runDuration(run: AssistantEvalRun): string {
  if (run.wallMs > 0) return duration(run.wallMs / 1000);
  if (run.startedAtUtc && run.completedAtUtc) {
    const s = (Date.parse(run.completedAtUtc) - Date.parse(run.startedAtUtc)) / 1000;
    return duration(s);
  }
  return '—';
}

/** "12 of 14 passed (1 skipped)". */
export function casesText(run: AssistantEvalRun): string {
  if (run.casesTotal <= 0) return '—';
  const base = `${run.casesPassed} of ${run.casesTotal - run.casesSkipped} passed`;
  return run.casesSkipped > 0 ? `${base} (${run.casesSkipped} skipped)` : base;
}

export interface TrendPoint {
  at: string;
  runId: number;
  passRate: number;
  meanScore: number | null;
}

/** The nightly suite trend: finished suite runs with a pass rate, oldest first. */
export function evalTrend(runs: readonly AssistantEvalRun[]): TrendPoint[] {
  return runs
    .filter(
      (r) =>
        r.kind === 'suite' &&
        (r.status === 'Completed' || r.status === 'BudgetStopped') &&
        r.passRate != null,
    )
    .map((r) => ({
      at: r.completedAtUtc ?? r.startedAtUtc ?? r.queuedAtUtc,
      runId: r.id,
      passRate: r.passRate as number,
      meanScore: r.meanScore,
    }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export interface TokenBudget {
  spent: number;
  ceiling: number;
  /** 0..1 (capped); 0 when there is no ceiling. */
  share: number;
  text: string;
  tone: QTone;
}

/** Today's eval + judge token use against `Llm:AssistantEvalDailyTokenCeiling`. */
export function tokenBudget(s: AssistantEvalSettings | null | undefined): TokenBudget | null {
  if (!s) return null;
  const spent = Math.max(0, s.tokensSpentToday || 0);
  const ceiling = Math.max(0, s.dailyTokenCeiling || 0);
  if (ceiling === 0)
    return {
      spent,
      ceiling,
      share: 0,
      text: `${compact(spent)} tokens today (no daily limit)`,
      tone: 'neutral',
    };
  const share = Math.min(1, spent / ceiling);
  return {
    spent,
    ceiling,
    share,
    text: `${compact(spent)} of ${compact(ceiling)} tokens today (${pct(spent / ceiling)})`,
    tone: share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : 'good',
  };
}

/** The refusal of `POST evals/run` / `lessons/{id}/evaluate`, in the operator's words. */
export function queueRefusalText(err: unknown, what: 'run' | 'lesson'): string {
  if (err instanceof ApiError) {
    if (err.code === BUSY_CODE)
      return what === 'run'
        ? `Not started: ${err.message || 'a test run is already waiting or running.'}`
        : `Not queued: ${err.message || 'a replay is already running, or no test case matches this lesson.'}`;
    return err.message || 'The engine refused the request.';
  }
  if ((err as { status?: unknown } | null)?.status === 0)
    return 'The engine could not be reached; nothing was queued.';
  const m = (err as { message?: string } | null)?.message;
  return m || 'The engine did not answer. Is it reachable?';
}

// ── Lesson replay outcome ────────────────────────────────────────────────────

export interface LessonEvalView {
  text: string;
  tone: QTone;
  runId: number | null;
  at: string | null;
  live: boolean;
}

/** What the latest with/without replay said about a lesson, or null when it was never replayed. */
export function lessonEvalOf(l: AssistantLesson): LessonEvalView | null {
  if (!l.evalStatus && l.evalRunId == null) return null;
  const runId = l.evalRunId ?? null;
  const at = l.evalAtUtc ?? null;
  const status = l.evalStatus ?? '';
  if (status === 'Queued' || status === 'Running')
    return {
      text: status === 'Queued' ? 'Replay waiting to start' : 'Replay running',
      tone: 'live',
      runId,
      at,
      live: true,
    };
  if (status === 'Failed') return { text: 'Replay failed', tone: 'bad', runId, at, live: false };
  const imp = l.evalImproved ?? 0;
  const wor = l.evalWorsened ?? 0;
  const unc = l.evalUnchanged ?? 0;
  const counts = `${imp} better, ${wor} worse, ${unc} unchanged`;
  const stopped = status === 'BudgetStopped' ? ' (stopped at the daily token limit)' : '';
  if (wor > imp)
    return { text: `Made answers worse: ${counts}${stopped}`, tone: 'bad', runId, at, live: false };
  if (imp > wor)
    return {
      text: `Made answers better: ${counts}${stopped}`,
      tone: 'good',
      runId,
      at,
      live: false,
    };
  return { text: `No difference: ${counts}${stopped}`, tone: 'neutral', runId, at, live: false };
}

// ── Before / after ───────────────────────────────────────────────────────────

/** The day the telemetry tables (and the harness changes) shipped. */
export const HARNESS_CUTOVER = '2026-11-10';

export interface CompareWindows {
  baselineFrom: string;
  baselineTo: string;
  from: string;
  to: string;
}

/** Default: the 30 days before the cut-over against everything since (dates as yyyy-MM-dd, UTC). */
export function defaultCompareWindows(now: Date = new Date()): CompareWindows {
  const cut = new Date(`${HARNESS_CUTOVER}T00:00:00Z`);
  const before = new Date(cut.getTime() - 30 * 86_400_000);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const to =
    tomorrow.getTime() > cut.getTime() + 86_400_000
      ? tomorrow
      : new Date(cut.getTime() + 86_400_000);
  return {
    baselineFrom: isoDay(before),
    baselineTo: HARNESS_CUTOVER,
    from: HARNESS_CUTOVER,
    to: isoDay(to),
  };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Null when the windows are fine; otherwise why they cannot be compared (mirrors the engine). */
export function compareWindowsProblem(w: CompareWindows): string | null {
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  for (const v of [w.baselineFrom, w.baselineTo, w.from, w.to])
    if (!v || Number.isNaN(Date.parse(v))) return 'Pick all four dates.';
  if (days(w.baselineFrom, w.baselineTo) <= 0)
    return 'The "before" window must end after it starts.';
  if (days(w.from, w.to) <= 0) return 'The "after" window must end after it starts.';
  if (days(w.baselineFrom, w.baselineTo) > 92 || days(w.from, w.to) > 92)
    return 'Each window can be at most 92 days.';
  return null;
}

type Fmt = 'pct' | 'num' | 'tokens' | 'seconds' | 'count';

/** Lower is better for every figure except the cache hit ratio and (neutral) question counts. */
const FIGURES: ReadonlyArray<{
  key: keyof AssistantHistoryStats & string;
  label: string;
  hint: string;
  fmt: Fmt;
  better: 'lower' | 'higher' | null;
}> = [
  {
    key: 'questions',
    label: 'Questions',
    hint: 'operator questions asked',
    fmt: 'count',
    better: null,
  },
  {
    key: 'heldRate',
    label: 'Held by the checks',
    hint: 'answers sent back for a fix at least once',
    fmt: 'pct',
    better: 'lower',
  },
  {
    key: 'unverifiedRate',
    label: 'Posted unverified',
    hint: 'answers posted with the “could not verify” notice',
    fmt: 'pct',
    better: 'lower',
  },
  {
    key: 'avgRounds',
    label: 'Rounds per question',
    hint: 'back-and-forths with the model',
    fmt: 'num',
    better: 'lower',
  },
  {
    key: 'avgToolCalls',
    label: 'Tool calls per question',
    hint: 'engine reads and proposed writes',
    fmt: 'num',
    better: null,
  },
  {
    key: 'toolErrorRate',
    label: 'Tool errors',
    hint: 'tool results that came back as an error',
    fmt: 'pct',
    better: 'lower',
  },
  {
    key: 'avgTokensInput',
    label: 'Tokens in per question',
    hint: 'text sent to the model',
    fmt: 'tokens',
    better: 'lower',
  },
  {
    key: 'avgTokensOutput',
    label: 'Tokens out per question',
    hint: 'text the model wrote',
    fmt: 'tokens',
    better: 'lower',
  },
  {
    key: 'cacheHitRatio',
    label: 'Prompt cache hits',
    hint: 'input the model had already seen (cheaper, faster)',
    fmt: 'pct',
    better: 'higher',
  },
  {
    key: 'wallP50Seconds',
    label: 'Typical time per question',
    hint: 'half the questions took less',
    fmt: 'seconds',
    better: 'lower',
  },
  {
    key: 'wallP95Seconds',
    label: 'Slowest 5% took',
    hint: 'time per question, slow end',
    fmt: 'seconds',
    better: 'lower',
  },
];

export interface CompareRow {
  key: string;
  label: string;
  hint: string;
  baseline: string;
  current: string;
  change: string;
  /** good = moved the right way, bad = the wrong way, neutral = no preference / no change. */
  tone: QTone;
  approx: boolean;
}

function fmt(v: number | null | undefined, f: Fmt): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (f) {
    case 'pct':
      return pct(v);
    case 'tokens':
      return compact(v);
    case 'seconds':
      return duration(v);
    case 'count':
      return String(Math.round(v));
    default:
      return (Math.round(v * 100) / 100).toString();
  }
}

function fmtDelta(d: number, f: Fmt): string {
  if (!Number.isFinite(d) || d === 0) return 'no change';
  const sign = d > 0 ? '+' : '−';
  const a = Math.abs(d);
  switch (f) {
    case 'pct': {
      const pts = a * 100;
      return `${sign}${pts >= 10 ? pts.toFixed(0) : pts.toFixed(1)} pts`;
    }
    case 'tokens':
      return `${sign}${compact(a)}`;
    case 'seconds':
      return `${sign}${duration(a)}`;
    case 'count':
      return `${sign}${Math.round(a)}`;
    default:
      return `${sign}${Math.round(a * 100) / 100}`;
  }
}

/** Each history figure side by side, with the change and whether it is approximate. */
export function compareRows(c: AssistantMetricsCompare | null | undefined): CompareRow[] {
  if (!c) return [];
  const b = c.baseline.history;
  const n = c.current.history;
  return FIGURES.map((f) => {
    const bv = b?.[f.key] as number | undefined;
    const nv = n?.[f.key] as number | undefined;
    const d =
      c.historyDeltas?.[f.key] ??
      (typeof bv === 'number' && typeof nv === 'number' ? nv - bv : Number.NaN);
    let tone: QTone = 'neutral';
    if (f.better && Number.isFinite(d) && d !== 0)
      tone = d < 0 === (f.better === 'lower') ? 'good' : 'bad';
    const approx = (n?.exactness?.[f.key] ?? b?.exactness?.[f.key] ?? 'exact')
      .toLowerCase()
      .startsWith('approx');
    return {
      key: f.key,
      label: f.label,
      hint: f.hint,
      baseline: fmt(bv, f.fmt),
      current: fmt(nv, f.fmt),
      change: Number.isFinite(d) ? fmtDelta(d, f.fmt) : '—',
      tone,
      approx,
    };
  });
}

// ── Loop efficiency ──────────────────────────────────────────────────────────

export interface EfficiencyView {
  quiet: boolean;
  protocol: { label: string; share: string; count: number; hint: string }[];
  prefix: { share: string; reused: string; rendered: string };
  routing: {
    routedShare: string;
    escalationRate: string;
    reasons: string;
    costRouted: string;
    costMain: string;
  };
  models: { model: string; count: number; share: number }[];
}

export function efficiencyView(
  e: AssistantLoopEfficiency | null | undefined,
): EfficiencyView | null {
  if (!e) return null;
  const q = e.questions || 0;
  const reasons = Object.entries(e.escalationReasons ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`)
    .join(', ');
  const models = Object.entries(e.questionsByModel ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => ({ model, count, share: q > 0 ? count / q : 0 }));
  return {
    quiet: q === 0,
    protocol: [
      {
        label: 'Native tool calls',
        share: pct(e.nativeShare),
        count: e.nativeRounds,
        hint: 'the model asked for tools through the provider’s own tool interface',
      },
      {
        label: 'Text markers',
        share: pct(e.sentinelShare),
        count: e.sentinelRounds,
        hint: 'the older way: tool requests written as marked text in the reply',
      },
      {
        label: 'Fell back to text markers',
        share: pct(e.nativeFallbackShare),
        count: e.nativeFallbackRounds,
        hint: 'native tools were tried and the round had to fall back',
      },
    ],
    prefix: {
      share: pct(e.prefixReuseShare),
      reused: pct(e.cacheHitRatioPrefixReused),
      rendered: pct(e.cacheHitRatioPrefixRendered),
    },
    routing: {
      routedShare: pct(e.routedShare),
      escalationRate: e.routed > 0 ? pct(e.escalationRate) : '—',
      reasons: reasons || 'none',
      costRouted: e.routed > e.escalated ? usd(e.avgNotionalCostRoutedUsd) : '—',
      costMain: usd(e.avgNotionalCostMainUsd),
    },
    models,
  };
}

// ── Quality ──────────────────────────────────────────────────────────────────

export const RUBRIC: ReadonlyArray<{
  key: 'correctness' | 'completeness' | 'clarity' | 'honesty';
  label: string;
  hint: string;
}> = [
  { key: 'correctness', label: 'Correct', hint: 'the facts and figures are right' },
  { key: 'completeness', label: 'Complete', hint: 'it answered everything that was asked' },
  { key: 'clarity', label: 'Clear', hint: 'plain, well-organised, easy to act on' },
  { key: 'honesty', label: 'Honest', hint: 'says what it checked and what it could not' },
];

/** Score 1-5 → tone (≤2 bad, 3 warn, ≥4 good). */
export function scoreTone(v: number | null | undefined): QTone {
  if (v == null || !Number.isFinite(v) || v <= 0) return 'neutral';
  return v <= 2 ? 'bad' : v < 4 ? 'warn' : 'good';
}

export function qualityTrendIsEmpty(
  points: readonly AssistantQualityPoint[] | null | undefined,
): boolean {
  return !points || points.length === 0;
}
