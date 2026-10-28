import { describe, expect, it } from 'vitest';

import type { PlanOffer } from '@features/billing/billing.types';
import { PLANS } from './landing.content';
import { mergePlanOffers } from './landing.logic';

function offer(over: Partial<PlanOffer> = {}): PlanOffer {
  return {
    slug: 'team',
    name: 'Team',
    description: 'For desks.',
    priceAmount: 49,
    currency: 'usd',
    interval: 'month',
    maxTradingAccounts: 5,
    maxActiveEaInstances: 5,
    maxMembers: 10,
    maxStrategies: null,
    isDefault: false,
    isCurrent: false,
    ...over,
  };
}

const TRIAL = offer({
  slug: 'trial',
  name: 'Trial',
  priceAmount: 0,
  currency: null,
  interval: null,
  isDefault: true,
});

describe('landing plan cards with the engine’s offers', () => {
  it('no answer, no offers or only the free plan: exactly the static cards', () => {
    expect(mergePlanOffers(PLANS, null)).toBe(PLANS);
    expect(mergePlanOffers(PLANS, [])).toBe(PLANS);
    expect(mergePlanOffers(PLANS, [TRIAL])).toBe(PLANS);
  });

  it('a paid offer with a card’s slug fills that card; Trial and Enterprise stay', () => {
    const out = mergePlanOffers(PLANS, [TRIAL, offer()]);
    expect(out.map((p) => p.slug)).toEqual(['trial', 'team', 'enterprise']);
    expect(out[0]).toBe(PLANS[0]);
    expect(out[0].price).toBe('Free');
    expect(out[1]).toMatchObject({ price: '$49', priceNote: 'per month', cta: 'upgrade' });
    expect(out[1].featured).toBe(true);
    expect(out[1].points).toEqual(PLANS[1].points);
    expect(out[2]).toBe(PLANS[2]);
    expect(out[2].cta).toBe('contact');
  });

  it('a paid Enterprise offer never replaces "Talk to us"', () => {
    const out = mergePlanOffers(PLANS, [offer({ slug: 'enterprise', name: 'Enterprise' })]);
    expect(out).toEqual(PLANS);
  });

  it('paid offers without a card get their own, before Enterprise', () => {
    const out = mergePlanOffers(PLANS, [
      TRIAL,
      offer({ slug: 'pro', name: 'Pro', priceAmount: 490, interval: 'year' }),
    ]);
    expect(out.map((p) => p.slug)).toEqual(['trial', 'team', 'pro', 'enterprise']);
    expect(out[1]).toBe(PLANS[1]); // Team keeps "Tailored" — no invented price
    expect(out[2]).toMatchObject({
      name: 'Pro',
      price: '$490',
      priceNote: 'per year',
      blurb: 'For desks.',
      cta: 'upgrade',
    });
    expect(out[2].points[0]).toBe('Up to 5 trading accounts');
  });

  it('ignores malformed offers', () => {
    const bad = [{ slug: 'x', name: '', priceAmount: 10 } as PlanOffer, null as never];
    expect(mergePlanOffers(PLANS, bad)).toBe(PLANS);
  });
});
