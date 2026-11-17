import { describe, expect, it } from 'vitest';
import { cancelWasHandedToEa, describeBatchCancel } from './cancel-outcome';

describe('cancelWasHandedToEa', () => {
  it('trusts the engine outcome', () => {
    expect(cancelWasHandedToEa('Cancelling', null)).toBe(true);
    expect(cancelWasHandedToEa('Cancelled', '123')).toBe(false);
  });
  it('falls back to the broker ticket on an older engine', () => {
    expect(cancelWasHandedToEa(null, '123')).toBe(true);
    expect(cancelWasHandedToEa(null, null)).toBe(false);
  });
});

describe('describeBatchCancel', () => {
  it('separates done, handed to the EA and failed', () => {
    const out = describeBatchCancel(
      {
        total: 3,
        cancelled: 1,
        cancelling: 1,
        failed: 1,
        results: [
          { id: 1, status: 'Cancelled', reason: null },
          { id: 2, status: 'Cancelling', reason: null },
          { id: 3, status: 'Failed', reason: 'x' },
        ],
      },
      new Set(),
    );
    expect(out.tone).toBe('warning');
    expect(out.text).toContain('1 cancelled');
    expect(out.text).toContain('1 sent to the EA');
    expect(out.text).toContain('1 failed');
  });
  it('uses broker tickets when the engine has no Cancelling count', () => {
    const out = describeBatchCancel(
      {
        total: 2,
        cancelled: 2,
        failed: 0,
        results: [
          { id: 1, status: 'Cancelled', reason: null },
          { id: 2, status: 'Cancelled', reason: null },
        ],
      },
      new Set([2]),
    );
    expect(out.text).toBe(
      '1 cancelled, 1 sent to the EA (still working at the broker until it confirms).',
    );
  });
  it('is a plain success when everything finished', () => {
    const out = describeBatchCancel(
      {
        total: 1,
        cancelled: 1,
        cancelling: 0,
        failed: 0,
        results: [{ id: 1, status: 'Cancelled', reason: null }],
      },
      new Set(),
    );
    expect(out).toEqual({ text: '1 cancelled.', tone: 'success' });
  });
});
