import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THRESHOLDS,
  breachFromAlert,
  breachFromMetrics,
  hasWindowVerdict,
  toneAgainst,
  countsText,
  duration,
  lessonActions,
  pct,
  personLabel,
  reviewBody,
  reviewFormFor,
  reviewProblem,
  scopeLabel,
} from './assistant-ops.logic';
import type { AssistantLesson, AssistantMetrics, AssistantTurnStats } from './assistant-ops.types';

const lesson = (over: Partial<AssistantLesson> = {}): AssistantLesson => ({
  id: 7,
  status: 'Candidate',
  source: 'card_rejection',
  scopeKind: 'global',
  scopeValue: null,
  text: 'Never arm an OCO whose legs are market orders.',
  evidence: 'Rejected: legs were market orders',
  sourceConversationIds: [45861],
  sourceTurnId: 912,
  sourceRef: null,
  createdBy: null,
  reviewedBy: null,
  reviewNote: null,
  createdAtUtc: '2026-11-10T08:00:00Z',
  reviewedAtUtc: null,
  injectedCount: 0,
  lastInjectedAtUtc: null,
  ...over,
});

describe('lessonActions — exactly the transitions the engine accepts', () => {
  it('candidate: approve or reject', () => {
    expect(lessonActions('Candidate').map((a) => [a.kind, a.action])).toEqual([
      ['approve', 'approve'],
      ['reject', 'reject'],
    ]);
  });
  it('approved: edit (re-approve) or retire', () => {
    expect(lessonActions('Approved').map((a) => [a.kind, a.action])).toEqual([
      ['edit', 'approve'],
      ['retire', 'retire'],
    ]);
  });
  it('rejected / retired: restore (approve) only', () => {
    for (const s of ['Rejected', 'Retired'])
      expect(lessonActions(s).map((a) => [a.kind, a.action])).toEqual([['restore', 'approve']]);
  });
  it('an unknown status offers nothing', () => {
    expect(lessonActions('Mystery')).toEqual([]);
  });
});

describe('reviewProblem', () => {
  const form = (over = {}) => ({ ...reviewFormFor(lesson()), ...over });

  it('asks for a reason to reject or retire, not to approve', () => {
    expect(reviewProblem('reject', form())).toMatch(/why/i);
    expect(reviewProblem('retire', form({ note: '  ' }))).toMatch(/why/i);
    expect(reviewProblem('reject', form({ note: 'wrong rule' }))).toBeNull();
    expect(reviewProblem('approve', form())).toBeNull();
  });
  it('needs text and, outside global scope, a scope value', () => {
    expect(reviewProblem('approve', form({ text: '  ' }))).toMatch(/text/);
    expect(reviewProblem('approve', form({ scopeKind: 'symbol', scopeValue: '' }))).toMatch(
      /applies/,
    );
    expect(
      reviewProblem('approve', form({ scopeKind: 'symbol', scopeValue: 'EURUSD' })),
    ).toBeNull();
    expect(reviewProblem('approve', form({ scopeKind: 'planet' }))).toMatch(/where/);
  });
  it('enforces the engine limits', () => {
    expect(reviewProblem('approve', form({ text: 'x'.repeat(2001) }))).toMatch(/2001 of 2000/);
    expect(reviewProblem('reject', form({ note: 'x'.repeat(1001) }))).toMatch(/1001 of 1000/);
    expect(
      reviewProblem('approve', form({ scopeKind: 'route', scopeValue: 'x'.repeat(201) })),
    ).toMatch(/201 of 200/);
  });
});

