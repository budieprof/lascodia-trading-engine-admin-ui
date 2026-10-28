import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';
import type { BillingSubscription, PlanOffer } from './billing.types';
import {
  billingRefusal,
  canChangePlan,
  checkoutPollOutcome,
  checkoutReturn,
  isFollowableRedirect,
  limitPoints,
  offerAction,
  offerPrice,
  periodEndLabel,
  planLimits,
  planNotices,
  planPrice,
  showManageBilling,
  statusBadge,
} from './plan-offers.logic';

function offer(over: Partial<PlanOffer> = {}): PlanOffer {
  return {
    slug: 'pro',
    name: 'Pro',
    description: null,
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

function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    selfServeEnabled: true,
    currentPlan: { slug: 'trial', name: 'Trial' },
    status: 'none',
    cancelAtPeriodEnd: false,
    currentPeriodEndUtc: null,
    canManage: true,
    hasBillingAccount: false,
    offers: [{ ...TRIAL, isCurrent: true }, offer()],
    ...over,
  };
}

describe('plan prices', () => {
  it('reads free, whole and fractional prices with the interval', () => {
    expect(planPrice(0, null, null)).toBe('Free');
    expect(planPrice(0, 'usd', 'month')).toBe('Free');
    expect(planPrice(null, 'usd', 'month')).toBe('Free');
    expect(planPrice(49, 'usd', 'month')).toBe('$49 / month');
    expect(planPrice(490, 'usd', 'year')).toBe('$490 / year');
    expect(planPrice(19.5, 'usd', 'month')).toBe('$19.50 / month');
    expect(planPrice(1200, 'eur', null)).toBe('€1,200');
    expect(planPrice(49, 'gbp', 'month')).toBe('£49 / month');
  });

  it('never throws on an odd currency', () => {
    expect(planPrice(49, null, 'month')).toBe('49 / month');
    expect(planPrice(49, 'not-a-code', 'month')).toBe('49 NOT-A-CODE / month');
  });

  it('formats an offer and its limits (null = unlimited)', () => {
    expect(offerPrice(offer())).toBe('$49 / month');
    expect(planLimits(offer())).toEqual([
      { label: 'Trading accounts', value: '5' },
      { label: 'Connected terminals', value: '5' },
      { label: 'Members', value: '10' },
      { label: 'Strategies', value: 'Unlimited' },
    ]);
    expect(limitPoints(offer({ maxMembers: 1 }))).toEqual([
      'Up to 5 trading accounts',
      'Up to 5 connected terminals',
      'Up to 1 member',
      'Unlimited strategies',
    ]);
  });
});

describe('status', () => {
  it('badges each status', () => {
    expect(statusBadge('none')).toBeNull();
    expect(statusBadge('active')).toEqual({ label: 'Active', tone: 'ok' });
    expect(statusBadge('past_due')?.tone).toBe('warn');
    expect(statusBadge('unpaid')?.tone).toBe('bad');
  });

  it('warns about a failed payment and says when a cancelled plan ends', () => {
    expect(planNotices(sub({ status: 'past_due' }))).toEqual([
      { text: 'Your last payment failed — update your card.', tone: 'warn' },
    ]);
    expect(
      planNotices(
        sub({
          status: 'active',
          cancelAtPeriodEnd: true,
          currentPeriodEndUtc: '2026-11-28T00:00:00Z',
        }),
      ),
    ).toEqual([{ text: 'Ends on 28 November 2026.', tone: 'info' }]);
    expect(planNotices(sub({ cancelAtPeriodEnd: true }))[0].text).toBe(
      'Ends at the end of this billing period.',
    );
    expect(periodEndLabel('garbage')).toBeNull();
    expect(planNotices(sub())).toEqual([]);
  });
});

