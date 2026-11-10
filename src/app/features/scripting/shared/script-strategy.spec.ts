import { describe, expect, it } from 'vitest';

import {
  executionPolicyOf,
  isPortfolioStrategy,
  isScriptStrategy,
  portfolioMembersOf,
  scriptInputsOf,
  scriptSourceOf,
} from './script-strategy';

const base = { id: 1, name: 'S', symbol: 'EURUSD' } as any;

describe('isScriptStrategy', () => {
  it('reads authoringMode, any casing', () => {
    expect(isScriptStrategy({ ...base, authoringMode: 'Script' })).toBe(true);
    expect(isScriptStrategy({ ...base, authoringMode: 'script' })).toBe(true);
    expect(isScriptStrategy({ ...base, authoringMode: 'Dsl', scriptSource: 'x' })).toBe(false);
  });

  it('falls back to the presence of script source on older DTOs', () => {
    expect(isScriptStrategy({ ...base, scriptSource: '//@version=6\nstrategy("x")' })).toBe(true);
    expect(isScriptStrategy({ ...base, scriptSource: '  ' })).toBe(false);
    expect(isScriptStrategy(base)).toBe(false);
    expect(isScriptStrategy(null)).toBe(false);
  });
});

describe('script fields', () => {
  it('returns the source only when there is one', () => {
    expect(scriptSourceOf({ ...base, scriptSource: 'src' })).toBe('src');
    expect(scriptSourceOf(base)).toBeNull();
  });

  it('reads input overrides as an object or the stored JSON text', () => {
    expect(scriptInputsOf({ ...base, scriptInputs: { in_1_len: 14 } })).toEqual({ in_1_len: 14 });
    expect(scriptInputsOf({ ...base, scriptInputs: '{"in_1_len":20}' })).toEqual({ in_1_len: 20 });
    expect(scriptInputsOf({ ...base, scriptInputs: 'not json' })).toEqual({});
    expect(scriptInputsOf({ ...base, scriptInputs: '[1]' })).toEqual({});
    expect(scriptInputsOf(base)).toEqual({});
  });

  it('reads the execution policy as a name or the enum number', () => {
    expect(executionPolicyOf({ ...base, executionPolicy: 'Direct' })).toBe('Direct');
    expect(executionPolicyOf({ ...base, executionPolicy: 'standard' })).toBe('Standard');
    expect(executionPolicyOf({ ...base, executionPolicy: 0 })).toBe('Standard');
    expect(executionPolicyOf({ ...base, executionPolicy: 1 })).toBe('Direct');
    expect(executionPolicyOf({ ...base, executionPolicy: 'Other' })).toBeNull();
    expect(executionPolicyOf(base)).toBeNull();
  });
});

describe('portfolioMembersOf (b11-portfolio-hardening)', () => {
  const src = (header: string) => ({ ...base, scriptSource: `//@version=6\n${header}\nstrategy("P")\n` });

  it('reads the directive\'s symbols in order, with or without symbols=', () => {
    expect(portfolioMembersOf(src('//@lascodia-portfolio EURUSD, us500'))).toEqual(['EURUSD', 'US500']);
    expect(portfolioMembersOf(src('//@lascodia-portfolio symbols=EURUSD,GBPUSD, USDJPY'))).toEqual(['EURUSD', 'GBPUSD', 'USDJPY']);
    expect(isPortfolioStrategy(src('//@lascodia-portfolio EURUSD, US500'))).toBe(true);
  });

  it('is not a portfolio with one symbol, no directive or no script', () => {
    expect(isPortfolioStrategy(src('//@lascodia-portfolio EURUSD'))).toBe(false);
    expect(portfolioMembersOf(src('// a comment'))).toEqual([]);
    expect(portfolioMembersOf(base)).toEqual([]);
    expect(portfolioMembersOf(null)).toEqual([]);
  });
});
