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
