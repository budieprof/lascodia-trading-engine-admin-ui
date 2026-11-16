import { describe, it, expect } from 'vitest';

import { normalisePaperStatus } from './paper-trading.service';

describe('normalisePaperStatus', () => {
  it('turns the engine’s bare boolean into a status (true = paper mode)', () => {
    expect(normalisePaperStatus(true)).toEqual({ isPaperMode: true });
  });

  it('keeps live mode (false is a value, not "no data")', () => {
    expect(normalisePaperStatus(false)).toEqual({ isPaperMode: false });
  });

  it('passes a full status object through', () => {
    const dto = { isPaperMode: true, reason: 'drill', changedAt: '2026-11-16T00:00:00Z' };
    expect(normalisePaperStatus(dto)).toBe(dto);
  });

  it('rejects anything else', () => {
    expect(normalisePaperStatus(null)).toBeNull();
    expect(normalisePaperStatus(undefined)).toBeNull();
    expect(normalisePaperStatus({} as never)).toBeNull();
  });
});
