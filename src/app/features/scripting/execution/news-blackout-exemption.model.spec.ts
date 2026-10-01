import { describe, expect, it } from 'vitest';

import {
  EXEMPTION_EFFECT,
  exemptionReasonProblem,
  exemptionUpdateRequest,
  isNewsBlackoutExempt,
} from './news-blackout-exemption.model';

describe('isNewsBlackoutExempt', () => {
  it('is true only for a script strategy holding the flag (engine NewsBlackoutExemption.Applies)', () => {
    expect(
      isNewsBlackoutExempt({ authoringMode: 'Script', newsBlackoutExempt: true } as never),
    ).toBe(true);
    // An older DTO without authoringMode still counts as a script when it carries source.
    expect(
      isNewsBlackoutExempt({ scriptSource: 'strategy("x")', newsBlackoutExempt: true } as never),
    ).toBe(true);
    expect(
      isNewsBlackoutExempt({ authoringMode: 'Script', newsBlackoutExempt: false } as never),
    ).toBe(false);
    // An engine before 2026-10-01 sends no flag.
    expect(isNewsBlackoutExempt({ authoringMode: 'Script' } as never)).toBe(false);
    // The engine ignores the flag on anything that is not a script.
    expect(
      isNewsBlackoutExempt({
        strategyType: 'CompositeML',
        authoringMode: null,
        newsBlackoutExempt: true,
      } as never),
    ).toBe(false);
    expect(isNewsBlackoutExempt({ authoringMode: 'Dsl', newsBlackoutExempt: true } as never)).toBe(
      false,
    );
    expect(isNewsBlackoutExempt(null)).toBe(false);
  });
});

describe('exemptionReasonProblem', () => {
  it('needs at least 10 characters, trimmed, to grant', () => {
    expect(exemptionReasonProblem(true, '')).toContain('at least 10 characters (0 now)');
    expect(exemptionReasonProblem(true, '   too short   ')).toContain('(9 now)');
    expect(exemptionReasonProblem(true, 'Fades the NFP spike')).toBeNull();
    expect(exemptionReasonProblem(true, '0123456789')).toBeNull();
  });

  it('makes a revoke reason optional', () => {
    expect(exemptionReasonProblem(false, '')).toBeNull();
    expect(exemptionReasonProblem(false, 'x')).toBeNull();
  });

  it('caps both at 1000 characters (the engine validator)', () => {
    expect(exemptionReasonProblem(true, 'a'.repeat(1000))).toBeNull();
    expect(exemptionReasonProblem(true, 'a'.repeat(1001))).toContain('At most 1000');
    expect(exemptionReasonProblem(false, 'a'.repeat(1001))).toContain('At most 1000');
  });
});

describe('exemptionUpdateRequest', () => {
  it('sends only the exemption fields, so the engine leaves everything else unchanged', () => {
    expect(exemptionUpdateRequest(true, '  Built to fade the first NFP minute  ')).toEqual({
      newsBlackoutExempt: true,
      newsBlackoutExemptReason: 'Built to fade the first NFP minute',
      changeReason: 'News-blackout exemption granted',
    });
  });

  it('sends a revoke with or without a reason', () => {
    expect(exemptionUpdateRequest(false, '')).toEqual({
      newsBlackoutExempt: false,
      newsBlackoutExemptReason: null,
      changeReason: 'News-blackout exemption revoked',
    });
    expect(exemptionUpdateRequest(false, ' No longer event-driven ').newsBlackoutExemptReason).toBe(
      'No longer event-driven',
    );
  });
});

describe('EXEMPTION_EFFECT', () => {
  it('spells out that live, paper and backtest entries are not blocked', () => {
    expect(EXEMPTION_EFFECT).toContain('live, paper and backtest entries are NOT blocked');
    expect(EXEMPTION_EFFECT).toContain('designed around releases');
  });
});
