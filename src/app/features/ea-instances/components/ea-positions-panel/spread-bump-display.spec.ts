import { describe, expect, it } from 'vitest';

import {
  spreadBumpDisplay,
  spreadBumpStatusOf,
  type SpreadBumpFields,
} from './spread-bump-display';

/** A short whose 1.09515 stop carries a 0.0006 bump (engine D120 status given unless a test drops it). */
function row(overrides: Partial<SpreadBumpFields> = {}): SpreadBumpFields {
  return {
    stopLoss: 1.09575,
    originalStopLoss: 1.09515,
    bumpedAt: '2026-09-24T20:00:00Z',
    bumpedSpread: 0.0006,
    bumpedSlSnapshot: 1.09575,
    bumpReason: 'SPREAD_SPIKE',
    spreadBumpStatus: 'InForce',
    spreadBumpOffset: 0.0006,
    ...overrides,
  };
}

describe('spreadBumpDisplay (engine D120)', () => {
  it('shows "bumped" only for a bump in force, with its offset and revert level', () => {
    const d = spreadBumpDisplay(row());
    expect(d).not.toBeNull();
    expect(d!.label).toBe('bumped');
    expect(d!.tone).toBe('active');
    expect(d!.title).toContain('SPREAD_SPIKE bump by 0.0006');
    expect(d!.title).toContain('reverts to 1.09515');
  });

  it('shows a group armed with no offset as a muted "bump armed", never as "bumped"', () => {
    // A long moved to break-even on its entry during a spike: the bump was carried down to nothing.
    const d = spreadBumpDisplay(
      row({
        stopLoss: 1.09,
        originalStopLoss: 1.09,
        bumpedSlSnapshot: 1.09,
        spreadBumpStatus: 'ArmedNoOffset',
        spreadBumpOffset: null,
      }),
    );
    expect(d).not.toBeNull();
    expect(d!.label).toBe('bump armed');
    expect(d!.tone).toBe('muted');
    expect(d!.title).toContain('not widened');
  });

  it('shows a drifted group as a muted "bump drifted"', () => {
    const d = spreadBumpDisplay(
      row({ stopLoss: 1.0952, spreadBumpStatus: 'Drifted', spreadBumpOffset: null }),
    );
    expect(d!.label).toBe('bump drifted');
    expect(d!.tone).toBe('muted');
  });

  it('shows nothing without a group', () => {
    expect(
      spreadBumpDisplay(
        row({
          originalStopLoss: null,
          bumpedAt: null,
          bumpedSpread: null,
          bumpedSlSnapshot: null,
          bumpReason: null,
          spreadBumpStatus: 'None',
          spreadBumpOffset: null,
        }),
      ),
    ).toBeNull();
  });

  it('derives the status from the raw fields when an older engine does not send it', () => {
    const legacy = (o: Partial<SpreadBumpFields>) =>
      row({ spreadBumpStatus: undefined, spreadBumpOffset: undefined, ...o });

    expect(spreadBumpStatusOf(legacy({}))).toBe('InForce');
    expect(spreadBumpDisplay(legacy({}))!.title).toContain('by 0.0006');
    expect(
      spreadBumpStatusOf(
        legacy({ stopLoss: 1.09, originalStopLoss: 1.09, bumpedSlSnapshot: 1.09 }),
      ),
    ).toBe('ArmedNoOffset');
    expect(spreadBumpStatusOf(legacy({ stopLoss: 1.0952 }))).toBe('Drifted');
    expect(spreadBumpStatusOf(legacy({ bumpedAt: null }))).toBe('None');
  });
});
