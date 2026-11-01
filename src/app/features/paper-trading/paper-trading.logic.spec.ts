import { describe, expect, it } from 'vitest';

import { enumLabel, statusTone } from './paper-trading.logic';

describe('enumLabel', () => {
  it('splits engine enum tokens into words', () => {
    expect(enumLabel('PaperTrading')).toBe('Paper trading');
    expect(enumLabel('ShadowLive')).toBe('Shadow live');
    expect(enumLabel('Approved')).toBe('Approved');
    expect(enumLabel('StopLoss')).toBe('Stop loss');
  });

  it('keeps acronyms and handles missing values', () => {
    expect(enumLabel('TP')).toBe('TP');
    expect(enumLabel('MLExit')).toBe('ML exit');
    expect(enumLabel(null)).toBe('—');
    expect(enumLabel('')).toBe('—');
  });
});

describe('statusTone', () => {
  it('maps run status to a pill tone', () => {
    expect(statusTone('Active')).toBe('ok');
    expect(statusTone('Paused')).toBeNull();
    expect(statusTone('Stopped')).toBe('bad');
    expect(statusTone(undefined)).toBeNull();
  });
});
