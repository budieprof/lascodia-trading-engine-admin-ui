import { describe, expect, it } from 'vitest';
import { ocoHue, ocoLegEnded, ocoShortCode } from './oco';

describe('oco helpers', () => {
  it('shortens a group id to four upper-case characters after the prefix', () => {
    expect(ocoShortCode('oco-ad37ee6142ca')).toBe('AD37');
    expect(ocoShortCode('xy')).toBe('XY');
    expect(ocoShortCode(null)).toBe('');
  });

  it('gives one group the same hue every time and spreads different groups', () => {
    expect(ocoHue('oco-ad37ee6142ca')).toBe(ocoHue('oco-ad37ee6142ca'));
    const hues = new Set(
      [
        'oco-ad37ee6142ca',
        'oco-f472451a1634',
        'oco-016940dced20',
        'oco-1b04632cb9e1',
        'oco-baaf4ebfd918',
      ].map(ocoHue),
    );
    expect(hues.size).toBeGreaterThan(2);
  });

  it('never picks a hue near buy-green or sell-red', () => {
    for (let i = 0; i < 200; i++) {
      const h = ocoHue(`oco-${i.toString(16)}`);
      expect(h > 15 && h < 345).toBe(true);
      expect(Math.abs(h - 120) > 40).toBe(true);
    }
  });

  it('treats cancelled, expired and invalidated legs as ended', () => {
    expect(ocoLegEnded('Cancelled')).toBe(true);
    expect(ocoLegEnded('Active')).toBe(false);
    expect(ocoLegEnded(null)).toBe(false);
  });
});
