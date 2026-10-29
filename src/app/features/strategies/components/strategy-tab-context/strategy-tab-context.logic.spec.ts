import { describe, expect, it } from 'vitest';
import { isSentinelName, perDay, tabApplicability } from './strategy-tab-context.logic';

describe('strategy tab applicability', () => {
  it('marks the evidence tabs of a sentinel as not applying, with a reason', () => {
    for (const tab of [
      'promotion',
      'optimization',
      'backtests',
      'walkforward',
      'variants',
    ] as const) {
      const a = tabApplicability(tab, true);
      expect(a.applies).toBe(false);
      expect(a.why).toBeTruthy();
    }
    expect(tabApplicability('backtests', true).title).toBe(
      'Backtests does not apply to a sentinel strategy',
    );
  });

  it('keeps live-trading tabs and every tab of a normal strategy', () => {
    expect(tabApplicability('capacity', true).applies).toBe(true);
    expect(tabApplicability('reviews', true).applies).toBe(true);
    expect(tabApplicability('promotion', false).applies).toBe(true);
  });

  it('recognises sentinel names and averages signals per day', () => {
    expect(isSentinelName('LLM Spot Analysis')).toBe(true);
    expect(isSentinelName('MeanRev v5')).toBe(false);
    expect(perDay([{ signals: 2 }, { signals: 0 }, { signals: 1 }, { signals: 1 }])).toBe(1);
    expect(perDay([])).toBe(0);
  });
});