describe('which button a plan card shows', () => {
  it('Upgrade (checkout) without a subscription; nothing on the current or free plan', () => {
    const s = sub();
    expect(offerAction(offer(), s, true)).toEqual({ kind: 'checkout', label: 'Upgrade' });
    expect(offerAction(s.offers[0], s, true)).toBeNull();
    expect(offerAction(offer({ slug: 'free2', priceAmount: 0 }), s, true)).toBeNull();
  });

  it('a canceled or incomplete subscription checks out again', () => {
    for (const status of ['canceled', 'incomplete', 'unpaid'] as const)
      expect(offerAction(offer(), sub({ status }), true)?.kind).toBe('checkout');
  });

  it('Switch (portal) while a subscription is live', () => {
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      const s = sub({ status, currentPlan: { slug: 'pro', name: 'Pro' } });
      expect(offerAction(offer({ slug: 'desk', name: 'Desk' }), s, true)).toEqual({
        kind: 'portal',
        label: 'Switch',
      });
      // The current plan, matched by slug even when isCurrent is missing.
      expect(offerAction(offer(), s, true)).toBeNull();
    }
  });

  it('no buttons without the key, the engine’s canManage, or self-serve', () => {
    expect(offerAction(offer(), sub(), false)).toBeNull();
    expect(offerAction(offer(), sub({ canManage: false }), true)).toBeNull();
    expect(offerAction(offer(), sub({ selfServeEnabled: false }), true)).toBeNull();
    expect(canChangePlan(sub(), true)).toBe(true);
    expect(canChangePlan(sub({ canManage: false }), true)).toBe(false);
  });

  it('Manage billing needs a billing account as well', () => {
    expect(showManageBilling(sub(), true)).toBe(false);
    expect(showManageBilling(sub({ hasBillingAccount: true }), true)).toBe(true);
    expect(showManageBilling(sub({ hasBillingAccount: true }), false)).toBe(false);
    expect(showManageBilling(sub({ hasBillingAccount: true, selfServeEnabled: false }), true)).toBe(
      false,
    );
  });
});

describe('coming back from checkout', () => {
  it('reads the query value', () => {
    expect(checkoutReturn('success')).toBe('success');
    expect(checkoutReturn('cancelled')).toBe('cancelled');
    expect(checkoutReturn('other')).toBeNull();
    expect(checkoutReturn(null)).toBeNull();
  });

  it('waits until the plan changes or a subscription is live, up to 30 s', () => {
    const before = sub();
    expect(checkoutPollOutcome('trial', before, 0)).toBe('waiting');
    expect(checkoutPollOutcome('trial', before, 28_000)).toBe('waiting');
    expect(checkoutPollOutcome('trial', before, 30_000)).toBe('timeout');
    expect(checkoutPollOutcome('trial', null, 30_000)).toBe('timeout');
    expect(checkoutPollOutcome('trial', null, 2_000)).toBe('waiting');
    expect(
      checkoutPollOutcome('trial', sub({ currentPlan: { slug: 'pro', name: 'Pro' } }), 4_000),
    ).toBe('done');
    // The same plan bought again after a cancellation: done once the subscription is live.
    expect(
      checkoutPollOutcome(
        'pro',
        sub({ currentPlan: { slug: 'pro', name: 'Pro' }, status: 'active' }),
        2_000,
      ),
    ).toBe('done');
    // Already live on the first read (the webhook beat the page).
    expect(checkoutPollOutcome(null, sub({ status: 'trialing' }), 0)).toBe('done');
  });
});

describe('redirects and refusals', () => {
  it('follows https, same-origin paths and local http only', () => {
    expect(isFollowableRedirect('https://checkout.stripe.com/c/pay/cs_test_1')).toBe(true);
    expect(isFollowableRedirect('/organisation/billing?checkout=success')).toBe(true);
    expect(isFollowableRedirect('http://localhost:5081/test-checkout')).toBe(true);
    expect(isFollowableRedirect('http://evil.example.com/')).toBe(false);
    expect(isFollowableRedirect('//evil.example.com/')).toBe(false);
    expect(isFollowableRedirect('javascript:alert(1)')).toBe(false);
    expect(isFollowableRedirect('')).toBe(false);
    expect(isFollowableRedirect(null)).toBe(false);
  });

  it('prefers the engine’s sentence, with plain fallbacks per code', () => {
    const own = new ApiError('-11', 'Already subscribed — use Manage billing.', {} as never);
    expect(billingRefusal(own, 'x')).toBe('Already subscribed — use Manage billing.');
    const bare11 = new ApiError('-11', 'Request failed', {} as never);
    expect(billingRefusal(bare11, 'x')).toMatch(/already has a subscription/);
    const bare14 = new ApiError('-14', '', {} as never);
    expect(billingRefusal(bare14, 'x')).toMatch(/could not be found/);
    expect(billingRefusal({ status: 0, message: 'Http failure response' }, 'Could not open.')).toBe(
      'Could not open.',
    );
  });
});
