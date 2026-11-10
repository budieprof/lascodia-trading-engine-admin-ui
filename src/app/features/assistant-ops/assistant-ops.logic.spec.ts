import { describe, expect, it } from 'vitest';

import {
  breachFromAlert,
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
import type { AssistantLesson } from './assistant-ops.types';

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
