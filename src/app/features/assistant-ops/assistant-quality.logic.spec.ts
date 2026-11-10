import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';

import {
  compareRows,
  compareWindowsProblem,
  defaultCompareWindows,
  efficiencyView,
  evalTrend,
  lessonEvalOf,
  queueRefusalText,
  runDuration,
  casesText,
  scoreTone,
  tokenBudget,
} from './assistant-quality.logic';
import type {
  AssistantEvalRun,
  AssistantEvalSettings,
  AssistantHistoryStats,
  AssistantLesson,
  AssistantMetricsCompare,
} from './assistant-ops.types';

const run = (over: Partial<AssistantEvalRun>): AssistantEvalRun => ({
  id: 1,
  kind: 'suite',
  trigger: 'nightly',
  status: 'Completed',
  lessonId: null,
  model: null,
  resolvedModel: null,
  promptHash: null,
  caseIds: [],
  requestedBy: null,
  queuedAtUtc: '2026-11-08T02:00:00Z',
  startedAtUtc: '2026-11-08T02:01:00Z',
  completedAtUtc: '2026-11-08T02:11:00Z',
  casesTotal: 10,
  casesPassed: 8,
  casesFailed: 1,
  casesSkipped: 1,
  passRate: 0.89,
  meanScore: 0.93,
  modelCalls: 40,
  tokensInput: 1,
  tokensOutput: 1,
  tokensCacheRead: 0,
  wallMs: 0,
  improved: null,
  worsened: null,
  unchanged: null,
  summary: null,
  error: null,
  ...over,
});

describe('eval runs', () => {
  it('builds the suite trend from finished suite runs, oldest first', () => {
    const t = evalTrend([
      run({ id: 3, completedAtUtc: '2026-11-09T02:10:00Z' }),
      run({ id: 2, status: 'Running', passRate: null }),
      run({ id: 4, kind: 'lesson' }),
      run({
        id: 1,
        status: 'BudgetStopped',
        completedAtUtc: '2026-11-07T02:10:00Z',
        passRate: 0.5,
      }),
    ]);
    expect(t.map((p) => p.runId)).toEqual([1, 3]);
  });

  it('words cases and duration', () => {
    expect(casesText(run({}))).toBe('8 of 9 passed (1 skipped)');
    expect(runDuration(run({}))).toBe('10.0 min');
    expect(runDuration(run({ wallMs: 42_000 }))).toBe('42 s');
  });

  it('measures today’s tokens against the ceiling', () => {
    const s = { tokensSpentToday: 850_000, dailyTokenCeiling: 1_000_000 } as AssistantEvalSettings;
    expect(tokenBudget(s)).toMatchObject({ share: 0.85, tone: 'warn' });
    expect(tokenBudget({ ...s, tokensSpentToday: 2_000_000 })?.tone).toBe('bad');
    expect(tokenBudget({ ...s, dailyTokenCeiling: 0 })?.text).toMatch(/no daily limit/);
    expect(tokenBudget(null)).toBeNull();
  });

  it('words a busy refusal (-16)', () => {
    const err = new ApiError('-16', 'A suite run is already queued.', {} as never);
    expect(queueRefusalText(err, 'run')).toBe('Not started: A suite run is already queued.');
    expect(queueRefusalText(new ApiError('-16', '', {} as never), 'lesson')).toMatch(
      /no test case matches/,
    );
    expect(queueRefusalText({ message: 'down' }, 'run')).toBe('down');
  });
});

describe('lessonEvalOf', () => {
  const l = (over: Partial<AssistantLesson>) =>
    ({ id: 1, status: 'Approved', ...over }) as AssistantLesson;
  it('is null when the lesson was never replayed', () => {
    expect(lessonEvalOf(l({}))).toBeNull();
  });
  it('reads better / worse / no difference', () => {
    expect(
      lessonEvalOf(
        l({
          evalStatus: 'Completed',
          evalRunId: 9,
          evalImproved: 3,
          evalWorsened: 1,
          evalUnchanged: 2,
        }),
      ),
    ).toMatchObject({
      tone: 'good',
      runId: 9,
      text: 'Made answers better: 3 better, 1 worse, 2 unchanged',
    });
    expect(
      lessonEvalOf(l({ evalStatus: 'Completed', evalImproved: 0, evalWorsened: 2 }))?.tone,
    ).toBe('bad');
    expect(
      lessonEvalOf(
        l({ evalStatus: 'Completed', evalImproved: 0, evalWorsened: 0, evalUnchanged: 4 }),
      )?.text,
    ).toMatch(/^No difference/);
  });
  it('shows a live replay', () => {
    expect(lessonEvalOf(l({ evalStatus: 'Queued', evalRunId: 9 }))).toMatchObject({
      live: true,
      tone: 'live',
    });
  });
});

