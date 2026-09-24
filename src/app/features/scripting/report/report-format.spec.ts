import { describe, expect, it } from 'vitest';

import {
  MINUS,
  NA,
  formatBars,
  formatDate,
  formatDateTime,
  formatInteger,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPrice,
  formatQty,
  inferPriceDecimals,
  polarity,
} from './report-format';

describe('report formatting', () => {
  it('prints money with a currency suffix and an explicit sign when asked', () => {
    expect(formatMoney(1234.5, 'USD')).toBe('1,234.50 USD');
    expect(formatMoney(1234.5, 'USD', { signed: true })).toBe('+1,234.50 USD');
    expect(formatMoney(-0.4, '')).toBe(`${MINUS}0.40`);
    expect(formatMoney(null, 'USD')).toBe(NA);
  });

  it('never prints a signed zero', () => {
    expect(formatMoney(-0.001, 'USD', { signed: true })).toBe('0.00 USD');
    expect(formatPercent(-0.0001, { signed: true })).toBe('0.00%');
    expect(formatNumber(0.0001, 2, true)).toBe('0.00');
  });

  it('prints percentages that are already percentages', () => {
    expect(formatPercent(6.062)).toBe('6.06%');
    expect(formatPercent(-0.5984, { signed: true })).toBe(`${MINUS}0.60%`);
    expect(formatPercent(undefined)).toBe(NA);
  });

  it('formats counts, bars and quantities', () => {
    expect(formatInteger(6241)).toBe('6,241');
    expect(formatBars(61.5)).toBe('61.5');
    expect(formatBars(40)).toBe('40');
    expect(formatQty(10000)).toBe('10,000');
    expect(formatQty(0.12346)).toBe('0.1235');
    expect(formatQty(-2)).toBe(`${MINUS}2`);
  });

  it('infers the quote precision from the prices', () => {
    expect(inferPriceDecimals([1.0312, 1.03654, null])).toBe(5);
    expect(inferPriceDecimals([151.234, 150.5])).toBe(3);
    expect(inferPriceDecimals([5012.5])).toBe(2);
    expect(inferPriceDecimals([0.1 + 0.2])).toBe(2);
    expect(formatPrice(1.0312, 5)).toBe('1.03120');
  });

  it('formats Unix ms as UTC', () => {
    const t = Date.UTC(2025, 0, 6, 10, 5);
    expect(formatDateTime(t)).toBe('2025-01-06 10:05');
    expect(formatDate(t)).toBe('2025-01-06');
    expect(formatDateTime(null)).toBe(NA);
  });

  it('classifies polarity', () => {
    expect(polarity(1)).toBe('pos');
    expect(polarity(-1)).toBe('neg');
    expect(polarity(0)).toBe('zero');
    expect(polarity(null)).toBe('na');
  });
});
