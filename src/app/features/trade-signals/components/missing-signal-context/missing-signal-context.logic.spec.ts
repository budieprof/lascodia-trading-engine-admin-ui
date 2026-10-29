import { describe, expect, it } from 'vitest';
import type { TradeSignalDto } from '@core/api/api.types';
import {
  daySummary,
  nearestPlan,
  sourceText,
  utcMidnightIso,
} from './missing-signal-context.logic';

const sig = (over: Partial<TradeSignalDto>) =>
  ({
    id: 1,
    symbol: 'EURUSD',
    status: 'Expired',
    source: 'Strategy',
    isManual: false,
    orderId: null,
    accountsPickedUpCount: 0,
    ...over,
  }) as TradeSignalDto;

describe('missing-signal-context.logic', () => {
  it('summarises the day', () => {
    const s = daySummary([
      sig({ id: 1, status: 'Expired' }),
      sig({ id: 2, status: 'Expired', symbol: 'DE40' }),
      sig({
        id: 3,
        status: 'Executed',
        source: 'SpotAnalysis',
        orderId: 9,
        accountsPickedUpCount: 5,
      }),
    ]);
    expect(s.total).toBe(3);
    expect(s.byStatus[0]).toEqual({ status: 'Expired', count: 2 });
    expect(s.bySource).toContainEqual({ source: 'LLM analysis', count: 1 });
    expect(s).toMatchObject({ symbols: 2, withOrder: 1, pickedUp: 1 });
  });

  it('utc midnight', () => {
    expect(utcMidnightIso(Date.parse('2026-10-29T13:45:00Z'))).toBe('2026-10-29T00:00:00.000Z');
  });

  it('nearest plan by position in the range', () => {
    expect(nearestPlan(42, 1381, 9374)).toBe('oldest');
    expect(nearestPlan(9999, 1381, 9374)).toBe('newest');
    expect(nearestPlan(5000, 1381, 9374)).toBe('around');
    expect(nearestPlan(5, null, null)).toBe('none');
  });

  it('source text is plain language', () => {
    expect(sourceText({ source: 'PatientTrader' as never, isManual: false })).toBe(
      'Patient Trader',
    );
    expect(sourceText({ source: 'SpotAnalysis', isManual: false })).toBe('LLM analysis');
  });
});
