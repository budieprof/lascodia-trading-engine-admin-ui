import { describe, expect, it } from 'vitest';

import type { ScriptDeclaration, ScriptStrategyProperties } from '@core/api/scripting.types';

import { capitalRow, declarationRows, marginRow } from './declaration-summary.model';

function strategy(p: ScriptStrategyProperties): ScriptDeclaration {
  return { kind: 'strategy', title: 'Breakout', overlay: true, strategy: p };
}

const row = (d: ScriptDeclaration, label: string) =>
  declarationRows(d).find((r) => r.label === label);

describe('capitalRow', () => {
  it('a declared capital is marked declared, even at Pine’s default value', () => {
    expect(capitalRow({ initialCapital: 25_000, initialCapitalSpecified: true })).toMatchObject({
      value: '25,000 · declared',
      set: true,
    });
    // strategy(initial_capital = 1000000): the flag says declared; the value is never consulted.
    expect(capitalRow({ initialCapital: 1_000_000, initialCapitalSpecified: true })).toMatchObject({
      value: '1,000,000 · declared',
      set: true,
    });
  });

  it('an undeclared capital is the engine default, whatever value compiled', () => {
    const r = capitalRow({ initialCapital: 1_000_000, initialCapitalSpecified: false });
    expect(r.value).toBe('Engine default');
    expect(r.set).toBeFalsy();
    expect(r.hint).toContain('ScriptBacktest:InitialCapital');
    // A value off Pine's default proves nothing either: the flag decides.
    expect(capitalRow({ initialCapital: 5_000, initialCapitalSpecified: false }).value).toBe(
      'Engine default',
    );
  });

  it('names the declared currency the capital is in', () => {
    expect(
      capitalRow({ initialCapital: 1_500_000, initialCapitalSpecified: true, currency: 'JPY' })
        .value,
    ).toBe('1,500,000 JPY · declared');
    expect(capitalRow({ initialCapitalSpecified: false, currency: 'JPY' }).value).toBe(
      'Engine default (JPY)',
    );
    // currency.NONE runs in the engine's account currency, not the symbol's (D114): not named.
    expect(
      capitalRow({ initialCapital: 25_000, initialCapitalSpecified: true, currency: 'NONE' }).value,
    ).toBe('25,000 · declared');
  });

  it('without the flag, shows the compiled value and claims nothing', () => {
    const r = capitalRow({ initialCapital: 25_000 });
    expect(r).toEqual({ label: 'Initial capital', value: '25,000' });
    expect(capitalRow({ initialCapital: 1_000_000, initialCapitalSpecified: null }).set).toBe(
      undefined,
    );
  });
});

describe('marginRow', () => {
  it('follows the compiler’s marginSpecified flag, not the values', () => {
    expect(marginRow({ marginLong: 50, marginShort: 50, marginSpecified: true })).toMatchObject({
      value: '50% / 50% · declared',
      set: true,
    });
    // margin_long = 100 passed explicitly is still declared.
    expect(marginRow({ marginLong: 100, marginShort: 100, marginSpecified: true }).set).toBe(true);
    const def = marginRow({ marginLong: 100, marginShort: 100, marginSpecified: false });
    expect(def.value).toBe('100% / 100% · default');
    expect(def.set).toBeFalsy();
    expect(def.hint).toContain('margin_liquidation_price');
  });

  it('without the flag, shows the margins and claims nothing', () => {
    expect(marginRow({ marginLong: 50, marginShort: 25 })).toEqual({
      label: 'Margin long / short',
      value: '50% / 25%',
    });
  });
});

describe('declarationRows', () => {
  it('lists the strategy properties with the capital and margin rows', () => {
    const d = strategy({
      initialCapital: 25_000,
      initialCapitalSpecified: true,
      marginLong: 100,
      marginShort: 100,
      marginSpecified: false,
      pyramiding: 3,
    });
    expect(declarationRows(d).map((r) => r.label)).toEqual([
      'Overlay',
      'Initial capital',
      'Order size',
      'Pyramiding',
      'Commission',
      'Slippage',
      'Margin long / short',
      'Orders on close',
      'Every tick',
      'On order fills',
      'Close entries rule',
      'Bar magnifier',
      'Fill on standard OHLC',
      'Limit fill assumption',
      'Risk-free rate',
    ]);
    expect(row(d, 'Initial capital')!.value).toBe('25,000 · declared');
    expect(row(d, 'Margin long / short')!.value).toBe('100% / 100% · default');
    expect(row(d, 'Pyramiding')!.set).toBe(true);
  });

  it('sizes a fixed order in Pine units of the underlying', () => {
    expect(
      row(strategy({ defaultQtyType: 'Fixed', defaultQtyValue: 100_000 }), 'Order size')!.value,
    ).toBe('100,000 units');
    expect(row(strategy({}), 'Order size')!.value).toBe('1 unit');
    expect(
      row(strategy({ defaultQtyType: 'PercentOfEquity', defaultQtyValue: 10 }), 'Order size')!
        .value,
    ).toBe('10% of equity');
  });

  it('has no strategy rows for an indicator, and none without a declaration', () => {
    expect(
      declarationRows({ kind: 'indicator', title: 'RSI', overlay: false }).map((r) => r.label),
    ).toEqual(['Overlay']);
    expect(declarationRows(null)).toEqual([]);
  });
});