describe('reviewBody', () => {
  it('approve unchanged sends nothing but an optional note', () => {
    expect(reviewBody('approve', reviewFormFor(lesson()), lesson())).toEqual({});
    expect(reviewBody('approve', { ...reviewFormFor(lesson()), note: ' ok ' }, lesson())).toEqual({
      note: 'ok',
    });
  });
  it('approve with edits sends the changed text and scope', () => {
    const f = {
      ...reviewFormFor(lesson()),
      text: ' New text ',
      scopeKind: 'symbol',
      scopeValue: ' EURUSD ',
    };
    expect(reviewBody('approve', f, lesson())).toEqual({
      text: 'New text',
      scopeKind: 'symbol',
      scopeValue: 'EURUSD',
    });
  });
  it('moving back to global sends the kind without a value', () => {
    const l = lesson({ scopeKind: 'symbol', scopeValue: 'EURUSD', status: 'Approved' });
    expect(reviewBody('edit', { ...reviewFormFor(l), scopeKind: 'global' }, l)).toEqual({
      scopeKind: 'global',
    });
  });
  it('reject / retire send only the reason, never the text', () => {
    const f = { ...reviewFormFor(lesson()), text: 'edited', note: 'duplicate of #3' };
    expect(reviewBody('reject', f, lesson())).toEqual({ note: 'duplicate of #3' });
    expect(reviewBody('retire', f, lesson())).toEqual({ note: 'duplicate of #3' });
  });
});

describe('labels', () => {
  it('names people and scopes plainly', () => {
    expect(personLabel('admin-user:12')).toBe('Operator #12');
    expect(personLabel('admin-user:12', 'Bode O.')).toBe('Bode O.');
    expect(personLabel('admin-user:12', '  ')).toBe('Operator #12');
    expect(personLabel(null)).toBe('—');
    expect(scopeLabel('global', null)).toBe('Everywhere');
    expect(scopeLabel('symbol', 'EURUSD')).toBe('Symbol: EURUSD');
  });
  it('formats rates, durations and counts', () => {
    expect(pct(0.1234)).toBe('12%');
    expect(pct(0.0512)).toBe('5.1%');
    expect(pct(0.5, 0)).toBe('—');
    expect(duration(179)).toBe('3.0 min');
    expect(duration(42)).toBe('42 s');
    expect(duration(0)).toBe('—');
    expect(countsText({ timeout: 1, not_found: 3 })).toBe('not found: 3 · timeout: 1');
    expect(countsText({})).toBe('—');
  });
});

describe('breachFromAlert — the engine alert condition, in words', () => {
  const alert = (key: string, condition: unknown) => ({
    id: 1,
    severity: 'Medium',
    deduplicationKey: key,
    isActive: true,
    lastTriggeredAt: '2026-11-10T07:00:00Z',
    conditionJson: JSON.stringify({ detector: 'AssistantHealth', condition, evaluatedAtUtc: 'x' }),
  });

  it('unverified rate', () => {
    const b = breachFromAlert(
      alert('assistant-health:unverified-rate', {
        Unverified: 9,
        AnswerAttempts: 20,
        rate: 0.45,
        threshold: 30,
      }),
    );
    expect(b.title).toMatch(/unverified/);
    expect(b.detail).toContain('9 of 20 answers (45%)');
    expect(b.detail).toContain('30%');
  });
  it('tool errors name the tool', () => {
    const b = breachFromAlert(
      alert('assistant-health:tool-errors:call_endpoint', {
        Tool: 'call_endpoint',
        Calls: 40,
        Errors: 20,
        rate: 0.5,
        threshold: 40,
      }),
    );
    expect(b.title).toBe('The call_endpoint tool keeps failing');
    expect(b.detail).toContain('20 of 40 calls failed (50%)');
  });
  it('slow questions and spend guard', () => {
    expect(
      breachFromAlert(
        alert('assistant-health:turn-p95', { p95: 1200, p50: 180, Turns: 30, threshold: 900 }),
      ).detail,
    ).toContain('20.0 min');
    expect(
      breachFromAlert(alert('assistant-health:spend-guard', { trips: 2, threshold: 1 })).detail,
    ).toContain('2 question(s)');
  });
  it('a numeric severity and unreadable condition still give a sentence', () => {
    const b = breachFromAlert({
      ...alert('assistant-health:new-rule', {}),
      severity: 2,
      conditionJson: '{oops',
    });
    expect(b.severity).toBe('Medium');
    expect(b.title).toBe('Assistant health alert');
  });
});