describe('before / after', () => {
  it('defaults to the 30 days before the cut-over against since', () => {
    expect(defaultCompareWindows(new Date('2026-11-12T10:00:00Z'))).toEqual({
      baselineFrom: '2026-10-11',
      baselineTo: '2026-11-10',
      from: '2026-11-10',
      to: '2026-11-13',
    });
  });

  it('validates the windows like the engine', () => {
    const ok = defaultCompareWindows(new Date('2026-11-12T00:00:00Z'));
    expect(compareWindowsProblem(ok)).toBeNull();
    expect(compareWindowsProblem({ ...ok, baselineTo: ok.baselineFrom })).toMatch(/before/);
    expect(compareWindowsProblem({ ...ok, baselineFrom: '2026-01-01' })).toMatch(/92 days/);
    expect(compareWindowsProblem({ ...ok, to: '' })).toMatch(/all four/);
  });

  const h = (over: Partial<AssistantHistoryStats>): AssistantHistoryStats => ({
    questions: 100,
    answerAttempts: 90,
    heldRate: 0.3,
    held: 27,
    unverifiedRate: 0.1,
    unverified: 9,
    avgRounds: 4,
    avgToolCalls: 7,
    toolErrorRate: 0.05,
    avgTokensInput: 40_000,
    avgTokensOutput: 2_000,
    cacheHitRatio: 0.5,
    wallP50Seconds: 120,
    wallP95Seconds: 600,
    truncated: false,
    exactness: { heldRate: 'exact', avgRounds: 'approx', cacheHitRatio: 'approx' },
    ...over,
  });

  it('puts each figure side by side with the change, its direction and exactness', () => {
    const cmp: AssistantMetricsCompare = {
      baseline: { fromUtc: '', toUtc: '', history: h({}), telemetry: null, telemetryFromUtc: null },
      current: {
        fromUtc: '',
        toUtc: '',
        history: h({ heldRate: 0.18, cacheHitRatio: 0.7, avgRounds: 4 }),
        telemetry: null,
        telemetryFromUtc: null,
      },
      historyDeltas: { heldRate: -0.12, avgRounds: 0 },
      telemetryDeltas: null,
      notes: [],
    };
    const rows = compareRows(cmp);
    const held = rows.find((r) => r.key === 'heldRate')!;
    expect(held).toMatchObject({
      baseline: '30%',
      current: '18%',
      change: '−12 pts',
      tone: 'good',
      approx: false,
    });
    const cache = rows.find((r) => r.key === 'cacheHitRatio')!;
    expect(cache).toMatchObject({ change: '+20 pts', tone: 'good', approx: true });
    expect(rows.find((r) => r.key === 'avgRounds')).toMatchObject({
      change: 'no change',
      tone: 'neutral',
      approx: true,
    });
    expect(rows.find((r) => r.key === 'questions')?.tone).toBe('neutral');
    expect(compareRows(null)).toEqual([]);
  });

  it('marks a worse figure', () => {
    const cmp = {
      baseline: { history: h({}) },
      current: { history: h({ wallP95Seconds: 900 }) },
      historyDeltas: {},
      notes: [],
    } as unknown as AssistantMetricsCompare;
    expect(compareRows(cmp).find((r) => r.key === 'wallP95Seconds')).toMatchObject({
      tone: 'bad',
      change: '+5.0 min',
    });
  });
});

describe('efficiencyView', () => {
  it('is null on an older engine and quiet with no questions', () => {
    expect(efficiencyView(undefined)).toBeNull();
    expect(efficiencyView({ questions: 0 } as never)?.quiet).toBe(true);
  });
  it('orders models and reasons by count', () => {
    const v = efficiencyView({
      questions: 10,
      nativeRounds: 30,
      sentinelRounds: 5,
      nativeFallbackRounds: 1,
      nativeShare: 0.83,
      sentinelShare: 0.14,
      nativeFallbackShare: 0.03,
      prefixReusedQuestions: 6,
      prefixReuseShare: 0.6,
      cacheHitRatioPrefixReused: 0.8,
      cacheHitRatioPrefixRendered: 0.3,
      routed: 4,
      routedShare: 0.4,
      escalated: 1,
      escalationRate: 0.25,
      escalationReasons: { tool_needed: 1, long_question: 3 },
      questionsByModel: { sonnet: 3, opus: 7 },
      avgNotionalCostRoutedUsd: 0.02,
      avgNotionalCostMainUsd: 0.2,
    })!;
    expect(v.models.map((m) => m.model)).toEqual(['opus', 'sonnet']);
    expect(v.routing.reasons).toBe('long question (3), tool needed (1)');
    expect(v.routing.costRouted).toBe('$0.020');
    expect(v.prefix.reused).toBe('80%');
  });
});

describe('scoreTone', () => {
  it('bands 1-5 scores', () => {
    expect(scoreTone(1.5)).toBe('bad');
    expect(scoreTone(3.4)).toBe('warn');
    expect(scoreTone(4.2)).toBe('good');
    expect(scoreTone(0)).toBe('neutral');
  });
});
