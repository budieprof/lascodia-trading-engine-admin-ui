import { describe, expect, it } from 'vitest';

import type { ReportStrategyProperties } from '@features/scripting/report/strategy-report.model';
import {
  draftFromReport,
  draftProblems,
  overriddenLabel,
  overridesFrom,
} from './strategy-properties';

const props: ReportStrategyProperties = {
  pyramiding: 0,
  calcOnOrderFills: false,
  calcOnEveryTick: false,
  calcOnEveryHistoryTick: false,
  maxBarsBack: 0,
  backtestFillLimitsAssumption: 0,
  defaultQtyType: 'PercentOfEquity',
  defaultQtyValue: 100,
  initialCapital: 10_000,
  currency: 'NONE',
  slippage: 0,
  commissionType: 'CashPerOrder',
  commissionValue: 0,
  processOrdersOnClose: false,
  closeEntriesRule: 'FIFO',
  marginLong: 100,
  marginShort: 100,
  riskFreeRate: 2,
  useBarMagnifier: false,
  fillOrdersOnStandardOhlc: false,
};

describe('strategy properties form (PC-I5)', () => {
  it('starts from what the run used, in the engine’s spellings', () => {
    const d = draftFromReport(props);
    expect(d.defaultQtyType).toBe('percent_of_equity');
    expect(d.commissionType).toBe('cash_per_order');
    expect(d.currency).toBe('NONE');
    expect(d.initialCapital).toBe(10_000);
    expect(d.closeEntriesRule).toBe('FIFO');
  });

  it('sends the overrides already applied plus every changed field', () => {
    const start = draftFromReport(props);
    const edited = { ...start, initialCapital: 25_000, pyramiding: 2, currency: 'eur' };
    expect(overridesFrom({ slippage: 3 }, start, edited)).toEqual({
      slippage: 3,
      initialCapital: 25_000,
      pyramiding: 2,
      currency: 'EUR',
    });
    expect(overridesFrom({}, start, start)).toEqual({});
    // An empty number field is "not set": it never sends a null.
    expect(overridesFrom({}, start, { ...start, slippage: null })).toEqual({});
  });

  it('checks the engine’s limits before sending', () => {
    const start = draftFromReport(props);
    expect(draftProblems(start)).toEqual([]);
    expect(draftProblems({ ...start, initialCapital: 0 })).toEqual([
      'Initial capital must be above 0 and at most 1000000000000.',
    ]);
    expect(draftProblems({ ...start, pyramiding: 1.5 })).toContain(
      'Pyramiding must be a whole number.',
    );
    expect(draftProblems({ ...start, commissionType: 'percent', commissionValue: 120 })).toContain(
      'Commission must be at least 0 and at most 100.',
    );
    expect(draftProblems({ ...start, currency: 'EURO' })).toContain(
      'Base currency must be a three-letter code such as USD, or NONE.',
    );
    expect(draftProblems({ ...start, marginShort: 150 })).toContain(
      'Margin for short positions must be at least 0 and at most 100.',
    );
  });

  it('names the overridden properties in plain words', () => {
    expect(overriddenLabel({ initialCapital: 5, calcOnEveryTick: true })).toBe(
      'initial capital, recalculate on every tick',
    );
    expect(overriddenLabel(null)).toBe('');
  });
});
