import { describe, expect, it } from 'vitest';

import { formatSurprise, parseEconValue, parseSurprise } from './economic-events-format';

describe('economic-events-format', () => {
  it('parses release strings with units and comparison prefixes', () => {
    expect(parseEconValue('275K')).toBe(275_000);
    expect(parseEconValue('1.9%')).toBe(1.9);
    expect(parseEconValue('<0.75%')).toBe(0.75);
    expect(parseEconValue('-42')).toBe(-42);
    expect(parseEconValue('1,200')).toBe(1200);
    expect(parseEconValue('2.5B')).toBe(2_500_000_000);
    expect(parseEconValue('')).toBeNull();
    expect(parseEconValue(null)).toBeNull();
    expect(parseEconValue('n/a')).toBeNull();
  });

  it('computes actual minus forecast only when both parse', () => {
    expect(parseSurprise('275K', '260K')).toBe(15_000);
    expect(parseSurprise('54.5', null)).toBeNull();
    expect(parseSurprise('abc', '1')).toBeNull();
  });

  it('formats a surprise signed and in the release scale', () => {
    expect(formatSurprise(15_000)).toBe('+15K');
    expect(formatSurprise(-1_250_000)).toBe('−1.3M');
    expect(formatSurprise(0.2)).toBe('+0.2');
    expect(formatSurprise(-0.05)).toBe('−0.05');
    expect(formatSurprise(0)).toBe('0');
    expect(formatSurprise(0.001)).toBe('0');
    expect(formatSurprise(Number.NaN)).toBe('—');
  });
});
