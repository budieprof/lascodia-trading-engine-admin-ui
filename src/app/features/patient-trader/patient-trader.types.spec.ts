import { describe, expect, it } from 'vitest';

import { PatientTraderPlan, planOcoChipPartners } from './patient-trader.types';

describe('planOcoChipPartners', () => {
  const plan = (partners: PatientTraderPlan['ocoPartners']) =>
    ({ id: 9, ocoGroupId: 'oco-aa', ocoPartners: partners }) as PatientTraderPlan;

  it('names a partner by its card number, falling back to the plan number', () => {
    const chips = planOcoChipPartners(
      plan([
        { id: 4, direction: 'Buy', status: 'Armed', recommendationId: 380, entryMonitorId: 1702 },
        { id: 5, direction: 'None', status: 'Armed', recommendationId: null, entryMonitorId: null },
      ]),
    );
    expect(chips.map((c) => c.id)).toEqual([380, 5]);
    expect(chips[0].label).toBe('Buy · Armed · plan 4');
    expect(chips[1].label).toBe('Armed · plan 5');
  });

  it('strikes through legs that can no longer file', () => {
    const chips = planOcoChipPartners(
      plan([
        {
          id: 4,
          direction: 'Sell',
          status: 'Withdrawn',
          recommendationId: 1,
          entryMonitorId: null,
        },
        { id: 5, direction: 'Sell', status: 'Declined', recommendationId: 2, entryMonitorId: null },
        { id: 6, direction: 'Sell', status: 'Settled', recommendationId: 3, entryMonitorId: null },
      ]),
    );
    expect(chips.map((c) => c.ended)).toEqual([true, true, false]);
  });

  it('is empty for a plan the engine sent no partners for', () => {
    expect(planOcoChipPartners(plan(undefined))).toEqual([]);
  });
});
