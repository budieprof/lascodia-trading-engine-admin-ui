import { describe, expect, it } from 'vitest';

import type { StrategyDto } from '@core/api/api.types';

import {
  mergeStrategies,
  strategyIdFromQuery,
  validateRuleBacktestForm,
} from './backtest-queue-form.model';

const s = (id: number) => ({ id }) as StrategyDto;

describe('strategyIdFromQuery', () => {
  it('reads "#1215" and "1215"', () => {
    expect(strategyIdFromQuery('#1215')).toBe(1215);
    expect(strategyIdFromQuery(' 1215 ')).toBe(1215);
    expect(strategyIdFromQuery('# 7')).toBe(7);
  });

  it('is null for text, zero and mixed input', () => {
    expect(strategyIdFromQuery('EURUSD')).toBeNull();
    expect(strategyIdFromQuery('0')).toBeNull();
    expect(strategyIdFromQuery('12ab')).toBeNull();
    expect(strategyIdFromQuery('')).toBeNull();
  });
});

describe('mergeStrategies', () => {
  it('keeps first-seen order and drops duplicates', () => {
    expect(mergeStrategies([s(3), s(1)], [s(1), s(2)]).map((r) => r.id)).toEqual([3, 1, 2]);
  });
});

describe('validateRuleBacktestForm', () => {
  const ok = {
    fromDate: '2025-01-01',
    toDate: '2025-12-31',
    symbolOverride: '',
    initialBalance: 10000,
  };

  it('accepts a complete form', () => {
    expect(validateRuleBacktestForm(ok)).toBeNull();
  });

  it('refuses a backwards window, a bad symbol and a non-positive balance', () => {
    expect(validateRuleBacktestForm({ ...ok, toDate: '2024-12-31' })).toMatch(/end date/);
    expect(validateRuleBacktestForm({ ...ok, symbolOverride: 'EUR/USD' })).toMatch(/symbol/);
    expect(validateRuleBacktestForm({ ...ok, initialBalance: 0 })).toMatch(/balance/);
    expect(validateRuleBacktestForm({ ...ok, initialBalance: null })).toMatch(/balance/);
  });
});
