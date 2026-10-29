import { describe, expect, it } from 'vitest';

import { shadowReasonCategory, topReasons } from './signal-ab-state.logic';

describe('signal A/B state logic', () => {
  it('collapses shadow decision reasons', () => {
    expect(
      shadowReasonCategory(
        'Closed unfinishable: challenger model 935 has no stored weights (a metrics-only row), so not',
      ),
    ).toBe('Closed early: challenger model N has no stored weights');
    expect(
      shadowReasonCategory(
        'Evaluation expired with only 0/50 resolved trades. Champion retained pending review.',
      ),
    ).toBe('Evaluation expired with only N/N resolved trades');
    expect(shadowReasonCategory(null)).toBe('No reason recorded');
  });

  it('counts categories, most frequent first', () => {
    expect(
      topReasons([
        'Evaluation expired with only 0/50 resolved trades. x',
        'Closed unfinishable: challenger model 1 has no stored weights (a)',
        'Closed unfinishable: challenger model 2 has no stored weights (b)',
      ]),
    ).toEqual([
      { reason: 'Closed early: challenger model N has no stored weights', count: 2 },
      { reason: 'Evaluation expired with only N/N resolved trades', count: 1 },
    ]);
  });
});

describe('shadow history for the A/B tab', () => {
  const r = (
    startedAt: string,
    decision: string,
    symbol = 'EURUSD',
    reason = 'Evaluation expired with only 0/50 resolved trades. x',
  ) => ({ symbol, timeframe: 'H1', startedAt, decision, decisionReason: reason });

  it('buckets by Monday-start UTC week', async () => {
    const { shadowByWeek } = await import('./signal-ab-state.logic');
    const w = shadowByWeek([
      r('2026-10-28T10:00:00Z', 'flagged'), // Wednesday → week of 26 Oct
      r('2026-10-26T00:00:00Z', 'promoted'),
      r('2026-10-25T23:00:00Z', 'flagged'), // Sunday → week of 19 Oct
    ]);
    expect(w).toEqual([
      { week: '2026-10-19', promoted: 0, flagged: 1, rejected: 0, pending: 0 },
      { week: '2026-10-26', promoted: 1, flagged: 1, rejected: 0, pending: 0 },
    ]);
  });

  it('groups by pair, busiest first', async () => {
    const { shadowByPair } = await import('./signal-ab-state.logic');
    const p = shadowByPair([
      r('2026-10-01T00:00:00Z', 'flagged'),
      r('2026-10-02T00:00:00Z', 'flagged'),
      r('2026-10-03T00:00:00Z', 'flagged', 'USDJPY'),
    ]);
    expect(p[0]).toMatchObject({
      pair: 'EURUSD H1',
      count: 2,
      promoted: 0,
      latest: '2026-10-02T00:00:00Z',
    });
    expect(p[0].topReason).toBe('Evaluation expired with only N/N resolved trades');
  });
});
