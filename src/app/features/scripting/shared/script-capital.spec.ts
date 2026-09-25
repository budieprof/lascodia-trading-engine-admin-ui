import { describe, expect, it } from 'vitest';

import {
  ENGINE_DEFAULT_CAPITAL_TEXT,
  declaredCurrency,
  describeScriptCapital,
  formatCapital,
  parseConfiguredCapital,
  scriptCapitalOf,
} from './script-capital';

describe('scriptCapitalOf', () => {
  it('takes a declared capital from the compiler’s flag, whatever its value', () => {
    expect(scriptCapitalOf({ initialCapital: 25_000, initialCapitalSpecified: true })).toEqual({
      source: 'declared',
      amount: 25_000,
      currency: null,
    });
    // strategy(initial_capital = 1000000) is declared although it equals Pine's default.
    expect(
      scriptCapitalOf({ initialCapital: 1_000_000, initialCapitalSpecified: true }).source,
    ).toBe('declared');
  });

  it('leaves an undeclared capital to the engine default, whatever value compiled', () => {
    // Pine's 1,000,000 compiles in when nothing is declared; it is never what a run opens with.
    expect(scriptCapitalOf({ initialCapital: 1_000_000, initialCapitalSpecified: false })).toEqual({
      source: 'engineDefault',
      amount: null,
      currency: null,
    });
    expect(scriptCapitalOf({ initialCapital: 5_000, initialCapitalSpecified: false }).source).toBe(
      'engineDefault',
    );
  });

  it('does not guess when the compile does not say', () => {
    expect(scriptCapitalOf({ initialCapital: 25_000 }).source).toBe('unknown');
    expect(scriptCapitalOf({ initialCapital: 25_000, initialCapitalSpecified: null }).source).toBe(
      'unknown',
    );
    expect(scriptCapitalOf(null).source).toBe('unknown');
  });

  it('carries the script’s declared currency', () => {
    expect(
      scriptCapitalOf({ initialCapital: 1_500_000, initialCapitalSpecified: true, currency: 'jpy' })
        .currency,
    ).toBe('JPY');
    expect(
      scriptCapitalOf({ initialCapitalSpecified: false, currency: 'NONE' }).currency,
    ).toBeNull();
    expect(declaredCurrency(' ')).toBeNull();
  });
});

describe('parseConfiguredCapital', () => {
  it('accepts a positive number only', () => {
    expect(parseConfiguredCapital('10000')).toBe(10_000);
    expect(parseConfiguredCapital('2500.5')).toBe(2_500.5);
    expect(parseConfiguredCapital('0')).toBeNull();
    expect(parseConfiguredCapital('-5')).toBeNull();
    expect(parseConfiguredCapital('ten thousand')).toBeNull();
    expect(parseConfiguredCapital('')).toBeNull();
    expect(parseConfiguredCapital(null)).toBeNull();
  });
});

describe('describeScriptCapital', () => {
  it('prints the amount and its source', () => {
    expect(
      describeScriptCapital({ source: 'declared', amount: 25_000, currency: null }, null),
    ).toBe('25,000 · declared by the script');
    expect(
      describeScriptCapital({ source: 'engineDefault', amount: null, currency: null }, 10_000),
    ).toBe('10,000 · engine default (ScriptBacktest:InitialCapital)');
  });

  it('puts the engine default in the script’s declared currency', () => {
    expect(
      describeScriptCapital({ source: 'engineDefault', amount: null, currency: 'JPY' }, 10_000),
    ).toBe('10,000 JPY · engine default (ScriptBacktest:InitialCapital)');
  });

  it('names the engine default when its value is not known', () => {
    expect(
      describeScriptCapital({ source: 'engineDefault', amount: null, currency: null }, null),
    ).toBe(ENGINE_DEFAULT_CAPITAL_TEXT);
    expect(ENGINE_DEFAULT_CAPITAL_TEXT).toBe('engine default (ScriptBacktest:InitialCapital)');
  });

  it('states the rule when the source is unknown', () => {
    expect(describeScriptCapital(null, 10_000)).toBe(
      "the script's initial_capital when it declares one, else the engine default (ScriptBacktest:InitialCapital)",
    );
  });

  it('formats capital with grouping and at most two decimals', () => {
    expect(formatCapital(1_234_567.891)).toBe('1,234,567.89');
    expect(formatCapital(10_000, 'EUR')).toBe('10,000 EUR');
  });
});
