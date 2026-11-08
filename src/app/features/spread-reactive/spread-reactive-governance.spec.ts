import { describe, expect, it } from 'vitest';

import { governedLabel, governedSummary, looseningChanges } from './spread-reactive-governance';
import { DEFAULT_SPREAD_REACTIVE_CONFIG as D } from './spread-reactive.types';

describe('spread-reactive governance', () => {
  it('flags raised bump sizes as loosening, and lowered ones not', () => {
    const draft = {
      ...D,
      cushionMultiplier: 4,
      maxBumpSpreadMultiple: 5,
      preEmptiveSpreadMultiple: 30,
    };
    expect(looseningChanges(D, draft).map((c) => c.field)).toEqual([
      'cushionMultiplier',
      'preEmptiveSpreadMultiple',
    ]);
  });

  it('treats the stop-distance cap as a cap: raising it or setting 0 (no cap) loosens', () => {
    expect(looseningChanges(D, { ...D, maxBumpSlDistanceFraction: 0.8 })).toHaveLength(1);
    expect(looseningChanges(D, { ...D, maxBumpSlDistanceFraction: 0 })).toHaveLength(1);
    expect(looseningChanges(D, { ...D, maxBumpSlDistanceFraction: 0.3 })).toHaveLength(0);
  });

  it('does not govern the min-bump threshold or anything else', () => {
    expect(
      looseningChanges(D, { ...D, minBumpSlDistanceFraction: 0.2, spreadMultiplier: 1.2 }),
    ).toEqual([]);
  });

  it('labels engine keys', () => {
    expect(governedLabel('SpreadReactive:PreEmptive:SpreadMultiple')).toBe('Pre-emptive bump size');
    expect(governedLabel('SpreadReactive:CushionMultiplier')).toBe('Cushion multiplier');
  });

  it('summarises held, break-glass and refused changes', () => {
    expect(
      governedSummary([
        {
          key: 'SpreadReactive:MaxBumpSpreadMultiple',
          to: '20',
          direction: 'Loosening',
          outcome: 'QueuedForCoolingOff',
          effectiveAt: '2026-11-09T19:00:00Z',
        },
      ]),
    ).toBe(
      'Max bump (× floor spread) is held for the cooling-off period until 2026-11-09 19:00 UTC — the current value stays in force until then.',
    );
    expect(
      governedSummary([
        {
          key: 'SpreadReactive:CushionMultiplier',
          to: '2',
          direction: 'Tightening',
          outcome: 'Applied',
        },
      ]),
    ).toBeNull();
  });
});
