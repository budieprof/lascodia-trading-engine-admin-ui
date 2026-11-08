import { describe, expect, it } from 'vitest';

import { inputCells } from './input-cells';

describe('inputCells (heartbeat inputs → status cells)', () => {
  it('shows a per-symbol daily-loss limit of 0 as Off, a positive one as a share of equity', () => {
    expect(inputCells({ maxDailyLossPerSymbolPct: 0 })[0]).toMatchObject({
      key: 'dailyLossPerSymbol',
      value: 'Off',
      tone: 'warn',
    });
    expect(inputCells({ maxDailyLossPerSymbolPct: 2 })[0]).toMatchObject({
      value: '2% equity',
      tone: 'ok',
    });
  });

  it('shows the effective gap-fill state and where it comes from', () => {
    const on = inputCells({ mdGapFill: true, mdGapFillActive: true, mdGapFillOverride: true });
    expect(on.find((c) => c.key === 'gapFill')?.value).toBe('Running · engine override');
    const off = inputCells({ mdGapFill: false, mdGapFillActive: false, mdGapFillOverride: false });
    expect(off.find((c) => c.key === 'gapFill')?.value).toBe('Off · chart input');
  });

  it('omits what an older EA build does not report', () => {
    expect(inputCells({})).toEqual([]);
    expect(inputCells(null)).toEqual([]);
    expect(inputCells({ mdGapFill: true })).toEqual([]);
  });
});
