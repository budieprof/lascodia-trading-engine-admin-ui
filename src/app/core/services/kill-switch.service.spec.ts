import { describe, it, expect } from 'vitest';

import { normaliseKillSwitch } from './kill-switch.service';

describe('normaliseKillSwitch', () => {
  it('turns the engine’s bare boolean into a status (true = engaged)', () => {
    expect(normaliseKillSwitch(true)).toEqual({
      enabled: true,
      reason: null,
      changedAt: null,
      changedBy: null,
    });
  });

  it('keeps a disengaged switch (false is a value, not "no data")', () => {
    expect(normaliseKillSwitch(false)?.enabled).toBe(false);
  });

  it('passes a full status object through', () => {
    const dto = {
      enabled: true,
      reason: 'drill',
      changedAt: '2026-10-19T00:00:00Z',
      changedBy: 'op',
    };
    expect(normaliseKillSwitch(dto)).toBe(dto);
  });

  it('rejects anything else', () => {
    expect(normaliseKillSwitch(null)).toBeNull();
    expect(normaliseKillSwitch({})).toBeNull();
    expect(normaliseKillSwitch('true')).toBeNull();
  });
});
