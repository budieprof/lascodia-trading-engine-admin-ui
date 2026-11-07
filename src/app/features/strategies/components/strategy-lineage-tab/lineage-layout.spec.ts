import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';

import type { StrategyLineageDto } from '@core/api/api.types';
import { layoutLineage, lineageCounts } from './lineage-layout';

// U13: the lineage layout moved out of the strategy detail page with this spec (assertions unchanged). The tiny
// harness keeps the old `lineage.set(...)` / `lineageLayout()` shape the cases were written against.

describe('layoutLineage (strategy lineage tab)', () => {
  const lineage = signal<StrategyLineageDto | null>(null);
  const cmp = {
    lineage,
    lineageLayout: () => layoutLineage(lineage()),
    ancestorCount: () => lineageCounts(lineage()).ancestors,
    descendantCount: () => lineageCounts(lineage()).descendants,
  };
  beforeEach(() => lineage.set(null));

  it('returns null when lineage is unset', () => {
    expect(cmp.lineageLayout()).toBeNull();
  });

  it('lays out a single-node lineage at depth 0', () => {
    cmp.lineage.set({
      focusStrategyId: 1,
      nodes: [
        {
          id: 1,
          name: 'Focus',
          symbol: 'EURUSD',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 1,
          generationSource: null,
          createdAt: '2025-01-01T00:00:00Z',
          depthOffset: 0,
          parentInTree: null,
        },
      ],
    });
    const layout = cmp.lineageLayout()!;
    expect(layout.nodes.length).toBe(1);
    expect(layout.nodes[0].depthOffset).toBe(0);
    expect(layout.edges.length).toBe(0);
  });

  it('builds an edge from each child to its parentInTree', () => {
    cmp.lineage.set({
      focusStrategyId: 1,
      nodes: [
        {
          id: 1,
          name: 'P',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 1,
          generationSource: null,
          createdAt: '2025-01-01T00:00:00Z',
          depthOffset: 0,
          parentInTree: null,
        },
        {
          id: 2,
          name: 'C1',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 2,
          generationSource: null,
          createdAt: '2025-01-02T00:00:00Z',
          depthOffset: 1,
          parentInTree: 1,
        },
        {
          id: 3,
          name: 'C2',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 2,
          generationSource: null,
          createdAt: '2025-01-03T00:00:00Z',
          depthOffset: 1,
          parentInTree: 1,
        },
      ],
    });
    const layout = cmp.lineageLayout()!;
    expect(layout.nodes.length).toBe(3);
    expect(layout.edges.length).toBe(2);
  });

  it('compresses NODE_W when many siblings share a row', () => {
    // 14 siblings on a 1200-px viewport, with default 180px boxes the row
    // would overflow; the layout should compress to fit.
    const nodes = [
      {
        id: 1,
        name: 'P',
        symbol: 'EUR',
        timeframe: 'H1' as any,
        strategyType: 'RuleBased' as any,
        status: 'Active' as any,
        generation: 1,
        generationSource: null,
        createdAt: '2025-01-01T00:00:00Z',
        depthOffset: 0,
        parentInTree: null as number | null,
      },
    ];
    for (let i = 2; i <= 15; i++) {
      nodes.push({
        id: i,
        name: `C${i}`,
        symbol: 'EUR',
        timeframe: 'H1' as any,
        strategyType: 'RuleBased' as any,
        status: 'Active' as any,
        generation: 2,
        generationSource: null,
        createdAt: `2025-01-${String(i).padStart(2, '0')}T00:00:00Z`,
        depthOffset: 1,
        parentInTree: 1,
      });
    }
    cmp.lineage.set({ focusStrategyId: 1, nodes });

    const layout = cmp.lineageLayout()!;
    // First sibling on the lower row should be < 180px wide (NODE_W_MAX).
    const sibling = layout.nodes.find((n) => n.depthOffset === 1)!;
    expect(sibling.width).toBeLessThan(180);
    // ...but not lower than the floor of 96px.
    expect(sibling.width).toBeGreaterThanOrEqual(96);
  });

  it('exposes ancestor and descendant counts via computed signals', () => {
    cmp.lineage.set({
      focusStrategyId: 5,
      nodes: [
        {
          id: 5,
          name: 'F',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 3,
          generationSource: null,
          createdAt: '2025-01-01T00:00:00Z',
          depthOffset: 0,
          parentInTree: null,
        },
        {
          id: 4,
          name: 'A1',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 2,
          generationSource: null,
          createdAt: '2024-12-01T00:00:00Z',
          depthOffset: -1,
          parentInTree: 5,
        },
        {
          id: 6,
          name: 'D1',
          symbol: 'EUR',
          timeframe: 'H1' as any,
          strategyType: 'RuleBased' as any,
          status: 'Active' as any,
          generation: 4,
          generationSource: null,
          createdAt: '2025-02-01T00:00:00Z',
          depthOffset: 1,
          parentInTree: 5,
        },
      ],
    });
    expect(cmp.ancestorCount()).toBe(1);
    expect(cmp.descendantCount()).toBe(1);
  });
});
