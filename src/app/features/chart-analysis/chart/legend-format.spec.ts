import { describe, expect, it } from 'vitest';
import { changeText, formatStudyValue, formatVolume } from './legend-format';

describe('legend formatting (CC-18)', () => {
  it('prints the change in price, pips and percent with signs', () => {
    expect(changeText(-0.00002, -0.0018, 0.0001, 5)).toBe('−0.00002 / −0.2 pips (−0.00%)');
    expect(changeText(0.00125, 0.115, 0.0001, 5)).toBe('+0.00125 / +12.5 pips (+0.12%)');
    expect(changeText(0.01, 0.0067, 0.01, 3)).toBe('+0.010 / +1.0 pip (+0.01%)');
    expect(changeText(0, 0, 0.0001, 5)).toBe('0.00000 / 0.0 pips (0.00%)');
  });

  it('leaves the pips out without a pip, and everything out without a previous bar', () => {
    expect(changeText(1.5, 0.03, null, 2)).toBe('+1.50 (+0.03%)');
    expect(changeText(null, null, 0.0001, 5)).toBeNull();
  });

  it('abbreviates volume', () => {
    expect(formatVolume(950)).toBe('950');
    expect(formatVolume(1234)).toBe('1.23K');
    expect(formatVolume(4_500_000)).toBe('4.5M');
    expect(formatVolume(12_000)).toBe('12K');
    expect(formatVolume(null)).toBe('—');
  });

  it('prints a study on the price scale at the symbol’s decimals, others by size', () => {
    expect(formatStudyValue(1.0855123, true, 5)).toBe('1.08551');
    expect(formatStudyValue(54.321, false, 5)).toBe('54.32');
    expect(formatStudyValue(0.000123, false, 5)).toBe('0.0001');
    expect(formatStudyValue(null, false, 5)).toBe('—');
  });
});
