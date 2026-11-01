import { describe, it, expect } from 'vitest';

import { runVerdict, signedUsd } from '@features/cme-microstructure/cme-verdict.logic';

const base = {
  ran: true,
  reason: 'ok',
  aggregateAndPerTradeDisagree: false,
  oosNetPnlDelta: 100,
  oosPnlPerTradeDelta: 1,
  realNetPnl: 50,
  proxyNetPnl: -50,
};

describe('runVerdict', () => {
  it('reads a clean win as Real ahead', () => {
    expect(runVerdict(base)).toMatchObject({ state: 'real', label: 'Real ahead' });
  });

  it('never calls a both-arms-lose run Real ahead', () => {
    const v = runVerdict({ ...base, realNetPnl: -2381.25, proxyNetPnl: -5831.25 });
    expect(v).toMatchObject({ state: 'ambiguous', label: 'Real lost less' });
  });

  it('flags disagreeing comparisons as Inconclusive', () => {
    expect(runVerdict({ ...base, aggregateAndPerTradeDisagree: true }).label).toBe('Inconclusive');
  });

  it('reads a non-positive delta as Proxy ahead', () => {
    expect(runVerdict({ ...base, oosNetPnlDelta: -5 }).state).toBe('proxy');
  });

  it('shows the reason for an unscored run', () => {
    expect(runVerdict({ ...base, ran: false, reason: 'no_data' })).toMatchObject({
      state: 'skipped',
      label: 'no_data',
    });
  });
});

describe('signedUsd', () => {
  it('signs gains and losses with a true minus', () => {
    expect(signedUsd(3450)).toBe('+3,450.00');
    expect(signedUsd(-0.31)).toBe('−0.31');
  });

  it('leaves zero (and rounding-to-zero) unsigned and missing values as a dash', () => {
    expect(signedUsd(0)).toBe('0.00');
    expect(signedUsd(-0.001)).toBe('0.00');
    expect(signedUsd(null)).toBe('—');
    expect(signedUsd(Number.NaN)).toBe('—');
  });
});
