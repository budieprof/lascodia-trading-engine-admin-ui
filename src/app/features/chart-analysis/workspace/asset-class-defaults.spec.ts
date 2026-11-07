import { describe, expect, it } from 'vitest';
import { defaultOnSwitch, parseAssetClassDefaults } from './asset-class-defaults';

describe('US07 per-asset-class defaults', () => {
  it('keeps only valid classes, timeframes and template ids', () => {
    expect(
      parseAssetClassDefaults(
        JSON.stringify({ Crypto: { resolution: '240', templateId: 't1' }, Fx: { resolution: '7s' }, Bogus: { resolution: '60' } }),
      ),
    ).toEqual({ Crypto: { resolution: '240', templateId: 't1' } });
    expect(parseAssetClassDefaults('not json')).toEqual({});
    expect(parseAssetClassDefaults(null)).toEqual({});
  });

  it('applies on a switch into another class with nothing remembered — never between two of one class', () => {
    const d = { Crypto: { resolution: '240' as const } };
    expect(defaultOnSwitch(d, 'Fx', 'Crypto', false)).toEqual({ resolution: '240' });
    expect(defaultOnSwitch(d, 'Crypto', 'Crypto', false)).toBeNull();
    expect(defaultOnSwitch(d, 'Fx', 'Crypto', true)).toBeNull();
    expect(defaultOnSwitch(d, 'Crypto', 'Fx', false)).toBeNull();
    expect(defaultOnSwitch(d, 'Fx', null, false)).toBeNull();
  });
});
