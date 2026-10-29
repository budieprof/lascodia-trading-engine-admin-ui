import { describe, expect, it } from 'vitest';

import { splitContracts } from './cme-calendar.logic';
import type { CmeContractDto } from './cme-microstructure.types';

const c = (code: string, expiry: string, over: Partial<CmeContractDto> = {}): CmeContractDto => ({
  contractCode: code,
  rootSymbol: '6E',
  spotSymbol: 'EURUSD',
  expiryDate: expiry,
  rollDate: null,
  priceAdjustment: 0,
  isFrontMonth: false,
  lastTradeEventTimestamp: null,
  ...over,
});

describe('splitContracts', () => {
  it('keeps data, front month and near expiries; counts the empty tail', () => {
    const now = Date.parse('2026-10-28T00:00:00Z');
    const s = splitContracts(
      [
        c('6EU4', '2024-09-18'),
        c('6EH6', '2026-03-18', { lastTradeEventTimestamp: '2026-03-01T00:00:00Z' }),
        c('6EU6', '2026-09-16'),
        c('6EZ6', '2026-12-16', { isFrontMonth: true }),
        c('6EH7', '2027-03-17'),
        c('6EZ7', '2027-12-15'),
        c('6EM6', '2026-06-17'),
      ],
      new Set(['6EM6']),
      now,
    );
    expect(s.shown.map((x) => x.contractCode)).toEqual(['6EH6', '6EZ6', '6EH7', '6EM6']);
    expect([s.hiddenPast, s.hiddenFuture, s.withData]).toEqual([2, 1, 2]);
  });
});