const stats = (over: Partial<AssistantTurnStats> = {}): AssistantTurnStats =>
  ({
    turns: 40,
    answered: 30,
    finalAnswerRate: 0.75,
    answerAttempts: 38,
    holdRate: 0.2,
    gateHoldsNumbers: 0,
    gateHoldsAbsence: 0,
    gateHoldsCausal: 0,
    unverifiedRate: 0.4211,
    unverified: 16,
    checkpointRate: 0,
    spendGuardTrips: 2,
    preflightBlocks: 0,
    writesNotRun: 0,
    writesRefused: 0,
    toolParseRetries: 0,
    outcomes: {},
    wallP50Seconds: 200,
    wallP95Seconds: 1000,
    avgRounds: 0,
    avgModelCalls: 0,
    avgToolCalls: 0,
    toolErrorRate: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    avgTokensInput: 0,
    avgTokensOutput: 0,
    cacheHitRatio: 0,
    notionalCostUsd: 0,
    avgNotionalCostUsd: 0,
    ...over,
  }) as AssistantTurnStats;

const metrics = (over: Partial<AssistantMetrics> = {}): AssistantMetrics => ({
  fromUtc: '',
  toUtc: '',
  windowHours: 168,
  all: stats(),
  operator: stats(),
  headless: stats(),
  tools: [
    {
      tool: 'get_candles',
      calls: 160,
      errors: 72,
      errorRate: 0.45,
      errorClasses: { not_found: 60 },
      p50Ms: 0,
      p95Ms: 0,
      truncatedRate: 0,
      avgResultChars: 0,
      parallelShare: 0,
      operatorCalls: 0,
      headlessCalls: 0,
      nonReads: {},
    },
  ],
  approvals: {
    proposed: 0,
    confirmed: 0,
    rejected: 0,
    failed: 0,
    pending: 0,
    approvalRate: 0,
    failedAfterConfirmRate: 0,
  },
  truncated: false,
  ...over,
});

describe('thresholds and the window verdict', () => {
  it('uses the metrics verdict only when the engine sent breaches AND its thresholds', () => {
    expect(hasWindowVerdict(metrics())).toBe(false); // older engine: no field
    expect(hasWindowVerdict(metrics({ breaches: [], thresholds: null }))).toBe(false); // options unavailable
    expect(hasWindowVerdict(metrics({ breaches: [], thresholds: DEFAULT_THRESHOLDS }))).toBe(true);
  });

  it('tones a figure against the engine limit; a limit of 0 is a rule that is off', () => {
    expect(toneAgainst(45, 40, true)).toBe('bad');
    expect(toneAgainst(25, 40, true)).toBe('warn');
    expect(toneAgainst(5, 40, true)).toBe('good');
    expect(toneAgainst(99, 0, true)).toBe('neutral');
    expect(toneAgainst(99, 40, false)).toBe('neutral');
  });

  it('rewrites the known rules from the window figures and the engine limits', () => {
    const m = metrics({
      thresholds: { ...DEFAULT_THRESHOLDS, unverifiedRatePct: 25 },
      breaches: [],
    });
    const u = breachFromMetrics(
      { key: 'assistant-health:unverified-rate', severity: 'Medium', message: 'x' },
      m,
    );
    expect(u.detail).toContain('16 of 38 operator answers (42%)');
    expect(u.detail).toContain('limit is 25%');
    const t = breachFromMetrics(
      { key: 'assistant-health:tool-errors:get_candles', severity: 'Medium', message: 'x' },
      m,
    );
    expect(t.title).toBe('The get_candles tool keeps failing');
    expect(t.detail).toContain('72 of 160 calls failed (45%)');
    expect(t.detail).toContain('not found: 60');
    const p = breachFromMetrics(
      { key: 'assistant-health:turn-p95', severity: 'Medium', message: 'x' },
      m,
    );
    expect(p.detail).toContain('16.7 min');
    expect(p.detail).toContain('15.0 min');
    expect(
      breachFromMetrics(
        { key: 'assistant-health:spend-guard', severity: 'Medium', message: 'x' },
        m,
      ).detail,
    ).toContain('2 question(s)');
  });

  it('shows an unknown rule in the engine’s own words', () => {
    const b = breachFromMetrics(
      { key: 'assistant-health:brand-new', severity: 'High', message: 'Something new crossed.' },
      metrics(),
    );
    expect(b.detail).toBe('Something new crossed.');
    expect(b.severity).toBe('High');
  });
});
