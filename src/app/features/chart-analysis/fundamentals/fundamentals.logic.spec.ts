import { describe, expect, it } from 'vitest';

import { fundingTone, sessionText, slopeWord } from './fundamentals.logic';

describe('fundamentals panel logic', () => {
  it('slope words', () => {
    expect(slopeWord(null)).toBe('—');
    expect(slopeWord(0.01)).toBe('flat');
    expect(slopeWord(4.2)).toBe('contango');
    expect(slopeWord(-1)).toBe('backwardation');
  });

  it('funding tone', () => {
    expect(fundingTone(0.0001)).toBe('pos');
    expect(fundingTone(-0.0001)).toBe('neg');
    expect(fundingTone(null)).toBe('');
  });

  it('session text', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(sessionText(null, now)).toBe('Session state unknown.');
    expect(sessionText({ open: true, sessionKind: 'Regular', nextOpen: null, nextClose: '2026-10-27T14:05:00Z', tradingDay: null }, now)).toBe(
      'Open (Regular) · closes in 2 h 5 min.',
    );
    expect(sessionText({ open: false, sessionKind: null, nextOpen: '2026-10-27T12:30:00Z', nextClose: null, tradingDay: null }, now)).toBe(
      'Closed · opens in 30 min.',
    );
  });
});
