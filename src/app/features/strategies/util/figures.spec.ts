import { describe, expect, it } from 'vitest';
import { ago, count, day, fractionPct, money } from './figures';

describe('figures', () => {
  it('formats money with sign and currency', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(-2)).toBe('−$2.00');
    expect(money(3, 'USD', true)).toBe('+$3.00');
    expect(money(3, 'EUR')).toBe('3.00 EUR');
    expect(money(null)).toBe('—');
  });

  it('formats fractions as percents', () => {
    expect(fractionPct(0.0123)).toBe('+1.23%');
    expect(fractionPct(-0.007, 1)).toBe('−0.7%');
    expect(fractionPct(0)).toBe('0.00%');
    expect(fractionPct(undefined)).toBe('—');
  });

  it('formats counts, relative times and days', () => {
    expect(count(12345)).toBe('12,345');
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(ago('2026-10-28T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-10-28T10:00:00Z', now)).toBe('2 hours ago');
    expect(ago('2026-10-25T12:00:00Z', now)).toBe('3 days ago');
    expect(ago('2026-10-28T13:00:00Z', now)).toBe('in 1 hour');
    expect(ago(null)).toBe('—');
    expect(day('2026-10-28T00:00:00Z')).toBe('28 Oct 2026');
  });
});
