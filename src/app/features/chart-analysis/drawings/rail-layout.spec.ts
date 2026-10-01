import { describe, expect, it } from 'vitest';
import { RAIL_LAYOUT, RAIL_STANDALONE, TOOLS } from './model';

describe('rail layout', () => {
  it('places every tool exactly once', () => {
    const placed = [...RAIL_LAYOUT.flatMap((g) => g.sections.flatMap((s) => s.kinds)), ...RAIL_STANDALONE];
    const kinds = TOOLS.map((t) => t.kind);
    expect([...placed].sort()).toEqual([...kinds].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('matches TradingView family order', () => {
    expect(RAIL_LAYOUT.map((g) => g.id)).toEqual(['trend', 'fib', 'patterns', 'forecast', 'shapes', 'text']);
  });
});
