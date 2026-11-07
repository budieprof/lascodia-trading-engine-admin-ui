import { describe, expect, it } from 'vitest';

import type { OptimizationCandidateDto } from './research.types';
import { topCandidatesWithDiff } from './top-candidates';

const cand = (
  rank: number,
  parameters: Record<string, unknown>,
  expectancyR: number | null,
  isWinner = false,
): OptimizationCandidateDto => ({
  rank,
  parametersJson: null,
  parameters,
  healthScore: null,
  expectancyR,
  sharpeR: null,
  trades: 100,
  rTrades: 100,
  isWinner,
  folds: [],
});

describe('topCandidatesWithDiff (U10)', () => {
  it('diffs every row against the chosen candidate and lists only what changes', () => {
    const rows = [
      cand(1, { len: 20, mult: 2, __ScriptInputs: 'x' }, 0.3),
      cand(2, { len: 14, mult: 2 }, 0.25, true),
      cand(3, { len: 14, mult: 2.5, extra: true }, 0.1),
    ];
    const out = topCandidatesWithDiff(rows, 10);
    expect(out.reference!.rank).toBe(2);
    expect(out.rows[0].changes).toEqual([{ id: 'len', from: '14', to: '20' }]);
    expect(out.rows[0].deltaExpectancyR).toBeCloseTo(0.05, 10);
    expect(out.rows[1].isReference).toBe(true);
    expect(out.rows[1].changes).toEqual([]);
    expect(out.rows[2].changes.map((c) => c.id)).toEqual(['mult', 'extra']);
    expect(out.rows[2].changes[1].from).toBe('—');
    expect(out.varied).toEqual(['len', 'mult', 'extra']);
  });

  it('falls back to the first-ranked row as the reference and honours N', () => {
    const rows = [cand(1, { a: 1 }, 0.2), cand(2, { a: 2 }, null), cand(3, { a: 3 }, 0.1)];
    const out = topCandidatesWithDiff(rows, 2);
    expect(out.rows).toHaveLength(2);
    expect(out.reference!.rank).toBe(1);
    expect(out.rows[1].deltaExpectancyR).toBeNull();
  });

  it('is empty without candidates', () => {
    expect(topCandidatesWithDiff([], 5)).toEqual({ reference: null, rows: [], varied: [] });
  });
});
