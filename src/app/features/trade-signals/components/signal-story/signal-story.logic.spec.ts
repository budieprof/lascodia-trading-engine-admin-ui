import { describe, expect, it } from 'vitest';
import {
  foldTimeline,
  missingSignalSentence,
  originHeading,
  originRoute,
  outcomeSentence,
} from './signal-story.logic';
import type { SignalStory, SignalStoryCounts } from './signal-story.types';

const range = {
  totalSignals: 7992,
  earliestId: 1381,
  earliestGeneratedAt: '2026-05-07T10:38:27Z',
  latestId: 9374,
  previousId: null,
  nextId: 1381,
};

const counts = (over: Partial<SignalStoryCounts> = {}): SignalStoryCounts => ({
  accountAttempts: 0,
  accountsPassed: 0,
  accountsBlocked: 0,
  orders: 0,
  ordersFilled: 0,
  positions: 0,
  positionsOpen: 0,
  realizedPnL: 0,
  eaRejections: 0,
  engineRejections: 0,
  ...over,
});

const story = (c: SignalStoryCounts) => ({ counts: c }) as SignalStory;

describe('signal-story.logic', () => {
  it('explains an id below the oldest signal', () => {
    const t = missingSignalSentence(42, range);
    expect(t).toContain('oldest signal this engine still holds is #1381');
    expect(t).toContain('07 May 2026');
  });

  it('explains an id above the newest and a gap in the middle', () => {
    expect(missingSignalSentence(9999, range)).toContain('newest signal is #9374');
    expect(missingSignalSentence(5000, range)).toContain('skipped or the row was deleted');
    expect(missingSignalSentence(1, { ...range, earliestId: null, latestId: null })).toContain(
      'no signals at all',
    );
  });

  it('origin heading + route', () => {
    const o = {
      kind: 'recommendation',
      recommendationId: 229,
      pendingSignalRecId: null,
      patientTraderPlanId: 7,
      analyserDecisionId: null,
      summary: null,
      rationale: null,
      confidence: null,
      at: null,
    };
    expect(originHeading(o)).toBe('Recommendation #229');
    expect(originRoute(o)).toBe('/trade-recommendations/229');
    expect(originRoute({ ...o, recommendationId: null })).toBe('/patient-trader');
  });

  it('outcome reads the counts in order of what matters', () => {
    expect(outcomeSentence(story(counts({ orders: 5 })))).toEqual({
      text: '5 order(s), none filled',
      tone: 'warn',
    });
    expect(
      outcomeSentence(story(counts({ orders: 1, ordersFilled: 1, realizedPnL: -3.5 }))).tone,
    ).toBe('bad');
    expect(outcomeSentence(story(counts({ engineRejections: 1 }))).text).toBe(
      'Refused by the engine',
    );
    expect(outcomeSentence(story(counts())).text).toBe('Never traded');
  });

  it('folds consecutive duplicates', () => {
    const e = (kind: string, title: string) =>
      ({
        at: '2026-10-01T00:00:00Z',
        kind,
        title,
        detail: null,
        tone: 'info',
        route: null,
      }) as const;
    const out = foldTimeline([e('a', 'x'), e('a', 'x'), e('b', 'y'), e('a', 'x')]);
    expect(out.map((r) => r.repeat)).toEqual([2, 1, 1]);
  });
});
