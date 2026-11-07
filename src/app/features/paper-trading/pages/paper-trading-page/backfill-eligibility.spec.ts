import { describe, expect, it } from 'vitest';

import { backfillCandidates, isBackfillEligible } from './backfill-eligibility';

describe('paper backfill candidates (U06)', () => {
  it('offers Approved strategies only', () => {
    expect(isBackfillEligible({ lifecycleStage: 'Approved' })).toBe(true);
    for (const st of [
      'Draft',
      'PaperTrading',
      'BacktestQualified',
      'ShadowLive',
      'Active',
    ] as const) {
      expect(isBackfillEligible({ lifecycleStage: st })).toBe(false);
    }
  });

  it('filters and sorts by name', () => {
    const list = [
      { name: 'b', lifecycleStage: 'Approved' as const },
      { name: 'x', lifecycleStage: 'Active' as const },
      { name: 'a', lifecycleStage: 'Approved' as const },
    ];
    expect(backfillCandidates(list).map((s) => s.name)).toEqual(['a', 'b']);
  });
});
